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
  createNpmInvocation,
  listPublicPackageDirs,
  listTarballRoots,
  listTrackedFiles,
  parsePackResult,
  parsePublicWordsArguments,
  runScanner,
} from "./check-public-words.mjs";

const scriptPath = fileURLToPath(
  new URL("./check-public-words.mjs", import.meta.url),
);
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// 공개 파일에 없는 합성 pattern은 source에 완성된 문자열을 남기지 않도록
// 두 조각으로 나눠 런타임에만 이어 붙인다.
const ABSENT_SYNTHETIC_PATTERN = ["zz-test-forbidden", "-token-9f3c"].join("");

test("CLI argv는 generic 또는 정확한 --release 하나만 허용한다", () => {
  assert.deepEqual(parsePublicWordsArguments([]), { release: false });
  assert.deepEqual(parsePublicWordsArguments(["--release"]), { release: true });
  assert.throws(
    () => parsePublicWordsArguments(["--relase"]),
    /BB_PUBLIC_WORDS_ARGS/u,
  );
  assert.throws(
    () => parsePublicWordsArguments(["--release", "--release"]),
    /BB_PUBLIC_WORDS_ARGS/u,
  );
});

test("CLI typo와 duplicate는 npm pack 전에 실패하고 secret argv를 출력하지 않는다", () => {
  const secretTypo = ["--rel", "ease-secret-7b2d"].join("");
  for (const args of [[secretTypo], ["--release", "--release"]]) {
    const result = spawnSync(process.execPath, [scriptPath, ...args], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        BB_CHECK_FORBIDDEN_WORDS: secretTypo,
        npm_execpath: "Z:/must-not-run/npm-cli.js",
      },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /BB_PUBLIC_WORDS_ARGS/u);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(secretTypo));
    assert.doesNotMatch(result.stderr, /npm pack/u);
  }
});

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

test("Windows npm pack은 shell 없이 npm CLI를 Node로 실행한다", () => {
  assert.deepEqual(
    createNpmInvocation(["pack", "--dry-run", "--json"], {
      platform: "win32",
      npmExecPath: "C:/npm/npm-cli.js",
      nodeExecPath: "C:/node/node.exe",
    }),
    {
      command: "C:/node/node.exe",
      args: ["C:/npm/npm-cli.js", "pack", "--dry-run", "--json"],
    },
  );
  assert.throws(
    () =>
      createNpmInvocation([], {
        platform: "win32",
        npmExecPath: "",
        nodeExecPath: "C:/node/node.exe",
      }),
    /npm_execpath/u,
  );
});

test("npm pack 결과의 identity와 contained POSIX file path를 검증한다", () => {
  const valid = {
    status: 0,
    stdout: JSON.stringify([
      {
        name: "@cp949/next-webpack-baseline",
        version: "0.1.0",
        files: [{ path: "dist/index.js" }, { path: "README.md" }],
      },
    ]),
    stderr: "",
  };
  assert.deepEqual(
    parsePackResult(valid, {
      packageName: "@cp949/next-webpack-baseline",
      version: "0.1.0",
      packageRelDir: "packages/next-webpack-baseline",
    }),
    [
      "packages/next-webpack-baseline/dist/index.js",
      "packages/next-webpack-baseline/README.md",
    ],
  );

  const invalidEntries = [
    [],
    [{ name: "@cp949/next-webpack-baseline", version: "0.1.0", files: [] }],
    [
      {
        name: "@cp949/wrong",
        version: "0.1.0",
        files: [{ path: "dist/index.js" }],
      },
    ],
    [
      {
        name: "@cp949/next-webpack-baseline",
        version: "9.9.9",
        files: [{ path: "dist/index.js" }],
      },
    ],
    [
      {
        name: "@cp949/next-webpack-baseline",
        version: "0.1.0",
        files: [{ path: "dist/index.js" }],
      },
      {
        name: "@cp949/next-webpack-baseline",
        version: "0.1.0",
        files: [{ path: "README.md" }],
      },
    ],
  ];
  for (const entry of invalidEntries) {
    assert.throws(
      () =>
        parsePackResult(
          { status: 0, stdout: JSON.stringify(entry), stderr: "" },
          {
            packageName: "@cp949/next-webpack-baseline",
            version: "0.1.0",
            packageRelDir: "packages/next-webpack-baseline",
          },
        ),
      /BB_PUBLIC_PACK_INVALID/u,
    );
  }

  for (const path of [
    "",
    ".",
    "..",
    "/absolute.js",
    "C:/absolute.js",
    "C:drive-relative.js",
    "dist\\index.js",
    "dist//index.js",
    "dist/./index.js",
    "dist/../index.js",
    "dist/%2e%2e/index.js",
  ]) {
    assert.throws(
      () =>
        parsePackResult(
          {
            status: 0,
            stdout: JSON.stringify([
              {
                name: "@cp949/next-webpack-baseline",
                version: "0.1.0",
                files: [{ path }],
              },
            ]),
            stderr: "",
          },
          {
            packageName: "@cp949/next-webpack-baseline",
            version: "0.1.0",
            packageRelDir: "packages/next-webpack-baseline",
          },
        ),
      /BB_PUBLIC_PACK_INVALID/u,
    );
  }
});

