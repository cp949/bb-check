import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import test from "node:test";

import {
  classifyRegistryVersionResult,
  createCommandInvocation,
  parsePublishArguments,
  planPublish,
  publishPackage,
} from "./publish-package.mjs";

test("Windows에서는 npm CLI를 Node로 실행한다", () => {
  assert.deepEqual(
    createCommandInvocation("npm", ["whoami"], {
      platform: "win32",
      npmExecPath: "C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js",
    }),
    {
      command: process.execPath,
      args: [
        "C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js",
        "whoami",
      ],
    },
  );
  assert.throws(
    () =>
      createCommandInvocation("npm", ["whoami"], {
        platform: "win32",
        npmExecPath: "",
      }),
    /npm_execpath/,
  );
});

test("registry 조회 결과에서 배포됨, 미배포, 조회 실패를 구분한다", () => {
  assert.deepEqual(
    classifyRegistryVersionResult({ status: 0, stdout: "0.1.0\n", stderr: "" }),
    { status: "published", version: "0.1.0" },
  );
  assert.deepEqual(
    classifyRegistryVersionResult({
      status: 1,
      stdout: "",
      stderr: "npm error code E404\nnpm error 404 Not Found",
    }),
    { status: "missing" },
  );
  assert.deepEqual(
    classifyRegistryVersionResult({
      status: 1,
      stdout: "",
      stderr: "npm error code EAI_AGAIN\nnpm error request failed",
    }),
    { status: "error", reason: "EAI_AGAIN" },
  );
});

test("실제 배포는 registry에서 미배포가 확인된 경우에만 허용한다", () => {
  assert.deepEqual(
    planPublish({ dryRun: false, registryLookup: { status: "missing" } }),
    { action: "proceed" },
  );
  assert.match(
    planPublish({
      dryRun: false,
      registryLookup: { status: "published", version: "0.1.0" },
    }).reason,
    /이미 배포되어 있습니다/,
  );
  assert.match(
    planPublish({
      dryRun: false,
      registryLookup: { status: "error", reason: "EAI_AGAIN" },
    }).reason,
    /조회에 실패해 실제 배포를 중단합니다/,
  );
});

test("dry-run은 registry 조회 실패 상태에서도 허용한다", () => {
  assert.deepEqual(
    planPublish({
      dryRun: true,
      registryLookup: { status: "error", reason: "EAI_AGAIN" },
    }),
    { action: "proceed" },
  );
});

test("배포 전에 release 전체 검증을 실행한다", () => {
  const commands = [];
  const succeeded = publishPackage(
    "0.1.0",
    false,
    { status: "missing" },
    (command, args) => {
      commands.push([command, args]);
      return { status: 0 };
    },
  );

  assert.equal(succeeded, true);
  assert.deepEqual(commands, [
    ["npm", ["run", "verify:release"]],
    ["npm", ["whoami"]],
    ["npm", ["publish", "./packages/bb-check", "--access", "public"]],
  ]);
});

test("실제 배포는 npm 인증 실패 시 publish를 실행하지 않는다", () => {
  const commands = [];
  const succeeded = publishPackage(
    "0.1.0",
    false,
    { status: "missing" },
    (command, args) => {
      commands.push([command, args]);
      return { status: commands.length === 2 ? 1 : 0 };
    },
  );

  assert.equal(succeeded, false);
  assert.deepEqual(commands, [
    ["npm", ["run", "verify:release"]],
    ["npm", ["whoami"]],
  ]);
});

test("release 전체 검증이 실패하면 publish를 실행하지 않는다", () => {
  const commands = [];
  const succeeded = publishPackage(
    "0.1.0",
    true,
    { status: "missing" },
    (command, args) => {
      commands.push([command, args]);
      return { status: 1 };
    },
  );

  assert.equal(succeeded, false);
  assert.deepEqual(commands, [["npm", ["run", "verify:release"]]]);
});

test("dry-run publish 명령에 --dry-run을 전달한다", () => {
  const commands = [];
  const succeeded = publishPackage(
    "0.1.0",
    true,
    { status: "missing" },
    (command, args) => {
      commands.push([command, args]);
      return { status: 0 };
    },
  );

  assert.equal(succeeded, true);
  assert.deepEqual(commands[1], [
    "npm",
    ["publish", "./packages/bb-check", "--access", "public", "--dry-run"],
  ]);
});

test("인자가 없으면 메뉴를, --dry-run은 비대화형 배포를 선택한다", () => {
  assert.deepEqual(parsePublishArguments([]), {
    action: "menu",
    dryRun: false,
  });
  assert.deepEqual(parsePublishArguments(["--dry-run"]), {
    action: "publish",
    dryRun: true,
  });
  assert.deepEqual(parsePublishArguments(["--publish"]), {
    action: "publish",
    dryRun: false,
  });
  assert.throws(
    () => parsePublishArguments(["--force"]),
    /알 수 없는 인자입니다/,
  );
  assert.throws(
    () => parsePublishArguments(["--publish", "--publish"]),
    /--publish, --publish/,
  );
});

test("package 직접 배포 gate는 root release 검증 실패를 전파한다", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "bb-check-publish-gate-"));
  const marker = join(tempDir, "npm-args.json");
  const stub = join(tempDir, "npm-stub.mjs");
  const rootDirectory = resolve(import.meta.dirname, "..");
  const lookup = spawnSync(
    process.platform === "win32" ? "where" : "which",
    ["npm"],
    { encoding: "utf8" },
  );
  const realNpm = lookup.stdout.trim().split(/\r?\n/, 1)[0];

  try {
    await writeFile(
      stub,
      [
        "#!/usr/bin/env node",
        'import { writeFileSync } from "node:fs";',
        "writeFileSync(process.env.BB_CHECK_GATE_MARKER, JSON.stringify(process.argv.slice(2)));",
        "process.exitCode = 23;",
      ].join("\n"),
      "utf8",
    );

    if (process.platform === "win32") {
      await writeFile(
        join(tempDir, "npm.cmd"),
        `@node "${stub}" %*\r\n`,
        "utf8",
      );
    } else {
      const executable = join(tempDir, "npm");
      await writeFile(
        executable,
        `#!/bin/sh\nexec node "${stub}" "$@"\n`,
        "utf8",
      );
      await chmod(executable, 0o755);
    }

    const result = spawnSync(
      realNpm,
      ["run", "prepublishOnly", "--workspace=@cp949/bb-check"],
      {
        cwd: rootDirectory,
        encoding: "utf8",
        env: {
          ...process.env,
          BB_CHECK_GATE_MARKER: marker,
          PATH: `${tempDir}${delimiter}${process.env.PATH ?? ""}`,
        },
        shell: process.platform === "win32",
      },
    );

    assert.equal(existsSync(marker), true);
    assert.deepEqual(JSON.parse(await readFile(marker, "utf8")), [
      "--prefix",
      "../..",
      "run",
      "verify:package-release",
    ]);
    assert.notEqual(result.status, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
