// @cp949/bb-check 공개 root entry.
// bb-check.config.mjs 작성자가 타입 추론 도움을 받도록 defineConfig만
// 노출한다. 실제 검증·정규화는 여기서 하지 않는다 — config 파일 위치를
// 아는 config-loader.ts가 normalizeConfig를 호출해 수행한다.

import type { BbCheckConfig } from "@cp949/bb-core";

export type { BbCheckConfig, LibraryAllowance } from "@cp949/bb-core";

/**
 * bb-check.config.mjs에서 타입 추론을 보존하기 위한 typed identity 함수다.
 * 입력을 검증하거나 변형하지 않고 그대로 반환한다.
 *
 * @example
 * ```js
 * import { defineConfig } from "@cp949/bb-check";
 *
 * export default defineConfig({
 *   library: { projectDir: ".", allow: [] },
 * });
 * ```
 */
export function defineConfig(config: BbCheckConfig): BbCheckConfig {
  return config;
}
