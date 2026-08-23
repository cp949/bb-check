// check-public-words.mjs가 내보내는 runScanner(binary-safe 공개 정보
// scanner의 핵심 primitive)를 검증한다. 실제 forbidden pattern은 이
// 저장소 어디에도 하드코딩하지 않는다 — 아래 모든 테스트는 만든
// 예시(synthetic) pattern만 쓴다. 이 테스트는 vitest가 아니라 Node의
// 내장 test runner로 돈다(root package.json의 "test"는 이 파일을
// --exclude로 제외한다) — `node --test scripts/check-public-words.test.mjs`.

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { runScanner } from "./check-public-words.mjs";

const scriptPath = fileURLToPath(
  new URL("./check-public-words.mjs", import.meta.url),
);
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// 이 테스트 파일 자신도 git-tracked 상태로 저장소에 포함된다(바로 이
// scripts/check-public-words.test.mjs). 아래 "실제 저장소에 없는 합성
// pattern" 테스트는 real repoRoot 전체를 --release로 스캔해 matches가
// 0건임을 확인하는데, pattern 문자열을 이 파일 안에 온전한 substring으로
// 그대로 적어두면 스캐너가 (자기 자신이 tracked file이므로) 그 자리를
// 그대로 찾아내 self-match를 일으킨다 — 실제로 이 파일이 staged/tracked된
// 뒤 재현됨(node --test와 vitest 양쪽에서 확인). 그래서 두 조각으로 나눠
// 런타임에만 이어 붙인다: 완성된 pattern 문자열이 이 파일 소스 어디에도
// 연속된 substring으로 나타나지 않는다.
const ABSENT_SYNTHETIC_PATTERN = ["zz-test-forbidden", "-token-9f3c"].join("");

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
