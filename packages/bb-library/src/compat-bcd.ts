// @mdn/browser-compat-data(BCD)에서 런타임 JS API 판정 색인을 파생한다.
//
// 이 모듈이 검사 대상을 정의하는 유일한 곳이다 — 손으로 고른 API 목록이
// 아니라 BCD 전체를 baseline 기준으로 걸러 만든 색인이다. baseline을
// 올리면 대상이 저절로 줄어든다.

import { createRequire } from "node:module";
import type { BrowserBaseline } from "@cp949/bb-core";
import type {
  CompatData,
  Identifier as BcdNode,
} from "@mdn/browser-compat-data";

// ---------------------------------------------------------------------------
// BCD 로딩
//
// @mdn/browser-compat-data의 ESM 진입점은 data.json을 가리키므로 정적
// import는 `with { type: "json" }`이 필요하고, 그 경우 이 모듈을 import하는
// 순간 20MB 넘는 JSON 전체가 파싱된다(buildCompatIndex를 한 번도 안 불러도).
// createRequire로 지연 로드하고 프로세스당 한 번만 읽도록 memoize한다 —
// require()는 .json을 별다른 attribute 없이 바로 읽는다.
// ---------------------------------------------------------------------------

const bcdRequire = createRequire(import.meta.url);
let cachedBcd: CompatData | undefined;

const loadBcd = (): CompatData => {
  cachedBcd ??= bcdRequire("@mdn/browser-compat-data") as CompatData;
  return cachedBcd;
};

// ---------------------------------------------------------------------------
// support statement 정규화
// ---------------------------------------------------------------------------

/**
 * BCD support statement 하나(alternative 배열의 원소)의 최소 형태.
 *
 * `@mdn/browser-compat-data`의 공식 타입(`VersionValue = string | false`)은
 * `version_added: true`를 포함하지 않지만, BCD 스키마 자체는 과거 버전
 * 호환을 위해 이 값을 여전히 허용한다("지원되지만 정확한 버전 미상"이라는
 * 뜻) — 그래서 이 모듈은 공식 타입 대신 이 permissive한 로컬 타입을 쓴다.
 */
export interface CompatSupportStatementLike {
  readonly version_added?: string | boolean | null;
  readonly version_removed?: string | boolean | null;
  readonly flags?: readonly unknown[];
  readonly prefix?: string;
  readonly alternative_name?: string;
}

/** BCD support statement 하나의 실제 형태: 단일 object이거나 alternative 배열. */
export type CompatSupportInput =
  | CompatSupportStatementLike
  | readonly CompatSupportStatementLike[]
  | null
  | undefined;

/** flags/prefix/alternative_name 중 하나라도 있으면 "표준 형태의 기본 지원"으로 세지 않는다. */
const isNonStandardVariant = (entry: CompatSupportStatementLike): boolean =>
  (Array.isArray(entry.flags) && entry.flags.length > 0) ||
  (typeof entry.prefix === "string" && entry.prefix.length > 0) ||
  (typeof entry.alternative_name === "string" &&
    entry.alternative_name.length > 0);

/** version_removed가 "제거 이력 있음"을 뜻하는 값인지. false는 명시적으로 "제거되지 않음"이다. */
const hasKnownRemoval = (entry: CompatSupportStatementLike): boolean => {
  const removed = entry.version_removed;
  return removed !== undefined && removed !== null && removed !== false;
};

interface ParsedVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

/** "80", "16.4", "1.13.0" 같은 dotted 버전 문자열을 파싱한다. 숫자로 시작하지 않으면 undefined. */
const parseVersionToken = (raw: string): ParsedVersion | undefined => {
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(raw);
  if (!match?.[1]) return undefined;
  return {
    major: Number(match[1]),
    minor: match[2] === undefined ? 0 : Number(match[2]),
    patch: match[3] === undefined ? 0 : Number(match[3]),
  };
};

const compareVersions = (a: ParsedVersion, b: ParsedVersion): number => {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
};

