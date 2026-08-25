export const NEXT_WEBPACK_BASELINE_ERROR_CODES = {
  CONFIG_INVALID: "NWB_CONFIG_INVALID",
  BROWSERSLIST_MISSING: "NWB_BROWSERSLIST_MISSING",
  BROWSERSLIST_MODERN_ONLY: "NWB_BROWSERSLIST_MODERN_ONLY",
  PACKAGE_PATH_UNRESOLVED: "NWB_PACKAGE_PATH_UNRESOLVED",
  SYNTAX_UNSUPPORTED: "NWB_SYNTAX_UNSUPPORTED",
  SYNTAX_PARSE_INCOMPLETE: "NWB_SYNTAX_PARSE_INCOMPLETE",
  WAIVER_INVALID: "NWB_WAIVER_INVALID",
  WEBPACK_UNSUPPORTED: "NWB_WEBPACK_UNSUPPORTED",
} as const;

export type NextWebpackBaselineErrorCode =
  (typeof NEXT_WEBPACK_BASELINE_ERROR_CODES)[keyof typeof NEXT_WEBPACK_BASELINE_ERROR_CODES];

export class NextWebpackBaselineError extends Error {
  readonly code: NextWebpackBaselineErrorCode;

  constructor(code: NextWebpackBaselineErrorCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = "NextWebpackBaselineError";
    this.code = code;
  }
}
