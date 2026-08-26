import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  createCommandInvocation,
  forceActualNpmOperationEnv,
  packageTable,
  parsePackageSelection,
} from "./test-packed-package.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

test("parsePackageSelection은 두 공개 package 이름을 모두 통과시킨다", () => {
  assert.equal(
    parsePackageSelection(["--package", "@cp949/next-webpack-baseline"]),
    "@cp949/next-webpack-baseline",
  );
  assert.equal(
    parsePackageSelection(["--package", "@cp949/legacy-browser-smoke"]),
    "@cp949/legacy-browser-smoke",
  );
});

test("parsePackageSelection은 알 수 없는 이름, 형식 오류, 인자 수 오류를 모두 두 이름이 담긴 사용법으로 거부한다", () => {
  const cases = [
    ["알 수 없는 이름", ["--package", "@cp949/unknown-package"]],
    ["잘못된 플래그", ["--pkg", "@cp949/next-webpack-baseline"]],
    ["인자 없음", []],
    ["인자 1개", ["--package"]],
    ["인자 3개", ["--package", "@cp949/next-webpack-baseline", "extra"]],
  ];

  for (const [name, args] of cases) {
    assert.throws(
      () => parsePackageSelection(args),
      (error) => {
        assert.match(error.message, /@cp949\/next-webpack-baseline/u, name);
        assert.match(error.message, /@cp949\/legacy-browser-smoke/u, name);
        return true;
      },
      name,
    );
  }
});

test("packageTable은 두 공개 package 이름을 정확한 workspace 디렉터리로 매핑한다", () => {
  assert.deepEqual(Object.keys(packageTable), [
    "@cp949/next-webpack-baseline",
    "@cp949/legacy-browser-smoke",
  ]);
  assert.equal(
    packageTable["@cp949/next-webpack-baseline"].workspaceDir,
    join(repoRoot, "packages", "next-webpack-baseline"),
  );
  assert.equal(
    packageTable["@cp949/legacy-browser-smoke"].workspaceDir,
    join(repoRoot, "packages", "legacy-browser-smoke"),
  );
});

test("forceActualNpmOperationEnv는 npm_config_dry_run을 false로 강제한다", () => {
  const result = forceActualNpmOperationEnv({
    PATH: "/usr/bin",
    npm_config_dry_run: "true",
  });

  assert.equal(result.npm_config_dry_run, "false");
  assert.equal(result.PATH, "/usr/bin");
});

test("Windows에서 npm/npx는 shell 없이 Node로 직접 실행되고 다른 명령은 그대로 통과한다", () => {
  assert.deepEqual(
    createCommandInvocation("npm", ["pack", "dynamic path"], {
      platform: "win32",
      npmExecPath: "C:\\npm cli\\npm-cli.js",
      nodeExecPath: "C:\\node\\node.exe",
    }),
    {
      command: "C:\\node\\node.exe",
      args: ["C:\\npm cli\\npm-cli.js", "pack", "dynamic path"],
    },
  );
  assert.deepEqual(
    createCommandInvocation(
      "npx",
      ["legacy-browser-smoke-self-test", "--help"],
      {
        platform: "win32",
        npmExecPath: "C:\\npm\\node_modules\\npm\\bin\\npm-cli.js",
        nodeExecPath: "C:\\node\\node.exe",
      },
    ),
    {
      command: "C:\\node\\node.exe",
      args: [
        "C:\\npm\\node_modules\\npm\\bin\\npx-cli.js",
        "legacy-browser-smoke-self-test",
        "--help",
      ],
    },
  );
  assert.deepEqual(
    createCommandInvocation("node", ["-e", "dynamic value"], {
      platform: "win32",
      npmExecPath: "C:\\npm cli\\npm-cli.js",
      nodeExecPath: "C:\\node\\node.exe",
    }),
    { command: "node", args: ["-e", "dynamic value"] },
  );
});

test("비-Windows에서는 명령을 그대로 통과시킨다", () => {
  assert.deepEqual(
    createCommandInvocation("npm", ["install"], { platform: "linux" }),
    { command: "npm", args: ["install"] },
  );
  assert.deepEqual(
    createCommandInvocation(
      "npx",
      ["legacy-browser-smoke-self-test", "--help"],
      {
        platform: "darwin",
      },
    ),
    { command: "npx", args: ["legacy-browser-smoke-self-test", "--help"] },
  );
});

test("Windows에서 npm_execpath가 없으면 명확한 오류로 거부한다", () => {
  assert.throws(
    () =>
      createCommandInvocation("npm", ["pack"], {
        platform: "win32",
        npmExecPath: "",
      }),
    /npm_execpath/u,
  );
});
