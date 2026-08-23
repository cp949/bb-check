// 브라우저 기준선 검사 결과와 오류 계약의 타입 정의.
// packages/bb-library, packages/bb-check가 공유하는 형태다.

/** finding이 속하는 검사 축. 정렬 시 이 순서(syntax, runtime-js, dependency, css)를 따른다. */
export type FindingAxis = "syntax" | "runtime-js" | "dependency" | "css";

/** 브라우저 이름 -> 최소 지원 버전 문자열 맵 (예: `{ chrome: "80" }`). */
export type BrowserBaseline = Readonly<Record<string, string>>;

/** 특정 파일의 특정 라이브러리 사용을 baseline 검사에서 예외로 허용하는 항목. */
export interface LibraryAllowance {
  readonly file: string;
  readonly name: string;
  readonly reason: string;
}

/**
 * bb-check.config.mjs 등에서 사용자가 작성하는, 아직 검증되지 않은 설정 형태.
 * normalizeConfig의 입력 계약을 문서화하기 위한 타입이며, 실제 런타임
 * 검증은 normalizeConfig가 `unknown` 입력에 대해 수행한다.
 */
export interface BbCheckConfig {
  readonly library: {
    readonly projectDir: string;
    readonly allow?: readonly LibraryAllowance[];
  };
}

/** normalizeConfig가 반환하는, 검증되고 깊게 동결된 내부 설정 형태. */
export interface NormalizedBbCheckConfig {
  readonly library: {
    readonly projectDir: string;
    readonly allow: readonly LibraryAllowance[];
  };
}

/** 하나의 baseline 위반 또는 검사 항목. */
export interface Finding {
  readonly axis: FindingAxis;
  readonly file: string;
  /** 소스 상 위치를 알 수 없으면 null. */
  readonly line: number | null;
  readonly name: string;
  readonly detail: string;
  /** 변환/번들 이전 원본 파일 경로 (소스맵 등으로 역추적한 경우). */
  readonly originalFile?: string;
}

/** 하나의 검사 실행 결과. */
export interface CheckResult {
  readonly baseline: Readonly<Record<string, string>>;
  readonly findings: readonly Finding[];
  /** 일부 대상을 읽거나 파싱하지 못해 결과가 불완전한지 여부. */
  readonly incomplete: boolean;
  readonly ok: boolean;
}

/** BbError가 가질 수 있는 오류 코드. */
export type BbErrorCode =
  | "BB_USAGE"
  | "BB_CONFIG_NOT_FOUND"
  | "BB_CONFIG_INVALID"
  | "BB_BASELINE_EMPTY"
  | "BB_INPUT_NOT_FOUND"
  | "BB_TARGET_READ"
  | "BB_TARGET_PARSE"
  | "BB_UNEXPECTED";