/** "≤80" / "<=80" 형태에서 상한 버전을 뽑는다. BCD가 "이 버전 이전 어딘가"를 표현하는 관용구다. */
const AT_MOST_PATTERN = /^(?:≤|<=)\s*(.+)$/;

/**
 * version_added 문자열을 비교 가능한 형태로 정규화한다. "≤80"은 80으로
 * 취급한다 — 실제 도입이 더 일렀을 수도 있지만, 모르는 채로 넘기는 대신
 * 과소보고보다 과대보고 쪽으로 기운다(게이트 성격상 안전한 방향).
 * 파싱할 수 없는 문자열은 undefined(판정 보류).
 */
const resolveVersionToken = (raw: string): string | undefined => {
  const trimmed = raw.trim();
  const atMost = AT_MOST_PATTERN.exec(trimmed);
  const candidate = atMost?.[1] ?? trimmed;
  return parseVersionToken(candidate) === undefined ? undefined : candidate;
};

type SupportState =
  | { readonly kind: "unknown" }
  | { readonly kind: "never" }
  | {
      readonly kind: "supported";
      readonly addedVersion: string | null;
      readonly removed: boolean;
    };

/**
 * support statement(단일 또는 alternative 배열)를 "지금 이 순간의 지원
 * 상태" 하나로 접는다.
 *
 * alternative 배열은 여러 지원 이력을 나열한 것이다. 이 중 아직 제거되지
 * 않은(version_removed가 없는) 항목이 있으면 그게 "현재" 상태다 — 배열
 * 안에서 몇 번째 위치인지는 상관없다(BCD의 실제 데이터는 최신을 앞에
 * 두지만, 이 함수는 위치가 아니라 "제거되지 않았다"는 사실로 판단하므로
 * 순서 관례가 바뀌어도 흔들리지 않는다). 후보가 여럿이면 배열의 뒤쪽
 * 항목을 우선한다. 전부 제거된 이력뿐이면(현재 지원 없음) removed:true로
 * 표시한다.
 */
function resolveSupportState(statement: CompatSupportInput): SupportState {
  if (statement === null || statement === undefined) return { kind: "unknown" };
  const entries = Array.isArray(statement) ? statement : [statement];
  if (entries.length === 0) return { kind: "unknown" };

  // 플래그·접두사·다른 이름 뒤에서만 존재하는 항목은 "표준 형태의 기본
  // 지원"이 아니므로 걸러낸다. 전부 걸러지면 표준 형태로는 전혀
  // 지원되지 않는다는 뜻이다.
  const plain = entries.filter((entry) => !isNonStandardVariant(entry));
  if (plain.length === 0) return { kind: "never" };

  const withoutRemoval = plain.filter((entry) => !hasKnownRemoval(entry));
  const removed = withoutRemoval.length === 0;
  const pool = removed ? plain : withoutRemoval;
  const chosen = pool[pool.length - 1] ?? pool[0];
  if (chosen === undefined) return { kind: "unknown" };

  const added = chosen.version_added;
  if (added === false) return { kind: "never" };
  if (added === true) {
    // 지원되지만 정확한 버전 미상이다. 모르는 값을 지어내는 대신
    // "항상 안전"으로 취급한다(오탐보다 미탐 쪽으로 기우는 유일한
    // 지점 — 데이터가 아예 없으면 위반을 만들어낼 근거가 없다).
    return { kind: "supported", addedVersion: null, removed };
  }
  if (typeof added !== "string") return { kind: "unknown" };

  const normalized = resolveVersionToken(added);
  if (normalized === undefined) return { kind: "unknown" };

  return { kind: "supported", addedVersion: normalized, removed };
}

/**
 * BCD support statement 하나를 "도입 버전 문자열"로 정규화한다.
 *
 * `version_added: true`(도입은 됐지만 버전 미상)와 `version_added: false`
 * (도입된 적 없음)는 둘 다 null이다 — 이 함수만 보면 두 상태를 구분할
 * 근거가 없고, 실제 색인 판정(buildCompatIndex)은 이 함수를 거치지 않는
 * 내부 로직에서 둘을 구분해 다르게 다룬다.
 *
 * alternative 배열이면 아직 제거되지 않은 항목의 도입 버전을 우선한다
 * (resolveSupportState 참고).
 */
