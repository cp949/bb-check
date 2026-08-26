import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import test from "node:test";

import {
  classifyRegistryVersionResult,
  collectExportPaths,
  createCommandInvocation,
  describeRegistryLookup,
  displayWidth,
  formatTagMessage,
  parsePublishArguments,
  planPublish,
  planTagPush,
  publishPackage,
  selectPublishPackage,
  shortPackageName,
  statusMark,
  validatePublishLifecycle,
} from "./publish-package.mjs";

const releaseEnvironment = {
  BB_CHECK_FORBIDDEN_WORDS: "synthetic-release-pattern",
};

test("인자가 없으면 대화형 메뉴를 선택한다", () => {
  assert.deepEqual(parsePublishArguments([]), { menu: true });
});

test("명시적 인자를 하나라도 주면 package 이름을 반드시 요구한다", () => {
  assert.throws(() => parsePublishArguments(["--dry-run"]), /--package/);
});

test("허용하지 않은 package와 private package를 거부한다", () => {
  assert.throws(
    () => selectPublishPackage("@cp949/unknown", { private: false }),
    /허용하지 않은 package/,
  );
  assert.throws(
    () =>
      selectPublishPackage("@cp949/next-webpack-baseline", { private: true }),
    /private package/,
  );
  assert.throws(
    () =>
      selectPublishPackage("@cp949/next-webpack-baseline", { private: false }),
    /manifest와 일치하지 않습니다/,
  );
});

test("명시한 공개 package는 dry-run을 기본값으로 선택한다", () => {
  assert.deepEqual(
    parsePublishArguments(["--package", "@cp949/next-webpack-baseline"]),
    {
      packageName: "@cp949/next-webpack-baseline",
      dryRun: true,
      confirmed: false,
    },
  );
});

test("실제 publish는 publish와 confirm 플래그를 모두 요구한다", () => {
  assert.throws(
    () =>
      parsePublishArguments([
        "--package",
        "@cp949/next-webpack-baseline",
        "--publish",
      ]),
    /--confirm-publish/,
  );
  assert.deepEqual(
    parsePublishArguments([
      "--package",
      "@cp949/next-webpack-baseline",
      "--publish",
      "--confirm-publish",
    ]),
    {
      packageName: "@cp949/next-webpack-baseline",
      dryRun: false,
      confirmed: true,
    },
  );
});

test("action flag의 중복과 dry-run/publish 모순을 거부한다", () => {
  for (const duplicated of ["--dry-run", "--publish", "--confirm-publish"]) {
    assert.throws(
      () =>
        parsePublishArguments([
          "--package",
          "@cp949/next-webpack-baseline",
          duplicated,
          duplicated,
        ]),
      /중복/u,
    );
  }
  assert.throws(
    () =>
      parsePublishArguments([
        "--package",
        "@cp949/next-webpack-baseline",
        "--dry-run",
        "--publish",
        "--confirm-publish",
      ]),
    /함께 사용할 수 없습니다/u,
  );
});

test("CLI도 모순된 action flag를 registry 조회 전에 거부한다", () => {
  const result = spawnSync(
    process.execPath,
    [
      resolve(import.meta.dirname, "publish-package.mjs"),
      "--package",
      "@cp949/next-webpack-baseline",
      "--dry-run",
      "--publish",
      "--confirm-publish",
    ],
    { encoding: "utf8" },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /함께 사용할 수 없습니다/u);
});

test("actual CLI는 secret이 없으면 registry 조회 전에 거부한다", () => {
  const result = spawnSync(
    process.execPath,
    [
      resolve(import.meta.dirname, "publish-package.mjs"),
      "--package",
      "@cp949/next-webpack-baseline",
      "--publish",
      "--confirm-publish",
    ],
    {
      encoding: "utf8",
      env: { ...process.env, BB_CHECK_FORBIDDEN_WORDS: "" },
    },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /BB_CHECK_FORBIDDEN_WORDS/u);
});

test("package lifecycle은 direct actual을 막고 dry-run 또는 wrapper marker만 허용한다", () => {
  assert.throws(
    () => validatePublishLifecycle({}),
    /NWB_PUBLISH_DIRECT_DENIED/u,
  );
  assert.doesNotThrow(() =>
    validatePublishLifecycle({ npm_config_dry_run: "true" }),
  );
  assert.doesNotThrow(() =>
    validatePublishLifecycle({ NWB_PUBLISH_CONFIRMED: "1" }),
  );
});

test("실제 publish 함수도 confirmation 없이는 명령을 실행하지 않는다", () => {
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

  assert.equal(succeeded, false);
  assert.deepEqual(commands, []);
});

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

