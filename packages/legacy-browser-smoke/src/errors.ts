export type LegacyBrowserSmokeErrorCode =
  | "LBS_CONFIG_INVALID"
  | "LBS_PLATFORM_UNSUPPORTED"
  | "LBS_CHECKSUM_MISMATCH"
  | "LBS_BROWSER_VERSION_MISMATCH"
  | "LBS_SANDBOX_UNAVAILABLE"
  | "LBS_ORIGIN_NOT_LOOPBACK"
  | "LBS_CONNECT_TIMEOUT"
  | "LBS_COMMAND_TIMEOUT"
  | "LBS_PAGE_NOT_READY";

export class LegacyBrowserSmokeError extends Error {
  readonly code: LegacyBrowserSmokeErrorCode;

  constructor(
    code: LegacyBrowserSmokeErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "LegacyBrowserSmokeError";
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
