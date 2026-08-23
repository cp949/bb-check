import type { BbErrorCode } from "./types.js";

/**
 * bb-check 계열 패키지가 던지는 표준 오류.
 * code로 오류 종류를 식별하고, 원인 오류는 표준 Error#cause로 보존한다.
 */
export class BbError extends Error {
  readonly code: BbErrorCode;

  constructor(code: BbErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BbError";
    this.code = code;
  }
}
