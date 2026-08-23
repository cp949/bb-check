import { describe, expect, it } from "vitest";
import { createNpmInvocation } from "./npm-command.js";

describe("npm Node 런처", () => {
  it("npm_execpath를 Node로 실행하고 npm 인자를 그대로 뒤에 둔다", () => {
    expect(
      createNpmInvocation("C:/Program Files/nodejs/npm-cli.js", [
        "run",
        "typecheck",
        "--workspace=packages/core",
        "--",
        "--listFiles",
      ]),
    ).toEqual({
      command: process.execPath,
      args: [
        "C:/Program Files/nodejs/npm-cli.js",
        "run",
        "typecheck",
        "--workspace=packages/core",
        "--",
        "--listFiles",
      ],
    });
  });

  it("npm_execpath가 없으면 spawn 전에 명시적으로 거절한다", () => {
    expect(() => createNpmInvocation(undefined, ["run", "typecheck"])).toThrow(
      "npm_execpath",
    );
  });
});