test("배포 전에 next package 전용 release 검증을 실행한다", () => {
  const commands = [];
  let publishEnvironment;
  const succeeded = publishPackage(
    "0.1.0",
    false,
    { status: "missing" },
    (command, args, options) => {
      commands.push([command, args]);
      if (args[0] === "publish") publishEnvironment = options.env;
      return { status: 0 };
    },
    undefined,
    true,
    releaseEnvironment,
  );

  assert.equal(succeeded, true);
  assert.deepEqual(commands, [
    ["npm", ["run", "verify:next-release"]],
    ["npm", ["run", "check-public-words", "--", "--release"]],
    ["npm", ["whoami"]],
    [
      "npm",
      ["publish", "./packages/next-webpack-baseline", "--access", "public"],
    ],
  ]);
  assert.equal(publishEnvironment.NWB_PUBLISH_CONFIRMED, "1");
  assert.equal(
    publishEnvironment.BB_CHECK_FORBIDDEN_WORDS,
    releaseEnvironment.BB_CHECK_FORBIDDEN_WORDS,
  );
});

test("선택한 package는 자신의 verify script를 함께 돌려준다", () => {
  assert.deepEqual(
    selectPublishPackage("@cp949/next-webpack-baseline", {
      name: "@cp949/next-webpack-baseline",
    }),
    {
      packageName: "@cp949/next-webpack-baseline",
      packageDirectory: "packages/next-webpack-baseline",
      publishSpec: "./packages/next-webpack-baseline",
      verifyScript: "verify:next-release",
    },
  );
});

test("legacy-browser-smoke도 허용 package로 등록되어 있다", () => {
  assert.deepEqual(
    selectPublishPackage("@cp949/legacy-browser-smoke", {
      name: "@cp949/legacy-browser-smoke",
    }),
    {
      packageName: "@cp949/legacy-browser-smoke",
      packageDirectory: "packages/legacy-browser-smoke",
      publishSpec: "./packages/legacy-browser-smoke",
      verifyScript: "verify:package-release",
    },
  );
});

test("release 검증 script는 하드코딩이 아니라 선택된 package에서 온다", () => {
  const commands = [];
  const succeeded = publishPackage(
    "0.1.0",
    true,
    { status: "missing" },
    (command, args) => {
      commands.push([command, args]);
      return { status: 0 };
    },
    {
      packageName: "@cp949/other-package",
      publishSpec: "./packages/other-package",
      verifyScript: "verify:other-release",
    },
  );

  assert.equal(succeeded, true);
  assert.deepEqual(commands, [
    ["npm", ["run", "verify:other-release"]],
    [
      "npm",
      [
        "publish",
        "./packages/other-package",
        "--access",
        "public",
        "--dry-run",
      ],
    ],
  ]);
});

test("verify script가 없는 package 선택은 어떤 명령도 실행하지 않는다", () => {
  const commands = [];
  const succeeded = publishPackage(
    "0.1.0",
    true,
    { status: "missing" },
    (command, args) => {
      commands.push([command, args]);
      return { status: 0 };
    },
    {
      packageName: "@cp949/other-package",
      publishSpec: "./packages/other-package",
    },
  );

  assert.equal(succeeded, false);
  assert.deepEqual(commands, []);
});

test("실제 배포는 npm 인증 실패 시 publish를 실행하지 않는다", () => {
  const commands = [];
  const succeeded = publishPackage(
    "0.1.0",
    false,
    { status: "missing" },
    (command, args) => {
      commands.push([command, args]);
      return { status: commands.length === 3 ? 1 : 0 };
    },
    undefined,
    true,
    releaseEnvironment,
  );

  assert.equal(succeeded, false);
  assert.deepEqual(commands, [
    ["npm", ["run", "verify:next-release"]],
    ["npm", ["run", "check-public-words", "--", "--release"]],
    ["npm", ["whoami"]],
  ]);
});

test("실제 publish는 secret이 없거나 release scan이 실패하면 publish에 도달하지 않는다", () => {
  const withoutSecret = [];
  assert.equal(
    publishPackage(
      "0.1.0",
      false,
      { status: "missing" },
      (command, args) => {
        withoutSecret.push([command, args]);
        return { status: 0 };
      },
      undefined,
      true,
      {},
    ),
    false,
  );
  assert.deepEqual(withoutSecret, []);

  const failedScan = [];
  assert.equal(
    publishPackage(
      "0.1.0",
      false,
      { status: "missing" },
      (command, args) => {
        failedScan.push([command, args]);
        return { status: failedScan.length === 2 ? 19 : 0 };
      },
      undefined,
      true,
      releaseEnvironment,
    ),
    false,
  );
  assert.deepEqual(failedScan, [
    ["npm", ["run", "verify:next-release"]],
    ["npm", ["run", "check-public-words", "--", "--release"]],
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
  assert.deepEqual(commands, [["npm", ["run", "verify:next-release"]]]);
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
    [
      "publish",
      "./packages/next-webpack-baseline",
      "--access",
      "public",
      "--dry-run",
    ],
  ]);
});

test("알 수 없는 인자와 중복 package 선택을 거부한다", () => {
  assert.throws(
    () =>
      parsePublishArguments([
        "--package",
        "@cp949/next-webpack-baseline",
        "--force",
      ]),
    /알 수 없는 인자입니다/,
  );
  assert.throws(
    () =>
      parsePublishArguments([
        "--package",
        "@cp949/next-webpack-baseline",
        "--package",
        "@cp949/next-webpack-baseline",
      ]),
    /하나만/,
  );
});

