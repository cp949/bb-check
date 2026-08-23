import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createNpmInvocation } from "./npm-command.js";

const packagesWithTests = [
  ["packages/core", "test/config.test.ts"],
  ["packages/bb-library", "test/baseline.test.ts"],
  ["packages/bb-check", "test/cli.test.ts"],
] as const;

describe("package typecheck 입력", () => {
  it.each(packagesWithTests)(
    "%s typecheck는 %s를 TypeScript resolved file list에 넣는다",
    (workspace, testFile) => {
      const invocation = createNpmInvocation(process.env.npm_execpath, [
        "run",
        "typecheck",
        `--workspace=${workspace}`,
        "--",
        "--listFiles",
      ]);
      const result = spawnSync(invocation.command, invocation.args, {
        cwd: process.cwd(),
        encoding: "utf8",
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(resolve(workspace, testFile));
    },
  );
});