export function normalizeBrowserSupport(
  statement: CompatSupportInput,
): string | null {
  const state = resolveSupportState(statement);
  return state.kind === "supported" ? state.addedVersion : null;
}

// ---------------------------------------------------------------------------
// baseline 대비 판정
// ---------------------------------------------------------------------------

export type CompatIssueReason = "not-yet-added" | "never-added" | "removed";

/** 색인 후보 하나가 baseline의 특정 브라우저에서 왜/어떻게 문제인지. */
export interface CompatIssue {
  readonly browser: string;
  /** baseline이 요구하는 그 브라우저의 최소 버전. */
  readonly baselineVersion: string;
  readonly reason: CompatIssueReason;
  /** reason이 "not-yet-added"일 때 실제 도입 버전. 그 외에는 null. */
  readonly requiredVersion: string | null;
}

/** BCD support statement가 undefined 없이 name으로 인덱싱 가능하다고 가정하는 최소 형태. */
type SupportBlockLike = Readonly<Record<string, CompatSupportInput>>;

/**
 * BCD의 support object를 baseline과 비교해 문제 있는 브라우저 목록을
 * 만든다. baseline에 있지만 BCD가 이 API에 대해 아예 추적하지 않는
 * 브라우저는 조용히 건너뛴다(판정 근거가 없으므로 보류) — 이는 baseline
 * 브라우저 이름이 BCD의 브라우저 이름(chrome, firefox, safari 등)과
 * 그대로 일치한다고 가정한다는 뜻이기도 하다. browserslist가 만드는
 * 이름 중 일부(and_chr, ios_saf 등 모바일 변형)는 BCD 이름과 다르며, 이
 * 모듈은 그 변환을 하지 않는다 — 알려진 한계로 남겨둔다(주석 하단 참고).
 */
