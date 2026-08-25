import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

import * as packedPackage from "./test-packed-package.mjs";

const { forceActualNpmOperationEnv, parsePackageSelection } = packedPackage;

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

test("--package가 없으면 기존 bb-check를 선택하고 package 이름만 허용한다", () => {
  assert.equal(parsePackageSelection([]), "@cp949/bb-check");
  assert.equal(
    parsePackageSelection(["--package", "@cp949/next-webpack-baseline"]),
    "@cp949/next-webpack-baseline",
  );
  assert.throws(
    () => parsePackageSelection(["--package", "@fixture/unknown"]),
    /지원하지 않는 공개 package/u,
  );
  assert.throws(() => parsePackageSelection(["--package"]), /사용법/u);
});

test("Windows npm만 shell 없이 npm CLI를 Node로 실행하고 node -e는 유지한다", () => {
  assert.deepEqual(
    packedPackage.createCommandInvocation(
      "npm",
      ["pack", "--pack-destination", "C:\\dynamic path"],
      {
        platform: "win32",
        npmExecPath: "C:\\npm cli\\npm-cli.js",
        nodeExecPath: "C:\\node\\node.exe",
      },
    ),
    {
      command: "C:\\node\\node.exe",
      args: [
        "C:\\npm cli\\npm-cli.js",
        "pack",
        "--pack-destination",
        "C:\\dynamic path",
      ],
    },
  );
  assert.deepEqual(
    packedPackage.createCommandInvocation("node", ["-e", "dynamic value"], {
      platform: "win32",
      npmExecPath: "C:\\npm cli\\npm-cli.js",
      nodeExecPath: "C:\\node\\node.exe",
    }),
    { command: "node", args: ["-e", "dynamic value"] },
  );
  assert.deepEqual(
    packedPackage.createCommandInvocation(
      "npm",
      ["install", "C:\\dynamic path\\package.tgz"],
      {
        platform: "win32",
        npmExecPath: undefined,
        nodeExecPath: "C:\\Program Files\\nodejs\\node.exe",
      },
    ),
    {
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: [
        "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
        "install",
        "C:\\dynamic path\\package.tgz",
      ],
    },
  );
  assert.deepEqual(
    packedPackage.createCommandInvocation("npx", ["bb-check", "--help"], {
      platform: "win32",
      npmExecPath: undefined,
      nodeExecPath: "C:\\Program Files\\nodejs\\node.exe",
    }),
    {
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: [
        "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js",
        "bb-check",
        "--help",
      ],
    },
  );
});

test("상위 dry-run 환경에서도 bb-check 격리 tarball과 CLI를 검증한다", () => {
  const result = spawnSync(
    process.execPath,
    [
      resolve(import.meta.dirname, "test-packed-package.mjs"),
      "--package",
      "@cp949/bb-check",
    ],
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
  assert.match(result.stdout, /test-packed-package: OK \(@cp949\/bb-check,/u);
});

test("next-webpack-baseline tarball을 격리 설치하고 facade를 import한다", () => {
  const result = spawnSync(
    process.execPath,
    [
      resolve(import.meta.dirname, "test-packed-package.mjs"),
      "--package",
      "@cp949/next-webpack-baseline",
    ],
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
  assert.match(
    result.stdout,
    /test-packed-package: OK \(@cp949\/next-webpack-baseline,/u,
  );
});
