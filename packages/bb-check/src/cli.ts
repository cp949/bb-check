#!/usr/bin/env node
// bb-check 실행 파일 entry. process 연결(stdout/stderr/exit code)만
// 담당하고, 실제 로직은 전부 cli/main.ts의 main()에 있다 — main()은
// process.exit을 직접 호출하지 않으므로 테스트에서 순수 함수처럼 호출할
// 수 있고, 여기서만 실제 process에 연결한다.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "./cli/main.js";

const io = {
  stdout: (text: string) => {
    process.stdout.write(text);
  },
  stderr: (text: string) => {
    process.stderr.write(text);
  },
  cwd: process.cwd(),
};

// package.json#version을 읽어 --version에 쓴다. 이 파일(cli.ts/dist의
// cli.js)은 소스에서도 빌드 산출물에서도 항상 package 루트 바로 아래
// 한 단계(src/ 또는 dist/)에 있으므로 "../package.json" 상대 경로가 두
// 경우 모두에서 동일하게 package 루트를 가리킨다.
//
// `new URL("../package.json", import.meta.url)` 리터럴 형태는 일부러
// 쓰지 않는다 — Vite(Rolldown)가 그 패턴을 정적 asset 참조로 인식해
// package.json 전체를 base64 data: URL로 번들에 inline해 버리는 걸
// 실측 확인했다(`fileURLToPath`가 그 data: URL을 file: URL로 착각해
// ERR_INVALID_URL_SCHEME로 깨짐). dirname + join으로 경로를 조립해
// 그 정적 분석을 피한다 — 런타임에는 완전히 동일한 경로를 가리킨다.
const currentDir = dirname(fileURLToPath(import.meta.url));
const packageJsonPath = join(currentDir, "..", "package.json");
const version = (
  JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version: string }
).version;

// process.exit() 대신 exitCode를 설정한다 — stdout/stderr에 아직 flush되지
// 않은 내용이 있어도 강제 종료로 잘리지 않는다.
process.exitCode = await main(process.argv.slice(2), io, { version });
