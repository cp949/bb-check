import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

import { forceActualNpmOperationEnv } from "./test-packed-package.mjs";

test("상위 npm publish dry-run에서도 내부 pack과 install은 실제 파일을 만든다", () => {
  const original = {
    PATH: "/bin",
    npm_config_dry_run: "true",
  };

  assert.deepEqual(forceActualNpmOperationEnv(original), {
    PATH: "/bin",
    npm_config_dry_run: "false",
  });
  assert.equal(original.npm_config_dry_run, "true");
});

test("상위 dry-run 환경에서도 격리 tarball 설치와 CLI 검증을 완료한다", () => {
  const result = spawnSync(
    process.execPath,
    [resolve(import.meta.dirname, "test-packed-package.mjs")],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        npm_config_dry_run: "true",
      },
    },
  );

  assert.equal(
    result.status,
    0,
    `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  assert.match(result.stdout, /test-packed-package: OK/);
});
