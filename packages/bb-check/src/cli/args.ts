// `bb-check library check` argument 문법만 파싱한다. 다른 명령(target)은
// 아직 없으므로 명시적으로 거절한다 — 프로젝트 종류 자동 감지를 하지
// 않는다는 설계 결정(잘못된 검사기가 조용히 선택되는 것을 막음)을 그대로
// 따른다.

import { BbError } from "@cp949/bb-core";

/** `library check` 명령의 파싱된 argument. */
export interface ParsedLibraryCheckArgs {
  readonly target: "library";
  readonly action: "check";
  readonly config?: string;
  readonly dir?: string;
  readonly debug: boolean;
}

/** main.ts가 --help 처리와 사용법 오류 메시지 양쪽에서 공유하는 사용법 문자열. */
export const USAGE =
  "사용법: bb-check library check [--config <path>] [--dir <path>] [--debug]\n" +
  "       bb-check --help | -h\n" +
  "       bb-check --version | -v";

const usageError = (reason: string): never => {
  throw new BbError("BB_USAGE", `[BB_USAGE] ${reason}\n${USAGE}`);
};

/**
 * CLI argv(명령 이름 이후, 즉 `process.argv.slice(2)`)를 파싱한다.
 * `library check` 형태만 허용하고, 그 외 target·action·알 수 없는 옵션·
 * 값이 빠진 옵션·불필요한 위치 인자는 모두 BB_USAGE로 거절한다.
 */
export function parseArgs(argv: readonly string[]): ParsedLibraryCheckArgs {
  const [target, action, ...rest] = argv;
  if (target !== "library" || action !== "check") {
    usageError(`지원하지 않는 명령입니다: ${argv.join(" ") || "(없음)"}`);
  }

  let config: string | undefined;
  let dir: string | undefined;
  let debug = false;

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    switch (token) {
      case "--config": {
        const value = rest[++i];
        if (value === undefined) usageError("--config 뒤에 경로가 필요합니다.");
        config = value;
        break;
      }
      case "--dir": {
        const value = rest[++i];
        if (value === undefined) usageError("--dir 뒤에 경로가 필요합니다.");
        dir = value;
        break;
      }
      case "--debug":
        debug = true;
        break;
      default:
        usageError(`알 수 없는 옵션입니다: ${token}`);
    }
  }

  return {
    target: "library",
    action: "check",
    ...(config !== undefined ? { config } : {}),
    ...(dir !== undefined ? { dir } : {}),
    debug,
  };
}
