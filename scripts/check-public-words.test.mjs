// check-public-words.mjs가 내보내는 runScanner(binary-safe 공개 정보
// scanner의 핵심 primitive)를 검증한다. 실제 forbidden pattern은 이
// 저장소 어디에도 하드코딩하지 않는다 — 아래 모든 테스트는 만든
// 예시(synthetic) pattern만 쓴다. 이 테스트는 vitest가 아니라 Node의
// 내장 test runner로 돈다(root package.json의 "test"는 이 파일을
// --exclude로 제외한다) — `node --test scripts/check-public-words.test.mjs`.

import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  listPublicPackageDirs,
  listTrackedFiles,
  runScanner,
} from "./check-public-words.mjs";

const scriptPath = fileURLToPath(
  new URL("./check-public-words.mjs", import.meta.url),
);
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// 공개 파일에 없는 합성 pattern은 source에 완성된 문자열을 남기지 않도록
// 두 조각으로 나눠 런타임에만 이어 붙인다.
const ABSENT_SYNTHETIC_PATTERN = ["zz-test-forbidden", "-token-9f3c"].join("");

test("공개 tarball scan 대상은 next webpack baseline 하나다", async () => {
  assert.deepEqual(
    (await listPublicPackageDirs()).map((path) =>
      relative(repoRoot, path).replaceAll("\\", "/"),
    ),
    ["packages/next-webpack-baseline"],
  );
});

test("tracked scan은 공개 README와 next package 파일로 제한한다", () => {
  const files = listTrackedFiles();
  assert.ok(files.includes("README.md"));
  assert.ok(files.includes("packages/next-webpack-baseline/README.md"));
  assert.ok(
    files.every(
      (file) =>
        file === "README.md" ||
        file.startsWith("packages/next-webpack-baseline/"),
    ),
  );
});

