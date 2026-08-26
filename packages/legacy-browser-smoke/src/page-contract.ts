import type { KnownUnsupportedSignal, ReadyCondition } from "./config.js";
import { LegacyBrowserSmokeError } from "./errors.js";
import type { PageSignal } from "./resources.js";
import { normalizeSignalText, scriptParsePatternText } from "./signal.js";

/**
 * 순수 판정 모듈. CDP 호출이나 I/O 없이 origin 검증, ready 조건 컴파일,
 * `Runtime.evaluate` 결과 해석, known-unsupported multiset 매칭만 담당한다.
 */

// WHATWG URL의 host serializer는 IPv6 host를 대괄호로 감싼 채 `hostname`에
// 반영한다 (`"[::1]"`이지 `"::1"`이 아니다) — 실측으로 확인한 실제 동작이다.
const loopbackHostnames = new Set(["127.0.0.1", "localhost", "[::1]"]);

const originNotLoopback = (cause?: unknown): never => {
  throw new LegacyBrowserSmokeError(
    "LBS_ORIGIN_NOT_LOOPBACK",
    "origin must be a loopback http URL with no path, query, hash, or userinfo",
    cause === undefined ? undefined : { cause },
  );
};

/**
 * `origin`이 loopback(127.0.0.1/localhost/::1) 위의 순수 http origin인지 검증하고,
 * 정규화된 origin 문자열(trailing slash 없음)을 돌려준다. port는 어떤 값이든 허용한다.
 */
export const validateLoopbackOrigin = (origin: string): string => {
  let url: URL;
  try {
    url = new URL(origin);
  } catch (error) {
    return originNotLoopback(error);
  }
  if (
    url.protocol !== "http:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    !loopbackHostnames.has(url.hostname)
  ) {
    return originNotLoopback();
  }
  return `${url.protocol}//${url.host}`;
};

/**
 * ready 조건을 "이미 navigate가 커밋된 문서에서만 참"이 되도록 감싼다.
 *
 * 모든 page session은 `/json/new?about:blank`로 만든 살아 있는 about:blank
 * 문서에서 시작하고, CDP `Page.navigate`는 navigation의 "시작"만 알린다. 이
 * gate가 없으면 `document.readyState === "complete"`나 `body` selector처럼
 * about:blank에서도 참인 조건이 첫 poll에서 즉시 충족되어, 대상 page를 한 번도
 * 보지 않은 채 pass가 나올 수 있다.
 *
 * gate는 식이 아니라 **program**으로 만든다. `Runtime.evaluate`는 소스를
 * program으로 실행하고 completion value를 돌려주므로, gate 이전의
 * `ReadyCondition.expression`은 세미콜론으로 끝나는 식이나 `var` 선언이 섞인
 * 여러 statement도 유효한 입력이었다. `return (...)` 같은 식 자리에 끼워 넣으면
 * 그런 공개 입력이 영구 `SyntaxError`가 되어 ready가 영원히 false가 된다.
 * `if`/`else` 블록은 그 completion value 전파를 그대로 유지한다.
 *
 * Chromium 75(V8 7.5)에서 그대로 실행되어야 하므로 ES5 구문만 쓴다. 닫는
 * 중괄호 앞의 개행은 사용자 식이 줄 주석으로 끝나도 gate가 깨지지 않게 한다.
 */
const guardedByNavigation = (expression: string): string =>
  `if (location.href === "about:blank") { false } else { ${expression}\n}`;

/**
 * `ReadyCondition`을 CDP `Runtime.evaluate`에 넘길 JS 식 문자열로 컴파일한다.
 * 결과는 항상 navigation gate로 감싸여 있어, navigate 이전 about:blank 문서에서는
 * 사용자 조건이 참이어도 ready가 되지 않는다.
 */
export const readyExpression = (ready: ReadyCondition): string =>
  guardedByNavigation(
    ready.kind === "selector"
      ? `document.querySelector(${JSON.stringify(ready.selector)}) !== null`
      : ready.expression,
  );

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * 원본 CDP `Runtime.evaluate` 응답 하나를 ready 여부로 해석한다. 형식이 어긋나도
 * 절대 throw하지 않는다 — 매 poll tick마다 호출되므로 이상 형태는 "아직 준비 안 됨"으로
 * 취급한다.
 */
export const isReadyResult = (evaluateResult: unknown): boolean => {
  try {
    if (!isRecord(evaluateResult)) return false;
    if (evaluateResult.exceptionDetails !== undefined) return false;
    const result = evaluateResult.result;
    if (!isRecord(result)) return false;
    if (!("value" in result)) return false;
    return Boolean(result.value);
  } catch {
    return false;
  }
};

/**
 * 원본 CDP `Page.navigate` 응답 하나를 navigation 실패 여부로 해석한다.
 * CDP는 `net::ERR_CONNECTION_REFUSED` 같은 실패를 protocol error가 아니라
 * 결과의 `errorText`로 돌려주므로 이 필드를 읽지 않으면 실패한 navigation이
 * 성공처럼 보인다. 형식이 어긋나도 절대 throw하지 않고, 실패로 단정할 수 있는
 * 경우에만 정리된 errorText를 돌려준다.
 */
export const navigateErrorText = (
  navigateResult: unknown,
): string | undefined => {
  try {
    if (!isRecord(navigateResult)) return undefined;
    const errorText = navigateResult.errorText;
    if (typeof errorText !== "string") return undefined;
    const trimmed = errorText.trim();
    return trimmed === "" ? undefined : trimmed;
  } catch {
    return undefined;
  }
};

