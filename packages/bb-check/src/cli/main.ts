// argument 파싱 → config 로드 → checkLibrary → 보고서 렌더링을 순서대로
// 실행하고, 성공/위반/오류를 exit code와 stdout/stderr로 옮긴다. 이 파일은
// 판정도 config 검증도 하지 않는다 — 각 단계는 이미 다른 모듈(parseArgs,
// loadConfig, checkLibrary, renderLibraryReport)이 갖고 있고, main()은
// 그 결과를 올바른 채널로 옮기는 오케스트레이션만 담당한다.

import { BbError } from "@cp949/bb-core";
import { checkLibrary } from "@cp949/bb-library";
import { parseArgs } from "./args.js";
import { loadConfig } from "../config-loader.js";
import { renderLibraryReport } from "../report.js";

/** CLI가 결과를 내보내는 통로. 실제 프로세스는 cli.ts가 process.stdout/stderr로 연결한다. */
export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly cwd: string;
}

const EXIT_OK = 0;
const EXIT_VIOLATION = 1;
const EXIT_ERROR = 2;

/**
 * 오류를 stderr에 `[CODE] message` 한 줄로 쓴다. `BbError`가 아닌 값은
 * `[BB_UNEXPECTED]`로 감싼다(core가 분류하지 못한, 도구 자체의 버그일
 * 가능성이 높은 오류). `debug`가 true면 원인 체인의 stack trace를
 * 이어서 stderr에 쓴다 — 기본 출력에는 절대 stack을 노출하지 않는다.
 */
const reportError = (cause: unknown, io: CliIo, debug: boolean): number => {
  if (cause instanceof BbError) {
    io.stderr(cause.message + "\n");
  } else {
    const message = cause instanceof Error ? cause.message : String(cause);
    io.stderr(`[BB_UNEXPECTED] ${message}\n`);
  }
  if (debug) writeDebugTrail(cause, io);
  return EXIT_ERROR;
};

/** cause 체인을 따라가며 각 오류의 stack(없으면 문자열 표현)을 stderr에 쓴다. */
const writeDebugTrail = (error: unknown, io: CliIo): void => {
  if (!(error instanceof Error)) {
    io.stderr(`${String(error)}\n`);
    return;
  }
  io.stderr(`${error.stack ?? error.message}\n`);
  if (error.cause !== undefined) {
    io.stderr("원인:\n");
    writeDebugTrail(error.cause, io);
  }
};

/**
 * CLI 진입점 로직. argv는 명령 이름 이후(`process.argv.slice(2)`)를
 * 받는다. 반환하는 숫자가 그대로 process exit code다 — 이 함수는
 * process.exit을 직접 호출하지 않으므로 테스트에서 안전하게 호출할 수
 * 있다.
 *
 * exit code: 0 = 통과, 1 = 위반 또는 불완전 판정, 2 = 사용법/설정/환경 오류.
 */
export async function main(
  argv: readonly string[],
  io: CliIo,
): Promise<number> {
  // 사용법 오류(argv 자체가 잘못됨)로 parseArgs가 던지더라도 --debug
  // 요청은 존중해야 하므로, 파싱 성공 여부와 무관하게 raw argv에서 직접 읽는다.
  const debug = argv.includes("--debug");

  try {
    const args = parseArgs(argv);
    const config = await loadConfig({
      cwd: io.cwd,
      ...(args.config !== undefined ? { config: args.config } : {}),
      ...(args.dir !== undefined ? { dir: args.dir } : {}),
    });
    const result = await checkLibrary(config.library);
    io.stdout(renderLibraryReport(result));
    return result.ok ? EXIT_OK : EXIT_VIOLATION;
  } catch (cause) {
    return reportError(cause, io, debug);
  }
}