describe("runScanner", () => {
  let fixtureDir;

  before(async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), "bb-check-public-words-"));
    await writeFile(
      join(fixtureDir, "README.md"),
      ["# fixture", "internal codename: private-product", "그 외 내용"].join(
        "\n",
      ),
      "utf8",
    );
  });

  after(async () => {
    await rm(fixtureDir, { recursive: true, force: true });
  });

  test("추적 파일과 tarball의 금지 pattern을 보고한다", async () => {
    const result = await runScanner({
      roots: [fixtureDir],
      patterns: ["private-product"],
    });
    assert.deepEqual(result.matches, [
      { file: "README.md", line: 2, pattern: "private-product" },
    ]);
  });

  test("일치하는 pattern이 없으면 matches가 빈 배열이다", async () => {
    const result = await runScanner({
      roots: [fixtureDir],
      patterns: ["zz-no-such-pattern-9f3c"],
    });
    assert.deepEqual(result.matches, []);
  });

  test("한 줄에 여러 pattern이 있으면 각각 보고한다", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bb-check-public-words-multi-"));
    try {
      await writeFile(
        join(dir, "notes.txt"),
        "alpha-secret and beta-secret on one line\n",
        "utf8",
      );
      const result = await runScanner({
        roots: [dir],
        patterns: ["alpha-secret", "beta-secret"],
      });
      assert.deepEqual(
        result.matches.map(({ file, line, pattern }) => ({
          file,
          line,
          pattern,
        })),
        [
          { file: "notes.txt", line: 1, pattern: "alpha-secret" },
          { file: "notes.txt", line: 1, pattern: "beta-secret" },
        ],
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("runScanner: binary-safe", () => {
  test("NUL byte가 있는 파일은 matches 없이 skipped에만 보고한다", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bb-check-public-words-binary-"));
    try {
      const binaryContent = Buffer.concat([
        Buffer.from("private-product\0", "utf8"),
        Buffer.from([0xff, 0xfe, 0x00, 0x01]),
      ]);
      await writeFile(join(dir, "asset.bin"), binaryContent);
      await writeFile(join(dir, "README.md"), "private-product\n", "utf8");

      const result = await runScanner({
        roots: [dir],
        patterns: ["private-product"],
      });

      assert.deepEqual(result.skipped, ["asset.bin"]);
      assert.deepEqual(result.matches, [
        { file: "README.md", line: 1, pattern: "private-product" },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("runScanner: 파일 root(tracked file / tarball 파일 사용을 흉내)", () => {
  test("파일 root는 넘겨준 문자열을 그대로 file로 보고한다", async () => {
    const dir = await mkdtemp(
      join(tmpdir(), "bb-check-public-words-fileroot-"),
    );
    try {
      await mkdir(join(dir, "packages", "pkg", "dist"), { recursive: true });
      const trackedFile = join(dir, "README.md");
      const tarballFile = join(dir, "packages", "pkg", "dist", "index.js");
      await writeFile(trackedFile, "private-product\n", "utf8");
      await writeFile(tarballFile, "// private-product\n", "utf8");

      // 실제 check-public-words.mjs가 하는 것과 같은 방식으로, git
      // ls-files류 경로("README.md")와 npm pack류 경로
      // ("packages/pkg/dist/index.js")를 파일 root로 직접 넘긴다.
      const result = await runScanner({
        roots: ["README.md", "packages/pkg/dist/index.js"],
        patterns: ["private-product"],
        cwd: dir,
      });

      assert.deepEqual(
        result.matches.map(({ file, line, pattern }) => ({
          file,
          line,
          pattern,
        })),
        [
          { file: "README.md", line: 1, pattern: "private-product" },
          {
            file: "packages/pkg/dist/index.js",
            line: 1,
            pattern: "private-product",
          },
        ],
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("check-public-words.mjs CLI: --release 모드", () => {
  test("BB_CHECK_FORBIDDEN_WORDS가 비어 있으면 BB_PUBLIC_WORDS_MISSING으로 실패한다", () => {
    const result = spawnSync(process.execPath, [scriptPath, "--release"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, BB_CHECK_FORBIDDEN_WORDS: "" },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /BB_PUBLIC_WORDS_MISSING/);
  });

  test("실제 저장소에 없는 합성 pattern이면 --release도 통과한다", () => {
    const result = spawnSync(process.execPath, [scriptPath, "--release"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        BB_CHECK_FORBIDDEN_WORDS: ABSENT_SYNTHETIC_PATTERN,
      },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    // 로그에는 pattern 원문이 아니라 index/file/line만 나와야 한다.
    assert.doesNotMatch(
      result.stdout + result.stderr,
      new RegExp(ABSENT_SYNTHETIC_PATTERN),
    );
  });
});

describe("check-public-words.mjs CLI: 제네릭 모드", () => {
  test("BB_CHECK_FORBIDDEN_WORDS 없이도(--release 아니면) 통과한다", () => {
    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, BB_CHECK_FORBIDDEN_WORDS: "" },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
});

// dist/**는 .gitignore 대상이라 git ls-files로는 절대 보이지 않는다 —
// 유일하게 도달 가능한 경로는 npm pack --dry-run --json이 알려주는 tarball
// 파일 목록(listTarballRoots)뿐이다. 아래 테스트는 next package의 dist
// 안에 실제 파일을 하나 심어(tracked source 어디에도 없는 합성 pattern을
// 담아) --release 스캔이 그 파일을 실제로 tarball-listing 경로로 찾아내는지
// 확인한다 — "matches 배열에 뭔가 있다"가 아니라, git ls-files 쪽 경로가
// 아니라 next package tarball의 dist 경로로 찾아냈음을 직접 검증한다.
describe("check-public-words.mjs CLI: dist/**(tarball-only) 경로", () => {
  // 다른 테스트의 ABSENT_SYNTHETIC_PATTERN과 절대 겹치지 않는 별도
  // pattern — 이 파일 소스 어디에도 완성된 형태로 나타나지 않도록 조각내
  // 런타임에만 이어 붙인다(위 ABSENT_SYNTHETIC_PATTERN과 같은 이유).
  const DIST_ONLY_SYNTHETIC_PATTERN = ["zz-dist-only-probe", "-c71a"].join("");

  const nextPackageDir = join(repoRoot, "packages", "next-webpack-baseline");
  const distDir = join(nextPackageDir, "dist");
  const plantedFileName = "__i6-synthetic-forbidden-probe.js";
  const plantedFile = join(distDir, plantedFileName);
  let distDirPreexisted;

  before(async () => {
    distDirPreexisted = existsSync(distDir);
    if (!distDirPreexisted) await mkdir(distDir, { recursive: true });
    await writeFile(plantedFile, `// ${DIST_ONLY_SYNTHETIC_PATTERN}\n`, "utf8");
  });

  after(async () => {
    await rm(plantedFile, { force: true });
    if (!distDirPreexisted) await rm(distDir, { recursive: true, force: true });
  });

  test("심은 파일은 git ls-files에 나타나지 않는다(dist/**는 gitignore 대상)", () => {
    const result = spawnSync("git", ["ls-files", "-z"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const tracked = result.stdout.split("\0");
    assert.ok(
      !tracked.some((f) => f.endsWith(plantedFileName)),
      "심은 파일이 git ls-files에 나타났다 — 이 테스트의 전제(dist/**는 " +
        "untracked)가 깨졌다.",
    );
  });

  test("--release 스캔이 dist/** 안의 합성 pattern을 npm pack 경로로 찾아낸다", () => {
    const result = spawnSync(process.execPath, [scriptPath, "--release"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        BB_CHECK_FORBIDDEN_WORDS: DIST_ONLY_SYNTHETIC_PATTERN,
      },
    });

    assert.notEqual(
      result.status,
      0,
      "합성 pattern을 심었는데도 --release가 통과했다 — dist/**(tarball-only) " +
        `경로가 스캔되지 않는다.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    // matches 로그는 pattern 원문이 아니라 file 경로만 남긴다 — 그 file이
    // git-tracked 경로(README.md 등)가 아니라 tarball 쪽 경로
    // next package의 dist 경로임을 직접 확인해, 다른 tracked 파일이 아니라
    // 정확히 이 dist 파일을 통해서
    // 잡혔음을 증명한다.
    const expectedRoot = `packages/next-webpack-baseline/dist/${plantedFileName}`;
    assert.match(
      result.stderr,
      new RegExp(expectedRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  });
});
