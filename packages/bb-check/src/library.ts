// @cp949/bb-check/library 공개 subpath entry.
// 라이브러리 검사와 그 결과 타입만 공개한다. 개별 scanner(syntax/runtime-js/
// dependency)는 내부 seam이므로 여기서 재노출하지 않는다.

export { checkLibrary } from "@cp949/bb-library";
export type { CheckLibraryOptions } from "@cp949/bb-library";
export type {
  BrowserBaseline,
  CheckResult,
  Finding,
  FindingAxis,
  LibraryAllowance,
} from "@cp949/bb-core";
export { BbError } from "@cp949/bb-core";
export type { BbErrorCode } from "@cp949/bb-core";
