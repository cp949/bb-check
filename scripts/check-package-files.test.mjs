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
});

test("모든 공개 workspace를 workspace path 순서로 발견한다", async () => {
  const root = await createRepo();
  await writePackage(
    root,
    "packages/zeta",
    publicManifest("@fixture/zeta", "./dist/index.js"),
  );
  await writePackage(root, "apps/private", {
    name: "private-fixture",
    private: true,
  });
  await writePackage(
    root,
    "apps/alpha",
    publicManifest("@fixture/alpha", "./dist/index.js"),
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
          development: null,
        },
        "./fallback": [null, "./dist/index.js"],
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
    /packages\/broken.*invalid export target type/u,
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

test("exports의 subpath key와 condition key를 섞으면 거부한다", async () => {
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

  assert.match(result.problems.join("\n"), /subpath.*condition.*혼합/u);
});

test("두 공개 package의 generated LICENSE는 Git ignore 대상이다", () => {
  const repoRoot = new URL("..", import.meta.url);
  for (const path of [
    "packages/bb-check/LICENSE",
    "packages/next-webpack-baseline/LICENSE",
  ]) {
    const result = spawnSync("git", ["check-ignore", "-q", path], {
      cwd: repoRoot,
    });
    assert.equal(result.status, 0, `${path}가 ignore되지 않았다.`);
  }
});