test("package lifecycle은 direct actual을 차단하고 wrapper/dry-run만 검증으로 보낸다", async () => {
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

    const runLifecycle = (extraEnv = {}) =>
      spawnSync(
        realNpm,
        ["run", "prepublishOnly", "--workspace=@cp949/next-webpack-baseline"],
        {
          cwd: rootDirectory,
          encoding: "utf8",
          env: {
            ...process.env,
            BB_CHECK_GATE_MARKER: marker,
            PATH: `${tempDir}${delimiter}${process.env.PATH ?? ""}`,
            ...extraEnv,
          },
          shell: process.platform === "win32",
        },
      );

    const directActual = runLifecycle({
      npm_config_dry_run: "",
      NWB_PUBLISH_CONFIRMED: "",
    });
    assert.notEqual(directActual.status, 0);
    assert.match(directActual.stderr, /NWB_PUBLISH_DIRECT_DENIED/u);
    assert.equal(existsSync(marker), false);

    const wrapperActual = runLifecycle({ NWB_PUBLISH_CONFIRMED: "1" });
    assert.equal(existsSync(marker), true);
    assert.deepEqual(JSON.parse(await readFile(marker, "utf8")), [
      "--prefix",
      "../..",
      "run",
      "verify:next-release",
    ]);
    assert.notEqual(wrapperActual.status, 0);

    await rm(marker, { force: true });
    const directDryRun = runLifecycle({ npm_config_dry_run: "true" });
    assert.equal(existsSync(marker), true);
    assert.deepEqual(JSON.parse(await readFile(marker, "utf8")), [
      "--prefix",
      "../..",
      "run",
      "verify:next-release",
    ]);
    assert.notEqual(directDryRun.status, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("exports의 문자열 leaf만 중복 없이 모은다", () => {
  assert.deepEqual(
    collectExportPaths({
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
      "./extra": "./dist/index.js",
    }),
    ["./dist/index.d.ts", "./dist/index.js"],
  );
  assert.deepEqual(collectExportPaths(undefined), []);
});

test("한글은 표시 폭을 두 칸으로 센다", () => {
  assert.equal(displayWidth("ab"), 2);
  assert.equal(displayWidth("가나"), 4);
});

test("registry 조회 결과를 사람이 읽을 문구로 바꾼다", () => {
  assert.equal(
    describeRegistryLookup({ status: "published", version: "0.1.0" }),
    "0.1.0",
  );
  assert.equal(describeRegistryLookup({ status: "missing" }), "미배포");
  assert.equal(
    describeRegistryLookup({ status: "error", reason: "EAI_AGAIN" }),
    "조회 실패(EAI_AGAIN)",
  );
});

test("registry version이 로컬과 같을 때만 배포됨으로 표시한다", () => {
  assert.equal(
    statusMark({ status: "published", version: "0.1.0" }, "0.1.0"),
    "배포됨",
  );
  assert.equal(
    statusMark({ status: "published", version: "0.0.9" }, "0.1.0"),
    "대상",
  );
  assert.equal(statusMark({ status: "missing" }, "0.1.0"), "대상");
});

test("태그 이름은 scope를 뺀 package 이름을 쓴다", () => {
  assert.equal(
    shortPackageName("@cp949/next-webpack-baseline"),
    "next-webpack-baseline",
  );
  assert.equal(shortPackageName("unscoped-package"), "unscoped-package");
});

test("태그 메시지에 package와 version을 적는다", () => {
  assert.equal(
    formatTagMessage("@cp949/next-webpack-baseline", "0.1.0"),
    "@cp949/next-webpack-baseline@0.1.0",
  );
});

test("태그가 없으면 만들고 push한다", () => {
  assert.deepEqual(
    planTagPush({
      tagName: "next-webpack-baseline@0.1.0",
      workingTreeDirty: false,
      tagCommit: null,
      headCommit: "abc",
    }),
    { action: "create-and-push", tagName: "next-webpack-baseline@0.1.0" },
  );
});

test("태그가 이미 HEAD를 가리키면 push만 한다", () => {
  assert.deepEqual(
    planTagPush({
      tagName: "next-webpack-baseline@0.1.0",
      workingTreeDirty: false,
      tagCommit: "abc",
      headCommit: "abc",
    }),
    { action: "push-only", tagName: "next-webpack-baseline@0.1.0" },
  );
});

test("작업 트리가 더러우면 태그를 만들지 않는다", () => {
  assert.equal(
    planTagPush({
      tagName: "next-webpack-baseline@0.1.0",
      workingTreeDirty: true,
      tagCommit: null,
      headCommit: "abc",
    }).action,
    "abort",
  );
});

test("태그가 다른 커밋을 가리키면 태그를 건드리지 않는다", () => {
  const plan = planTagPush({
    tagName: "next-webpack-baseline@0.1.0",
    workingTreeDirty: false,
    tagCommit: "def",
    headCommit: "abc",
  });
  assert.equal(plan.action, "abort");
  assert.match(plan.reason, /이미 다른 커밋/);
});
