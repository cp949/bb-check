import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, test } from "node:test";

import * as packageFiles from "./check-package-files.mjs";

const { checkPublicWorkspacePackages, discoverPublicWorkspacePackages } =
  packageFiles;

const temporaryDirs = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirs
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

const createRepo = async () => {
  const root = await mkdtemp(join(tmpdir(), "check-package-files-"));
  temporaryDirs.push(root);
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify(
      {
        private: true,
        workspaces: ["packages/*", "apps/*"],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return root;
};

const writePackage = async (root, workspacePath, manifest, artifacts = {}) => {
  const packageDir = join(root, workspacePath);
  await mkdir(packageDir, { recursive: true });
  await writeFile(
    join(packageDir, "package.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  for (const [path, source] of Object.entries(artifacts)) {
    const artifactPath = join(packageDir, path);
    await mkdir(join(artifactPath, ".."), { recursive: true });
    await writeFile(artifactPath, source, "utf8");
  }
};

const publicManifest = (name, exports) => ({
  name,
  version: "0.0.0",
  private: false,
  type: "module",
  files: ["dist/**", "README.md", "LICENSE", "package.json"],
  exports,
});

test("Windows npm은 shell 없이 npm CLI를 Node로 실행하고 node 명령은 유지한다", () => {
  assert.deepEqual(
    packageFiles.createCommandInvocation("npm", ["pack", "dynamic path"], {
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
    packageFiles.createCommandInvocation("node", ["-e", "dynamic value"], {
      platform: "win32",
      npmExecPath: "C:\\npm cli\\npm-cli.js",
      nodeExecPath: "C:\\node\\node.exe",
    }),
    { command: "node", args: ["-e", "dynamic value"] },
  );
  assert.deepEqual(
    packageFiles.createCommandInvocation("npm", ["pack"], {
      platform: "win32",
      npmExecPath: undefined,
      nodeExecPath: "C:\\Program Files\\nodejs\\node.exe",
    }),
    {
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: [
        "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
        "pack",
      ],
    },
  );
});

test("모든 공개 workspace를 workspace path 순서로 발견한다", async () => {
  const root = await createRepo();
  await writePackage(
    root,
    "packages/zeta",
    publicManifest("@fixture/zeta", { ".": "./dist/index.js" }),
  );
  await writePackage(root, "apps/private", {
    name: "private-fixture",
    private: true,
  });
  await writePackage(
    root,
    "apps/alpha",
    publicManifest("@fixture/alpha", { ".": "./dist/index.js" }),
  );

  const packages = await discoverPublicWorkspacePackages(root);

  assert.deepEqual(
    packages.map(({ workspacePath, manifest }) => [
      workspacePath,
      manifest.name,
    ]),
    [
      ["apps/alpha", "@fixture/alpha"],
      ["packages/zeta", "@fixture/zeta"],
    ],
  );
});

test("각 공개 package의 files, exports, declaration, sourcemap을 독립 검사한다", async () => {
  const root = await createRepo();
  await writePackage(
    root,
    "packages/broken",
    {
      ...publicManifest("@fixture/broken", {
        ".": "./dist/missing.js",
        "./typed": "./dist/typed.js",
        "./invalid": { import: 42 },
      }),
      files: ["dist/**", "secrets/**", "package.json"],
      dependencies: {
        alias: "npm:@cp949/bb-core@0.1.0",
      },
      peerDependencies: {
        "@cp949/bb-nextjs": "0.1.0",
      },
      optionalDependencies: {
        localFile: "file:../local-file",
        localLink: "link:../local-link",
        localWorkspace: "workspace:*",
      },
    },
    {
      "dist/typed.js":
        "export const value = 1;\n//# sourceMappingURL=typed.js.map\n",
      "dist/types.d.mts":
        "export declare const value: number;\n//# sourceMappingURL=types.d.mts.map\n",
      "dist/invalid.js.map": "{}\n",
      "README.md": "# broken\n",
      "secrets/token.txt": "fixture secret\n",
    },
  );
  await writePackage(
    root,
    "packages/complete",
    {
      ...publicManifest("@fixture/complete", {
        ".": {
          types: "./dist/index.d.ts",
          import: "./dist/index.js",
        },
      }),
      files: ["dist", "README.md", "LICENSE", "package.json"],
    },
    {
      "dist/index.js":
        "export const value = 1;\n//# sourceMappingURL=index.js.map\n",
      "dist/index.d.ts": "export declare const value = 1;\n",
      "dist/index.js.map":
        '{"version":3,"sources":[],"names":[],"mappings":""}\n',
      "README.md": "# complete\n",
      LICENSE: "fixture license\n",
    },
  );

  const packedByPackage = new Map([
    [
      "@fixture/broken",
      [
        "package.json",
        "README.md",
        "dist/typed.js",
        "dist/types.d.mts",
        "dist/invalid.js.map",
        "secrets/token.txt",
      ],
    ],
    [
      "@fixture/complete",
      [
        "package.json",
        "README.md",
        "LICENSE",
        "dist/index.js",
        "dist/index.d.ts",
        "dist/index.js.map",
      ],
    ],
  ]);
  const visited = [];

  const result = await checkPublicWorkspacePackages({
    repoRoot: root,
    readPackFiles: async ({ manifest }) => {
      visited.push(manifest.name);
      return packedByPackage.get(manifest.name);
    },
  });

  assert.deepEqual(visited, ["@fixture/broken", "@fixture/complete"]);
  assert.deepEqual(result.workspacePaths, [
    "packages/broken",
    "packages/complete",
  ]);
  assert.match(result.problems.join("\n"), /packages\/broken.*\[files\]/u);
  assert.match(result.problems.join("\n"), /packages\/broken.*\[exports\]/u);
  assert.match(
    result.problems.join("\n"),
    /packages\/broken.*condition key 순서는 types, import/u,
  );
  assert.match(
    result.problems.join("\n"),
    /packages\/broken.*\[declaration\]/u,
  );
  assert.match(result.problems.join("\n"), /packages\/broken.*\[sourcemap\]/u);
  assert.match(
    result.problems.join("\n"),
    /packages\/broken.*invalid\.js\.map.*version.*sources.*mappings/u,
  );
  assert.match(
    result.problems.join("\n"),
    /packages\/broken.*types\.d\.mts -> types\.d\.mts\.map/u,
  );
  assert.match(
    result.problems.join("\n"),
    /packages\/broken.*공개 allowlist.*secrets\/token\.txt/u,
  );
  assert.match(
    result.problems.join("\n"),
    /dependencies.*npm alias.*@cp949\/bb-core/u,
  );
  assert.match(
    result.problems.join("\n"),
    /peerDependencies.*@cp949\/bb-nextjs/u,
  );
  assert.match(
    result.problems.join("\n"),
    /optionalDependencies.*(?:file:|link:|workspace:)/u,
  );
  assert.doesNotMatch(result.problems.join("\n"), /packages\/complete/u);
});

test("exports top-level condition map은 저장소 공개 스키마로 거부한다", async () => {
  const root = await createRepo();
  await writePackage(
    root,
    "packages/mixed",
    publicManifest("@fixture/mixed", {
      ".": "./dist/index.js",
      import: "./dist/index.js",
    }),
    {
      "dist/index.js": "export const value = 1;\n",
      "dist/index.d.ts": "export declare const value = 1;\n",
      "README.md": "# mixed\n",
      LICENSE: "fixture license\n",
    },
  );

  const result = await checkPublicWorkspacePackages({
    repoRoot: root,
    readPackFiles: async () => [
      "package.json",
      "README.md",
      "LICENSE",
      "dist/index.js",
      "dist/index.d.ts",
    ],
  });

  assert.match(
    result.problems.join("\n"),
    /exports는 "\." root를 포함한 subpath map이어야 합니다/u,
  );
});

const checkExports = async (exports, { artifacts = {} } = {}) => {
  const root = await createRepo();
  const exportArtifacts = {
    "dist/index.js": "export const value = 1;\n",
    "dist/index.d.ts": "export declare const value: 1;\n",
    ...artifacts,
  };
  await writePackage(
    root,
    "packages/export-fixture",
    publicManifest("@fixture/exports", exports),
    {
      ...exportArtifacts,
      "README.md": "# exports fixture\n",
      LICENSE: "fixture license\n",
    },
  );
  return checkPublicWorkspacePackages({
    repoRoot: root,
    readPackFiles: async () => [
      "package.json",
      "README.md",
      "LICENSE",
      ...Object.keys(exportArtifacts),
    ],
  });
};

test("지원 스키마의 root/subpath 문자열과 정확한 types/import 쌍을 허용한다", async () => {
  const cases = [
    ["safe string exports", { ".": "./dist/index.js" }, {}],
    [
      "next-webpack-baseline condition exports",
      {
        ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
      },
      {},
    ],
    [
      "safe subpath map",
      {
        ".": "./dist/index.js",
        "./feature": "./dist/index.js",
      },
      {},
    ],
    [
      "mjs declaration pair",
      {
        ".": { types: "./dist/module.d.mts", import: "./dist/module.mjs" },
      },
      {
        "dist/module.mjs": "export const value = 1;\n",
        "dist/module.d.mts": "export declare const value: 1;\n",
      },
    ],
    [
      "cjs conventional declaration",
      { ".": "./dist/module.cjs" },
      {
        "dist/module.cjs": "exports.value = 1;\n",
        "dist/module.d.cts": "export declare const value: 1;\n",
      },
    ],
  ];

  for (const [name, exports, artifacts] of cases) {
    const result = await checkExports(exports, { artifacts });
    assert.doesNotMatch(
      result.problems.join("\n"),
      /\[(?:exports|declaration)\]/u,
      `${name}: ${result.problems.join("\n")}`,
    );
  }
});

test("삭제된 @cp949/bb-check package가 다시 생기면 공개 검증을 우회하지 못한다", async () => {
  const root = await createRepo();
  await writePackage(root, "packages/bb-check", {
    ...publicManifest("@cp949/bb-check", null),
  });
  await writePackage(
    root,
    "packages/next-webpack-baseline",
    publicManifest("@cp949/next-webpack-baseline", {
      ".": {
        types: "./dist/index.d.ts",
        import: "./dist/index.js",
      },
    }),
    {
      "dist/index.js": "export const value = 1;\n",
      "dist/index.d.ts": "export declare const value: 1;\n",
      "README.md": "# active package\n",
      LICENSE: "fixture license\n",
    },
  );

  const visited = [];
  const result = await checkPublicWorkspacePackages({
    repoRoot: root,
    readPackFiles: async ({ manifest }) => {
      visited.push(manifest.name);
      return [
        "package.json",
        "README.md",
        "LICENSE",
        "dist/index.js",
        "dist/index.d.ts",
      ];
    },
  });

  assert.deepEqual(visited, [
    "@cp949/bb-check",
    "@cp949/next-webpack-baseline",
  ]);
  assert.deepEqual(result.workspacePaths, [
    "packages/bb-check",
    "packages/next-webpack-baseline",
  ]);
  assert.match(result.problems.join("\n"), /packages\/bb-check \[exports\]/u);
});

test("필수 next-webpack-baseline workspace identity를 fail-closed로 검증한다", async () => {
  for (const [name, manifest, expected] of [
    ["missing", undefined, /필수 공개 package가 없습니다/u],
    [
      "renamed",
      publicManifest("@fixture/renamed", { ".": "./dist/index.js" }),
      /package name.*@cp949\/next-webpack-baseline/u,
    ],
    [
      "private",
      {
        ...publicManifest("@cp949/next-webpack-baseline", {
          ".": "./dist/index.js",
        }),
        private: true,
      },
      /private는 false/u,
    ],
  ]) {
    const root = await createRepo();
    if (manifest !== undefined) {
      await writePackage(root, "packages/next-webpack-baseline", manifest);
    }
    let packCalls = 0;

    const result = await checkPublicWorkspacePackages({
      repoRoot: root,
      readPackFiles: async () => {
        packCalls += 1;
        return [];
      },
    });

    assert.equal(packCalls, 0, name);
    assert.match(result.problems.join("\n"), expected, name);
  }

  const root = await createRepo();
  const manifest = publicManifest("@cp949/next-webpack-baseline", {
    ".": "./dist/index.js",
  });
  const artifacts = {
    "dist/index.js": "export const value = 1;\n",
    "dist/index.d.ts": "export declare const value: 1;\n",
    "README.md": "# active package\n",
    LICENSE: "fixture license\n",
  };
  await writePackage(
    root,
    "packages/next-webpack-baseline",
    manifest,
    artifacts,
  );
  await writePackage(root, "apps/duplicate-name", manifest, artifacts);

  const duplicateResult = await checkPublicWorkspacePackages({
    repoRoot: root,
    readPackFiles: async () => [
      "package.json",
      "README.md",
      "LICENSE",
      "dist/index.js",
      "dist/index.d.ts",
    ],
  });

  assert.match(
    duplicateResult.problems.join("\n"),
    /package name.*정확히 한 workspace/u,
  );
});

test("top-level과 subpath value의 지원하지 않는 exports 형상을 fail-closed로 거부한다", async () => {
  const cases = [
    ["top-level string", "./dist/index.js", /subpath map/u],
    ["top-level array", ["./dist/index.js"], /subpath map/u],
    ["top-level null", null, /subpath map/u],
    ["empty map", {}, /subpath map/u],
    ["missing root", { "./feature": "./dist/index.js" }, /subpath map/u],
    ["subpath array", { ".": ["./dist/index.js"] }, /runtime 문자열/u],
    ["subpath null", { ".": null }, /runtime 문자열/u],
    [
      "nested condition",
      {
        ".": {
          types: "./dist/index.d.ts",
          import: { node: "./dist/index.js" },
        },
      },
      /import target/u,
    ],
    [
      "integer condition",
      { ".": { 0: "./dist/index.js", import: "./dist/index.js" } },
      /condition key 순서는 types, import/u,
    ],
  ];

  for (const [name, exports, expected] of cases) {
    const result = await checkExports(exports);
    assert.match(
      result.problems.join("\n"),
      expected,
      `${name}: ${result.problems.join("\n")}`,
    );
  }
});

test("custom condition과 types/import key 누락·추가·역순을 거부한다", async () => {
  const unsupportedConditions = [
    "node-addons",
    "module-sync",
    "types@>=5",
    "default",
    "browser",
  ];
  for (const condition of unsupportedConditions) {
    const result = await checkExports({
      ".": {
        types: "./dist/index.d.ts",
        import: "./dist/index.js",
        [condition]: "./dist/index.js",
      },
    });
    assert.match(
      result.problems.join("\n"),
      /condition key 순서는 types, import/u,
      condition,
    );
  }

  for (const [name, value] of [
    ["types only", { types: "./dist/index.d.ts" }],
    ["import only", { import: "./dist/index.js" }],
    [
      "reverse order",
      { import: "./dist/index.js", types: "./dist/index.d.ts" },
    ],
  ]) {
    const result = await checkExports({ ".": value });
    assert.match(
      result.problems.join("\n"),
      /condition key 순서는 types, import/u,
      name,
    );
  }
});

test("unsafe subpath key를 안정적인 exports 진단으로 거부한다", async () => {
  const keys = [
    ".foo",
    "./",
    "./feature/*",
    "./feature\\child",
    "./feature%2Fchild",
    "./feature?query",
    "./feature#fragment",
    "./feature/./child",
    "./feature/../child",
    "./node_modules/child",
  ];

  for (const key of keys) {
    const result = await checkExports({
      ".": "./dist/index.js",
      [key]: "./dist/index.js",
    });
    assert.ok(
      result.problems
        .join("\n")
        .includes(`지원하지 않는 subpath key입니다: ${JSON.stringify(key)}`),
      `${key}: ${result.problems.join("\n")}`,
    );
  }
});

test("runtime과 declaration target을 ./dist 안전 경로와 대응 확장자로 제한한다", async () => {
  const unsafeRuntimeTargets = [
    "dist/index.js",
    "../dist/index.js",
    "/dist/index.js",
    "https://example.test/index.js",
    "./src/index.js",
    "./dist\\index.js",
    "./dist/%69ndex.js",
    "./dist/./index.js",
    "./dist/../index.js",
    "./dist/node_modules/pkg/index.js",
    "./dist/*.js",
    "./dist/index.ts",
  ];
  for (const target of unsafeRuntimeTargets) {
    const result = await checkExports({ ".": target });
    assert.match(result.problems.join("\n"), /runtime target/u, target);
  }

  for (const [name, value, expected] of [
    [
      "types runtime extension",
      { types: "./dist/index.js", import: "./dist/index.js" },
      /types target/u,
    ],
    [
      "import declaration extension",
      { types: "./dist/index.d.ts", import: "./dist/index.d.ts" },
      /import target/u,
    ],
    [
      "mismatched declaration extension",
      { types: "./dist/index.d.mts", import: "./dist/index.js" },
      /types target 확장자/u,
    ],
    [
      "unsafe declaration path",
      { types: "./types/index.d.ts", import: "./dist/index.js" },
      /types target/u,
    ],
  ]) {
    const result = await checkExports({ ".": value });
    assert.match(result.problems.join("\n"), expected, name);
  }
});

test("runtime과 declaration target의 URL query와 fragment를 거부한다", async () => {
  for (const marker of ["?query", "#fragment"]) {
    const runtimeTarget = `./dist/index${marker}.js`;
    const runtimeResult = await checkExports(
      { ".": runtimeTarget },
      {
        artifacts: {
          [`dist/index${marker}.js`]: "export const value = 1;\n",
          [`dist/index${marker}.d.ts`]: "export declare const value: 1;\n",
        },
      },
    );
    assert.match(
      runtimeResult.problems.join("\n"),
      /runtime target/u,
      runtimeTarget,
    );

    const declarationTarget = `./dist/index${marker}.d.ts`;
    const declarationResult = await checkExports(
      {
        ".": {
          types: declarationTarget,
          import: "./dist/index.js",
        },
      },
      {
        artifacts: {
          [`dist/index${marker}.d.ts`]: "export declare const value: 1;\n",
        },
      },
    );
    assert.match(
      declarationResult.problems.join("\n"),
      /types target/u,
      declarationTarget,
    );
  }
});

test("dependency 필드의 prefix 없는 POSIX와 Windows local path를 거부한다", async () => {
  const root = await createRepo();
  await writePackage(
    root,
    "packages/local-dependencies",
    {
      ...publicManifest("@fixture/local-dependencies", {
        ".": "./dist/index.js",
      }),
      dependencies: {
        parentRelative: "../local",
        currentRelative: "./local",
        posixAbsolute: "/opt/local",
        homeShorthand: "~",
      },
      peerDependencies: {
        windowsRooted: "\\local",
        windowsUnc: "\\\\server\\share",
        homePath: "~/local",
      },
      optionalDependencies: {
        windowsDriveAbsolute: "C:\\local",
        windowsDriveRelative: "C:local",
        homeWindowsPath: "~\\local",
      },
    },
    {
      "dist/index.js": "export const value = 1;\n",
      "dist/index.d.ts": "export declare const value = 1;\n",
      "README.md": "# local dependencies\n",
      LICENSE: "fixture license\n",
    },
  );

  const result = await checkPublicWorkspacePackages({
    repoRoot: root,
    readPackFiles: async () => [
      "package.json",
      "README.md",
      "LICENSE",
      "dist/index.js",
      "dist/index.d.ts",
    ],
  });
  const problems = result.problems.join("\n");

  for (const dependency of [
    "parentRelative",
    "currentRelative",
    "posixAbsolute",
    "windowsRooted",
    "windowsUnc",
    "windowsDriveAbsolute",
    "windowsDriveRelative",
    "homePath",
    "homeWindowsPath",
  ]) {
    assert.match(problems, new RegExp(`${dependency}.*local path`, "u"));
  }
  assert.doesNotMatch(problems, /homeShorthand.*local path/u);
});

test("bin target이 tarball에 없으면 string/object 두 형태 모두 문제로 보고한다", async () => {
  const cases = [
    ["bin string 형태", "./bin/cli.mjs"],
    ["bin object 형태", { cli: "./bin/cli.mjs" }],
  ];

  for (const [name, bin] of cases) {
    const root = await createRepo();
    await writePackage(
      root,
      "packages/bin-missing",
      {
        ...publicManifest("@fixture/bin-missing", { ".": "./dist/index.js" }),
        bin,
      },
      {
        "dist/index.js": "export const value = 1;\n",
        "dist/index.d.ts": "export declare const value: 1;\n",
        "README.md": "# bin missing\n",
        LICENSE: "fixture license\n",
      },
    );

    const result = await checkPublicWorkspacePackages({
      repoRoot: root,
      readPackFiles: async () => [
        "package.json",
        "README.md",
        "LICENSE",
        "dist/index.js",
        "dist/index.d.ts",
      ],
    });

    assert.match(
      result.problems.join("\n"),
      /bin target이 tarball에 없습니다: bin\/cli\.mjs/u,
      name,
    );
  }
});

test("bin target은 있지만 declaration이 tarball에 없으면 문제로 보고한다", async () => {
  const root = await createRepo();
  await writePackage(
    root,
    "packages/bin-no-declaration",
    {
      ...publicManifest("@fixture/bin-no-declaration", {
        ".": "./dist/index.js",
      }),
      files: ["dist/**", "bin/**", "README.md", "LICENSE", "package.json"],
      bin: { cli: "./bin/cli.mjs" },
    },
    {
      "dist/index.js": "export const value = 1;\n",
      "dist/index.d.ts": "export declare const value: 1;\n",
      "README.md": "# bin no declaration\n",
      LICENSE: "fixture license\n",
      "bin/cli.mjs": "#!/usr/bin/env node\nexport {};\n",
    },
  );

  const result = await checkPublicWorkspacePackages({
    repoRoot: root,
    readPackFiles: async () => [
      "package.json",
      "README.md",
      "LICENSE",
      "dist/index.js",
      "dist/index.d.ts",
      "bin/cli.mjs",
    ],
  });

  assert.match(
    result.problems.join("\n"),
    /bin target의 declaration이 없습니다: bin\/cli\.mjs/u,
  );
  assert.doesNotMatch(
    result.problems.join("\n"),
    /bin target이 tarball에 없습니다/u,
  );
});

test("bin target과 declaration이 모두 있으면 문제가 없다", async () => {
  const root = await createRepo();
  await writePackage(
    root,
    "packages/bin-complete",
    {
      ...publicManifest("@fixture/bin-complete", { ".": "./dist/index.js" }),
      files: ["dist/**", "bin/**", "README.md", "LICENSE", "package.json"],
      bin: { cli: "./bin/cli.mjs" },
    },
    {
      "dist/index.js": "export const value = 1;\n",
      "dist/index.d.ts": "export declare const value: 1;\n",
      "README.md": "# bin complete\n",
      LICENSE: "fixture license\n",
      "bin/cli.mjs": "#!/usr/bin/env node\nexport {};\n",
      "bin/cli.d.mts": "export {};\n",
    },
  );

  const result = await checkPublicWorkspacePackages({
    repoRoot: root,
    readPackFiles: async () => [
      "package.json",
      "README.md",
      "LICENSE",
      "dist/index.js",
      "dist/index.d.ts",
      "bin/cli.mjs",
      "bin/cli.d.mts",
    ],
  });

  assert.doesNotMatch(result.problems.join("\n"), /packages\/bin-complete/u);
});

test("next-webpack-baseline generated LICENSE는 Git ignore 대상이다", () => {
  const repoRoot = new URL("..", import.meta.url);
  const path = "packages/next-webpack-baseline/LICENSE";
  const result = spawnSync("git", ["check-ignore", "-q", path], {
    cwd: repoRoot,
  });
  assert.equal(result.status, 0, `${path}가 ignore되지 않았다.`);
});
