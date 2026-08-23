#!/usr/bin/env node
// `src/` 디렉터리가 있을 때만 뒤에 오는 명령을 실행하는 크로스플랫폼
// no-op-safe 러너. POSIX 전용 shell 문법(`[ -d src ] && ... || ...`)
// 대신 순수 Node.js로 구현해 Windows(cmd.exe)에서도 동일하게 동작한다.
//
// 사용: node <이 스크립트 경로> <명령> [인자...]
// - cwd(호출한 package 디렉터리) 기준으로 `src/`가 없으면 exit 0 (no-op).
// - `src/`가 있으면 주어진 명령을 그대로 실행하고 그 종료 코드를 그대로 전달한다.
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const [, , ...command] = process.argv;

if (!existsSync("src")) {
  process.exit(0);
}

if (command.length === 0) {
  console.error("run-if-src: 실행할 명령이 지정되지 않았다");
  process.exit(1);
}

const [bin, ...args] = command;
// shell: true로 실행해 Windows에서 .cmd 확장자 확인(tsc.cmd, eslint.cmd 등)과
// PATH(npm이 주입하는 node_modules/.bin 포함) 탐색이 POSIX와 동일하게 동작하게 한다.
const result = spawnSync(bin, args, { stdio: "inherit", shell: true });

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
