#!/usr/bin/env node
// bb-check 실행 파일 entry. process 연결(stdout/stderr/exit code)만
// 담당하고, 실제 로직은 전부 cli/main.ts의 main()에 있다 — main()은
// process.exit을 직접 호출하지 않으므로 테스트에서 순수 함수처럼 호출할
// 수 있고, 여기서만 실제 process에 연결한다.

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

// process.exit() 대신 exitCode를 설정한다 — stdout/stderr에 아직 flush되지
// 않은 내용이 있어도 강제 종료로 잘리지 않는다.
process.exitCode = await main(process.argv.slice(2), io);