function evaluateAgainstBaseline(
  support: SupportBlockLike | undefined,
  baseline: BrowserBaseline,
): CompatIssue[] {
  if (support === undefined) return [];

  const issues: CompatIssue[] = [];
  for (const [browser, baselineVersion] of Object.entries(baseline)) {
    if (!Object.hasOwn(support, browser)) continue;

    const state = resolveSupportState(support[browser]);
    if (state.kind === "unknown") continue;

    if (state.kind === "never") {
      issues.push({
        browser,
        baselineVersion,
        reason: "never-added",
        requiredVersion: null,
      });
      continue;
    }

    if (state.removed) {
      issues.push({
        browser,
        baselineVersion,
        reason: "removed",
        requiredVersion: null,
      });
      continue;
    }
    if (state.addedVersion === null) continue; // 지원되지만 버전 미상 -> 항상 안전 쪽으로 판단(위 주석 참고)

    const addedParsed = parseVersionToken(state.addedVersion);
    const baselineParsed = parseVersionToken(baselineVersion);
    if (addedParsed === undefined || baselineParsed === undefined) continue; // 비교 불가 -> 판정 보류

    if (compareVersions(addedParsed, baselineParsed) > 0) {
      issues.push({
        browser,
        baselineVersion,
        reason: "not-yet-added",
        requiredVersion: state.addedVersion,
      });
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// 색인 자료 구조
// ---------------------------------------------------------------------------

/** 색인에 오른 API 후보 하나. issues는 항상 비어 있지 않다(비어 있으면 애초에 색인에 없다). */
export interface CompatCandidate {
  /** 진단용 BCD 경로(들). tier 2 이름이 여러 소유 타입에서 병합되면 길이가 2 이상일 수 있다. */
  readonly bcdPaths: readonly string[];
  readonly issues: readonly CompatIssue[];
}

export interface CompatIndex {
  /** 맨몸 전역 식별자 이름 -> candidate. */
  readonly globals: ReadonlyMap<string, CompatCandidate>;
  /** "Owner.member" -> candidate. Owner는 BCD 인터페이스/빌트인 이름(전역 식별자와 같은 이름)이다. */
  readonly staticMembers: ReadonlyMap<string, CompatCandidate>;
  /** 맨 member 이름 -> candidate. 수신자 타입이 불명일 때(tier 2)만 쓴다. */
  readonly instanceMembers: ReadonlyMap<string, CompatCandidate>;
  /**
   * 고정 전역 변수 이름 -> BCD 인터페이스 이름.
   *
   * BCD는 `crypto`/`navigator`/`document` 같은 소문자 전역 변수 이름을
   * 별도로 추적하지 않는다 — 오직 대문자 인터페이스 이름(Crypto,
   * Navigator, Document)의 멤버로만 존재한다. 그래서 이 변환 없이는
   * `crypto.randomUUID()` 같은, 실제로 매우 흔한 코드를 staticMembers에서
   * 찾을 수 없다. 목록은 DOM의 잘 알려진 싱글턴 전역으로 한정한, BCD
   * 스키마 자체의 구조적 한계를 메우는 최소한의 표다.
   */
  readonly knownGlobalTypes: ReadonlyMap<string, string>;
  /** tier 3(옵션 서브피처) 후보. 이름은 이 모듈이 고정으로 아는 것들뿐이다. */
  readonly optionFeatures: ReadonlyMap<string, CompatCandidate>;
}

const KNOWN_GLOBAL_TYPES: ReadonlyMap<string, string> = new Map([
  ["caches", "CacheStorage"],
  ["crypto", "Crypto"],
  ["document", "Document"],
  ["history", "History"],
  ["localStorage", "Storage"],
  ["location", "Location"],
  ["navigator", "Navigator"],
  ["performance", "Performance"],
  ["sessionStorage", "Storage"],
  ["window", "Window"],
]);

/** api.EventTarget.addEventListener의 options 인자 안 signal 서브피처, javascript.builtins.Error류의 cause 옵션. */
const OPTION_FEATURE_PATHS: ReadonlyMap<string, readonly string[]> = new Map([
  [
    "Error.cause",
    ["javascript", "builtins", "Error", "Error", "options_cause_parameter"],
  ],
  [
    "EventTarget.addEventListener.signal",
    [
      "api",
      "EventTarget",
      "addEventListener",
      "options_parameter",
      "options_signal_parameter",
    ],
  ],
]);

/** `Error`류 생성자 이름 -> options 객체가 오는 인자 위치(0-based). AggregateError만 3번째 인자(errors, message, options)다. */
export const ERROR_CAUSE_CONSTRUCTORS: ReadonlyMap<string, number> = new Map([
  ["Error", 1],
  ["EvalError", 1],
  ["RangeError", 1],
  ["ReferenceError", 1],
  ["SyntaxError", 1],
  ["TypeError", 1],
  ["URIError", 1],
  ["AggregateError", 2],
]);

const STATIC_SUFFIX = "_static";
/** javascript.builtins 리프가 instance(prototype) 멤버임을 나타내는 spec_url 조각. static 멤버의 spec_url에는 없다. */
const PROTOTYPE_SPEC_MARKER = ".prototype.";

/** __compat과 @@로 시작하는 well-known symbol 키는 멤버가 아니다. */
const memberKeys = (node: BcdNode): string[] =>
  Object.keys(node).filter(
    (key) => key !== "__compat" && !key.startsWith("@@"),
  );

const isBcdNode = (value: unknown): value is BcdNode =>
  typeof value === "object" && value !== null;

/** javascript.builtins 리프가 instance 멤버인지 spec_url로 판정한다. 판정 불가(spec_url 없음)면 undefined. */
const isPrototypeMember = (node: BcdNode): boolean | undefined => {
  const specUrl = node.__compat?.spec_url;
  if (specUrl === undefined) return undefined;
  const urls = Array.isArray(specUrl) ? specUrl : [specUrl];
  return urls.some((url) => url.includes(PROTOTYPE_SPEC_MARKER));
};

/** BCD 트리에서 경로를 따라 노드를 찾는다. 없으면 undefined. */
const resolveBcdPath = (
  root: BcdNode,
  segments: readonly string[],
): BcdNode | undefined => {
  let node: BcdNode = root;
  for (const segment of segments) {
    const next = node[segment];
    if (!isBcdNode(next)) return undefined;
    node = next;
  }
  return node;
};

/** KNOWN_GLOBAL_TYPES가 가리키는 인터페이스 이름 집합(crypto -> Crypto 등). */
const KNOWN_GLOBAL_TYPE_NAMES: ReadonlySet<string> = new Set(
  KNOWN_GLOBAL_TYPES.values(),
);

/**
 * api.* 인터페이스가 tier 2(수신자 불명) 후보 owner로 쓸 만한지 본다.
 *
 * 세 신호 중 하나면 "코드가 실제로 변수에 담아 들고 다닐 만한 진짜
 * 인스턴스 타입"으로 본다: (1) knownGlobalTypes가 가리키는 타입이다
 * (crypto/navigator 등 고정 전역이 가려지면 이 owner로 내려가야 한다 —
 * 그렇지 않으면 shadow된 crypto.randomUUID()가 tier 1에서도 tier 2에서도
 * 잡히지 않는 구멍이 생긴다), (2) 자기 이름과 같은 자식 키를 가진다(생성자
 * 항목, 예: AbortController.AbortController), (3) static 접미사가 붙은
 * 멤버가 하나라도 있다(예: AbortSignal.timeout_static). 이 신호가 없으면
 * NavigatorID·WindowEventHandlers 같은 mixin까지 섞여 흔한 프로퍼티
 * 이름(예: "id", "name")마다 tier 2 오탐이 폭증한다. 손으로 고른 API
 * 목록이 아니라 BCD 구조 자체에서 유도한 신호라는 점이 핵심이다.
 */
const isEligibleApiOwner = (name: string, node: BcdNode): boolean => {
  if (KNOWN_GLOBAL_TYPE_NAMES.has(name)) return true;
  if (isBcdNode(node[name])) return true;
  return memberKeys(node).some((key) => key.endsWith(STATIC_SUFFIX));
};

/** 색인 항목 하나. */
const makeCandidate = (
  bcdPath: string,
  issues: readonly CompatIssue[],
): CompatCandidate => ({
  bcdPaths: [bcdPath],
  issues,
});

/** issue 하나를 baseline 만족까지 남은 "거리"로 바꾼다. 비교 전용이며 출력에 쓰지 않는다. */
const issueDistance = (issue: CompatIssue): ParsedVersion => {
  if (issue.reason === "not-yet-added" && issue.requiredVersion !== null) {
    return (
      parseVersionToken(issue.requiredVersion) ?? {
        major: Number.POSITIVE_INFINITY,
        minor: 0,
        patch: 0,
      }
    );
  }
  // removed/never-added는 baseline 버전을 아무리 올려도 해소되지 않는다.
  return { major: Number.POSITIVE_INFINITY, minor: 0, patch: 0 };
};

/**
 * 같은 브라우저에 대한 두 owner의 issue 중 "더 낙관적인"(요구 버전이 더
 * 낮은) 쪽을 남긴다. tier 2는 수신자 타입을 증명하지 못하므로, 여러
 * owner가 같은 member 이름을 가지면 "운 좋게 더 관대한 타입일 수도
 * 있다"는 가정으로 오탐을 줄인다.
 */
const moreOptimisticIssue = (a: CompatIssue, b: CompatIssue): CompatIssue =>
  compareVersions(issueDistance(a), issueDistance(b)) <= 0 ? a : b;

/**
 * 두 owner의 issue 목록을 낙관적으로 합친다. 한쪽 owner가 어떤
 * 브라우저에서 안전하면(그 브라우저의 issue가 없으면) 병합 결과에서도
 * 그 브라우저의 issue를 뺀다 — 수신자가 그 owner일 수도 있으므로.
 */
const mergeIssuesOptimistically = (
  a: readonly CompatIssue[],
  b: readonly CompatIssue[],
): CompatIssue[] => {
  const merged: CompatIssue[] = [];
  for (const issueA of a) {
    const issueB = b.find((candidate) => candidate.browser === issueA.browser);
    if (issueB === undefined) continue;
    merged.push(moreOptimisticIssue(issueA, issueB));
  }
  return merged;
};

/** member 이름 하나에 대한 owner 한 명의 기여. issues가 빈 배열이면 "이 owner에서는 안전하다"는 뜻이다. */
interface InstanceMemberContribution {
  readonly bcdPath: string;
  readonly issues: readonly CompatIssue[];
}

/**
 * baseline에 맞춰 BCD 판정 색인을 만든다.
 *
 * 대상은 api.*와 javascript.builtins.* 전체다. 도입이 baseline보다 늦거나
 * (issues에 "not-yet-added") 제거된 적이 있는(issues에 "removed") 항목만
 * 색인에 남는다 — baseline 이전부터 지원됐거나 baseline 시점에 이미
 * 지원되는 API는 아예 후보에 오르지 않는다.
 */
export function buildCompatIndex(baseline: BrowserBaseline): CompatIndex {
  const bcd = loadBcd();
  const globals = new Map<string, CompatCandidate>();
  const staticMembers = new Map<string, CompatCandidate>();

  // member 이름 -> eligible owner들의 기여 목록. 안전한(issues가 빈)
  // owner도 반드시 포함해야 한다 — 낙관적 병합(mergeIssuesOptimistically)이
  // "이 이름을 가진 어떤 owner는 안전하다"는 사실 자체로 병합 결과를
  // 깎아내는데, 안전한 owner를 여기서 미리 걸러내면 그 존재가 사라져
  // 병합이 데이터 없이 "위반"쪽으로만 치우치게 된다(예: CloseEvent.reason은
  // chrome 15부터 안전하지만, 이걸 빼면 AbortSignal.reason의 chrome 98
  // 요구가 CloseEvent를 통해 낙관적으로 깎일 기회 자체가 없어진다 —
  // 이 경우는 반대로 안전 쪽이 사라지면 안 되는 예시다. 요점은 "안전한
  // owner도 참여시켜야 한다"는 것이다).
  const instanceMemberContributions = new Map<
    string,
    InstanceMemberContribution[]
  >();

  const addInstanceMemberContribution = (
    name: string,
    contribution: InstanceMemberContribution,
  ): void => {
    const list = instanceMemberContributions.get(name);
    if (list === undefined) {
      instanceMemberContributions.set(name, [contribution]);
      return;
    }
    list.push(contribution);
  };

  // 1) api.* — 전역(인터페이스 자신), static 멤버, instance 멤버를 함께 훑는다.
  for (const [ownerName, node] of Object.entries(bcd.api)) {
    if (!isBcdNode(node)) continue;

    const ownIssues = evaluateAgainstBaseline(node.__compat?.support, baseline);
    if (ownIssues.length > 0)
      globals.set(ownerName, makeCandidate(`api.${ownerName}`, ownIssues));

    const ownerEligible = isEligibleApiOwner(ownerName, node);

    for (const key of memberKeys(node)) {
      if (key === ownerName) continue; // 생성자 자기 재귀 항목. 위 ownIssues가 이미 대표한다.
      const child = node[key];
      if (!isBcdNode(child)) continue;

      const issues = evaluateAgainstBaseline(child.__compat?.support, baseline);
      const isStatic = key.endsWith(STATIC_SUFFIX);
      const memberName = isStatic ? key.slice(0, -STATIC_SUFFIX.length) : key;
      const bcdPath = `api.${ownerName}.${key}`;

      if (issues.length > 0) {
        // static이든 아니든 "Owner.member" 형태로 staticMembers에 넣는다 —
        // static은 원래 이 형태로 호출되고(AbortSignal.timeout()), 나머지는
        // knownGlobalTypes를 거친 고정 전역의 멤버(crypto.randomUUID)를
        // 같은 "Owner.member" 키로 조회하기 위해서다.
        staticMembers.set(
          `${ownerName}.${memberName}`,
          makeCandidate(bcdPath, issues),
        );
      }

      if (!isStatic && ownerEligible) {
        addInstanceMemberContribution(key, { bcdPath, issues });
      }
    }
  }

  // 2) javascript.builtins.* — 최상위 이름은 전역, 자식은 spec_url로 static/instance가 갈린다.
  const builtins = bcd.javascript.builtins;
  if (isBcdNode(builtins)) {
    for (const [builtinName, node] of Object.entries(builtins)) {
      if (!isBcdNode(node)) continue;

      const ownIssues = evaluateAgainstBaseline(
        node.__compat?.support,
        baseline,
      );
      if (ownIssues.length > 0) {
        globals.set(
          builtinName,
          makeCandidate(`javascript.builtins.${builtinName}`, ownIssues),
        );
      }

      for (const key of memberKeys(node)) {
        if (key === builtinName) continue; // 생성자 자기 재귀 항목.
        const child = node[key];
        if (!isBcdNode(child)) continue;

        const prototypeMember = isPrototypeMember(child);
        if (prototypeMember === undefined) continue; // 판정 불가 -> 색인하지 않는다.

        const issues = evaluateAgainstBaseline(
          child.__compat?.support,
          baseline,
        );
        const bcdPath = `javascript.builtins.${builtinName}.${key}`;

        if (prototypeMember) {
          // javascript.builtins의 최상위 이름은 전부 실제 JS 전역이므로
          // (BCD 스키마 구조 자체가 그렇게 보장한다) api.*와 달리 owner
          // 자격 확인이 필요 없다.
          addInstanceMemberContribution(key, { bcdPath, issues });
          continue;
        }
        if (issues.length > 0) {
          staticMembers.set(
            `${builtinName}.${key}`,
            makeCandidate(bcdPath, issues),
          );
        }
      }
    }
  }

  const instanceMembers = new Map<string, CompatCandidate>();
  for (const [name, contributions] of instanceMemberContributions) {
    let merged: readonly CompatIssue[] | undefined;
    const bcdPaths: string[] = [];
    for (const contribution of contributions) {
      bcdPaths.push(contribution.bcdPath);
      merged =
        merged === undefined
          ? contribution.issues
          : mergeIssuesOptimistically(merged, contribution.issues);
    }
    if (merged !== undefined && merged.length > 0) {
      instanceMembers.set(name, { bcdPaths, issues: merged });
    }
  }

  // 3) tier 3 — 옵션 서브피처는 고정 BCD 경로다. 경로가 해석되지 않으면
  //    @mdn/browser-compat-data 버전과 이 매핑이 어긋났다는 뜻이므로,
  //    조용히 건너뛰지 않고 던진다 — 낡은 매핑이 검사 대상을 조용히
  //    잃어버리는 것보다 빌드가 시끄럽게 깨지는 편이 낫다.
  const optionFeatures = new Map<string, CompatCandidate>();
  for (const [name, segments] of OPTION_FEATURE_PATHS) {
    const node = resolveBcdPath(bcd as unknown as BcdNode, segments);
    if (node === undefined) {
      throw new Error(
        `BCD 경로 "${segments.join(".")}"를 찾을 수 없습니다. ` +
          `compat-bcd.ts의 옵션 서브피처 매핑이 @mdn/browser-compat-data 버전과 어긋났습니다.`,
      );
    }
    const issues = evaluateAgainstBaseline(node.__compat?.support, baseline);
    optionFeatures.set(name, makeCandidate(segments.join("."), issues));
  }

  return {
    globals,
    staticMembers,
    instanceMembers,
    knownGlobalTypes: KNOWN_GLOBAL_TYPES,
    optionFeatures,
  };
}
