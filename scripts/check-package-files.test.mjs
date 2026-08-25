import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  checkPublicWorkspacePackages,
  discoverPublicWorkspacePackages,
} from "./check-package-files.mjs";

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
      }),
      files: ["dist/**", "package.json"],
    },
    {
      "dist/typed.js":
        "export const value = 1;\n//# sourceMappingURL=typed.js.map\n",
      "README.md": "# broken\n",
    },
  );
  await writePackage(
    root,
    "packages/complete",
    publicManifest("@fixture/complete", {
      ".": {
        types: "./dist/index.d.ts",
        import: "./dist/index.js",
      },
    }),
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
    ["@fixture/broken", ["package.json", "README.md", "dist/typed.js"]],
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
    /packages\/broken.*\[declaration\]/u,
  );
  assert.match(result.problems.join("\n"), /packages\/broken.*\[sourcemap\]/u);
  assert.doesNotMatch(result.problems.join("\n"), /packages\/complete/u);
});
