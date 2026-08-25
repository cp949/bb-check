import type { KnownUnsupportedSignal, ReadyCondition } from "./config.js";
import { LegacyBrowserSmokeError } from "./errors.js";
import type { PageSignal } from "./resources.js";
import { normalizeSignalText } from "./signal.js";

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
 * `ReadyCondition`을 CDP `Runtime.evaluate`에 넘길 JS 식 문자열로 컴파일한다.
 */
export const readyExpression = (ready: ReadyCondition): string =>
  ready.kind === "selector"
    ? `document.querySelector(${JSON.stringify(ready.selector)}) !== null`
    : ready.expression;

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
    const key = `${declaration.kind} ${declaration.pattern}`;
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
    compareKey(`${a.kind} ${a.pattern}`, `${b.kind} ${b.pattern}`),
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
