#!/usr/bin/env node
// @cp949/legacy-browser-smoke self-test CLI.
//
// 고정된 Chromium 75 실행 파일을 확보(필요하면 다운로드)해 baseline page 로드와
// legacy-syntax 구문 거부 두 가지를 실제로 검증하고, 사람이 읽을 수 있는 판정을
// 표준 출력에 남긴다. 손작성 순수 JS이며 빌드 파이프라인 밖에서 그대로 실행된다.
//
// self-reference import: package.json의 exports 필드 덕분에 packed 설치본과
// workspace(dist/가 빌드되어 있는 경우) 양쪽에서 동일하게 동작한다.
import { createLegacyBrowserSmoke } from "@cp949/legacy-browser-smoke";

const usage = `사용법: legacy-browser-smoke-self-test [옵션]

옵션:
  --executable-path <path>   고정된 Chromium 대신 사용할 실행 파일 경로
  --no-sandbox <reason>      sandbox를 비활성화하는 이유(격리된 CI container 전용)
  --help                     이 사용법을 출력하고 종료

옵션 없이 실행하면 관리형 Chromium 75를 확보해 self-test를 실행한다.`;

/** 사용법 메시지를 담은 오류를 만든다. 파싱 실패와 알 수 없는 인자를 fail-closed로 거부할 때 던진다. */
const usageError = () => new Error(usage);

/**
 * argv를 selfTest() 옵션으로 파싱한다.
 * `--help`는 다른 인자와 무관하게 최우선이다. 그 외에는 알려진 두 플래그만
 * 허용하며, 값 누락·중복 플래그·알 수 없는 인자는 모두 사용법 오류로 던진다.
 */
const parseArgv = (argv) => {
  if (argv.includes("--help")) return { help: true, options: {} };

  const options = {};
  let index = 0;
  while (index < argv.length) {
    const flag = argv[index];
    if (flag === "--executable-path") {
      if (Object.hasOwn(options, "executablePath")) throw usageError();
      const value = argv[index + 1];
      if (value === undefined) throw usageError();
      options.executablePath = value;
      index += 2;
      continue;
    }
    if (flag === "--no-sandbox") {
      if (Object.hasOwn(options, "sandbox")) throw usageError();
      const reason = argv[index + 1];
      if (reason === undefined || reason.trim() === "") throw usageError();
      options.sandbox = { mode: "disabled", reason };
      index += 2;
      continue;
    }
    throw usageError();
  }
  return { help: false, options };
};

/**
 * `createLegacyBrowserSmoke`는 생성 시 1개 이상의 page를 요구한다
 * (`config.ts`의 `rawPages.length === 0` → `LBS_CONFIG_INVALID`). CLI가 실제로
 * 실행하는 것은 `selfTest()`뿐이고, `selfTest()`는 package 내부에 고정된
 * self-test 전용 page 두 개만 쓰므로 이 값은 전혀 사용되지 않는다 — 생성
 * 시점의 검증을 통과시키기 위한 자리표시자다.
 */
const placeholderConfig = {
  pages: [
    {
      name: "placeholder",
      path: "/",
      ready: { kind: "expression", expression: "true" },
    },
  ],
  timeoutMs: 10000,
};

const main = async (argv) => {
  const parsed = parseArgv(argv);
  if (parsed.help) {
    process.stdout.write(`${usage}\n`);
    return;
  }

  const smoke = createLegacyBrowserSmoke(placeholderConfig);
  const report = await smoke.selfTest(parsed.options);

  process.stdout.write(`browserVersion: ${report.browserVersion}\n`);
  for (const check of report.checks) {
    process.stdout.write(`  ${check.name}: ${check.status}\n`);
  }
  process.stdout.write(`status: ${report.status}\n`);
  process.exitCode = report.status === "pass" ? 0 : 1;
};

try {
  await main(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