/** 선언 하나를 수집 신호의 텍스트 축과 같은 pattern으로 투영한다. */
export const declarationPattern = (
  declaration: KnownUnsupportedSignal,
): string =>
  declaration.kind === "script-parse"
    ? scriptParsePatternText(
        declaration.sourcePath,
        declaration.lineNumber,
        declaration.columnNumber,
      )
    : declaration.pattern;

const scriptParsePosition = (value: unknown): number | "?" =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : "?";

const scriptParseSourceText = (
  url: unknown,
  canonicalOrigin: string,
): string => {
  if (typeof url !== "string" || url === "") return "unknown";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "unknown";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return parsed.protocol;
  }
  return parsed.origin === canonicalOrigin
    ? parsed.pathname
    : `${parsed.origin}${parsed.pathname}`;
};

/**
 * `Debugger.scriptFailedToParse` event 하나를 script-parse 신호 텍스트로
 * 렌더링한다. 대상 origin 위 URL만 `/` 시작 pathname이 되어 선언과 매칭될 수
 * 있고, 그 외(타 origin, 기타 스킴, 해석 불가, 비정상 위치)는 선언 sourcePath
 * 규칙과 충돌할 수 없는 텍스트로 남아 항상 unexpected가 된다(fail-closed).
 * 절대 throw하지 않는다.
 */
export const scriptParseSignalText = (
  params: object,
  canonicalOrigin: string,
): string => {
  const record = isRecord(params) ? params : {};
  return scriptParsePatternText(
    scriptParseSourceText(record.url, canonicalOrigin),
    scriptParsePosition(record.startLine),
    scriptParsePosition(record.startColumn),
  );
};

/**
 * `Page.getNavigationHistory` 응답에서 current entry의 최종 경로를 읽는다.
 * 대상 origin 위의 URL이면 pathname을, 그 외·형식 이상은 null을 돌려준다.
 * 절대 throw하지 않는다.
 */
export const finalPathFrom = (
  historyResult: unknown,
  canonicalOrigin: string,
): string | null => {
  try {
    if (!isRecord(historyResult)) return null;
    const entries = historyResult.entries;
    const currentIndex = historyResult.currentIndex;
    if (!Array.isArray(entries) || typeof currentIndex !== "number") {
      return null;
    }
    const entry: unknown = entries[currentIndex];
    if (!isRecord(entry) || typeof entry.url !== "string") return null;
    const parsed = new URL(entry.url);
    return parsed.origin === canonicalOrigin ? parsed.pathname : null;
  } catch {
    return null;
  }
};

/** `expectedPath` 불일치 신호의 텍스트. */
export const pathMismatchText = (
  expectedPath: string,
  finalPath: string | null,
): string => `expected=${expectedPath}; final=${finalPath ?? "null"}`;

export interface KnownUnsupportedMatch {
  readonly unexpectedSignals: readonly PageSignal[];
  readonly missingKnownUnsupported: readonly KnownUnsupportedSignal[];
}

const compareKey = (a: string, b: string): number => {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
};

/**
 * 수집된 signal과 known-unsupported 선언을 exact multiset으로 매칭한다.
 * 선언마다 `count`만큼 앞에서부터 소비하고, 부족분과 초과분을 각각
 * `missingKnownUnsupported`/`unexpectedSignals`로 안정적으로 정렬해 돌려준다.
 */
export const matchKnownUnsupported = (
  signals: readonly PageSignal[],
  declarations: readonly KnownUnsupportedSignal[],
): KnownUnsupportedMatch => {
  const buckets = new Map<string, PageSignal[]>();
  for (const rawSignal of signals) {
    const text = normalizeSignalText(rawSignal.text);
    const key = `${rawSignal.kind} ${text}`;
    const bucket = buckets.get(key);
    const normalized: PageSignal = { kind: rawSignal.kind, text };
    if (bucket === undefined) {
      buckets.set(key, [normalized]);
    } else {
      bucket.push(normalized);
    }
  }

  const missingKnownUnsupported: KnownUnsupportedSignal[] = [];
  for (const declaration of declarations) {
    const key = `${declaration.kind} ${declarationPattern(declaration)}`;
    const bucket = buckets.get(key) ?? [];
    const matched = Math.min(declaration.count, bucket.length);
    bucket.splice(0, matched);
    if (matched < declaration.count) {
      missingKnownUnsupported.push({
        ...declaration,
        count: declaration.count - matched,
      });
    }
  }

  const unexpectedSignals: PageSignal[] = [];
  for (const bucket of buckets.values()) {
    unexpectedSignals.push(...bucket);
  }

  unexpectedSignals.sort((a, b) =>
    compareKey(`${a.kind} ${a.text}`, `${b.kind} ${b.text}`),
  );
  missingKnownUnsupported.sort((a, b) =>
    compareKey(
      `${a.kind} ${declarationPattern(a)}`,
      `${b.kind} ${declarationPattern(b)}`,
    ),
  );

  return Object.freeze({
    unexpectedSignals: Object.freeze(
      unexpectedSignals.map((item) => Object.freeze({ ...item })),
    ),
    missingKnownUnsupported: Object.freeze(
      missingKnownUnsupported.map((item) => Object.freeze({ ...item })),
    ),
  });
};