test("tarball 수집은 주입된 npm 경계의 검증된 결과만 사용한다", async () => {
  const calls = [];
  const roots = await listTarballRoots({
    runCommand(command, args, options) {
      calls.push({ command, args, cwd: options.cwd });
      return {
        status: 0,
        stdout: JSON.stringify([
          {
            name: "@cp949/next-webpack-baseline",
            version: "0.1.0",
            files: [{ path: "dist/index.js" }],
          },
        ]),
        stderr: "",
      };
    },
  });

  assert.deepEqual(roots, ["packages/next-webpack-baseline/dist/index.js"]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ["pack", "--dry-run", "--json"]);
  assert.match(
    calls[0].cwd.replaceAll("\\", "/"),
    /packages\/next-webpack-baseline$/u,
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
      {
        kind: "content",
        file: "README.md",
        line: 2,
        pattern: "private-product",
      },
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
        result.matches.map(({ kind, file, line, pattern }) => ({
          kind,
          file,
          line,
          pattern,
        })),
        [
          {
            kind: "content",
            file: "notes.txt",
            line: 1,
            pattern: "alpha-secret",
          },
          {
            kind: "content",
            file: "notes.txt",
            line: 1,
            pattern: "beta-secret",
          },
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
        {
          kind: "content",
          file: "README.md",
          line: 1,
          pattern: "private-product",
        },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("유효하지 않은 UTF-8 파일도 skipped에 보고한다", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bb-check-public-words-utf8-"));
    try {
      await writeFile(join(dir, "invalid.txt"), Buffer.from([0xc3, 0x28]));
      const result = await runScanner({ roots: [dir], patterns: [] });
      assert.deepEqual(result.skipped, ["invalid.txt"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("runScanner: 파일 root(tracked file / tarball 파일 사용을 흉내)", () => {
  test("reported file path에만 있는 pattern을 path match로 보고한다", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bb-check-public-words-path-"));
    const pathPattern = ["path-only-secret", "-5a9e"].join("");
    try {
      const relativePath = `dist/${pathPattern}.js`;
      await mkdir(join(dir, "dist"), { recursive: true });
      await writeFile(join(dir, relativePath), "// harmless\n", "utf8");

      const result = await runScanner({
        roots: [relativePath],
        patterns: [pathPattern],
        cwd: dir,
      });
      assert.deepEqual(result.matches, [
        { kind: "path", file: relativePath, pattern: pathPattern },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

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
        result.matches.map(({ kind, file, line, pattern }) => ({
          kind,
          file,
          line,
          pattern,
        })),
        [
          {
            kind: "content",
            file: "README.md",
            line: 1,
            pattern: "private-product",
          },
          {
            kind: "content",
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
  const pathPattern = ["zz-path-secret", "-41c8"].join("");
  const pathLeakFile = join(distDir, `${pathPattern}.js`);
  const binaryFile = join(distDir, "__binary-release-probe.bin");
  let distDirPreexisted;

  before(async () => {
    distDirPreexisted = existsSync(distDir);
    if (!distDirPreexisted) await mkdir(distDir, { recursive: true });
    await writeFile(plantedFile, `// ${DIST_ONLY_SYNTHETIC_PATTERN}\n`, "utf8");
  });

  after(async () => {
    await rm(plantedFile, { force: true });
    await rm(pathLeakFile, { force: true });
    await rm(binaryFile, { force: true });
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
    assert.match(
      result.stderr,
      /pattern\[0\] source\[0\] kind content line 1/u,
    );
    assert.doesNotMatch(result.stderr, new RegExp(plantedFileName));
  });

  test("금지 pattern이 file path에 있어도 CLI 출력에서 원문을 숨긴다", async () => {
    await writeFile(pathLeakFile, "// harmless path-only fixture\n", "utf8");
    const result = spawnSync(process.execPath, [scriptPath, "--release"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, BB_CHECK_FORBIDDEN_WORDS: pathPattern },
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /kind path/u);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(pathPattern));
  });

  test("release mode는 binary skipped 파일이 하나라도 있으면 차단한다", async () => {
    await writeFile(binaryFile, Buffer.from([0x00, 0xff, 0xfe]));
    const result = spawnSync(process.execPath, [scriptPath, "--release"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        BB_CHECK_FORBIDDEN_WORDS: ABSENT_SYNTHETIC_PATTERN,
      },
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /BB_PUBLIC_WORDS_BINARY/u);
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /__binary-release-probe/u,
    );
  });
});
