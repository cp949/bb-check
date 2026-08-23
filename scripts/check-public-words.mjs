#!/usr/bin/env node
// 공개 저장소에 내부 전용 식별자가 섞여 있지 않은지 검사한다. 두 소스를
// 스캔한다:
//   1. git으로 추적되는 모든 파일(`git ls-files -z`)
//   2. 공개(private !== true) workspace package가 실제로 publish할
//      tarball 파일 목록(각 package 디렉터리에서 `npm pack --dry-run
//      --json`)
//
// 실제 forbidden pattern은 이 저장소 어디에도 하드코딩하지 않는다 — 반드시
// comma-separated 환경변수 BB_CHECK_FORBIDDEN_WORDS로 호출 시점에 주입한다.
// `--release` 모드에서 이 환경변수가 비어 있으면(빈 pattern 목록으로
// "항상 통과"하는 상태로 실제 배포 게이트가 돌아가는 사고를 막기 위해)
// BB_PUBLIC_WORDS_MISSING으로 실패한다. `--release` 없이(예: 일반 CI)
// 실행하면 pattern이 비어 있어도 실패하지 않는다 — git ls-files/npm pack
// 수집과 binary 판별·매칭 메커니즘 자체가 깨지지 않았는지만 확인하는
// "제네릭" 모드다.
//
// stdout/stderr에는 실제 pattern 원문을 절대 출력하지 않는다 — 매칭 로그는
// patterns 배열의 index와 file/line만 남긴다. `runScanner`가 돌려주는
// `result.matches`에는 pattern 원문이 그대로 담기지만, 그건 이 모듈을
// import하는 테스트·호출자를 위한 내부 데이터일 뿐 CLI 출력 경로로는
// 흐르지 않는다.
//
// 이 파일은 스캐너 primitive(runScanner, named export — 테스트가
// import한다)와 CLI 진입점(아래 main(), 이 파일을 직접 실행했을 때만
// 돈다)을 함께 담는다 — 브리핑의 파일 목록에 별도 모듈 파일이 없으므로
// 하나로 합쳤다.

import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

// ---- binary-safe scanning primitive ----------------------------------------

/** NUL byte를 포함하거나 유효한 UTF-8이 아니면 binary로 본다. */
const isBinaryBuffer = (buffer) => {
  if (buffer.includes(0)) return true;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return false;
  } catch {
    return true;
  }
};

/** CRLF/LF/CR을 모두 line terminator로 인정해 line 단위로 쪼갠다. */
const splitLines = (text) => text.split(/\r\n|\r|\n/);

/** 파일 하나를 읽어 matches/skipped에 결과를 누적한다. reportedName이 결과의 file 값이 된다. */
const scanFile = async (
  absolutePath,
  reportedName,
  patterns,
  matches,
  skipped,
) => {
  const buffer = await readFile(absolutePath);
  if (isBinaryBuffer(buffer)) {
    skipped.push(reportedName);
    return;
  }
  const text = new TextDecoder("utf-8").decode(buffer);
  const lines = splitLines(text);
  lines.forEach((line, index) => {
    for (const pattern of patterns) {
      if (line.includes(pattern)) {
        matches.push({ file: reportedName, line: index + 1, pattern });
      }
    }
  });
};

/** 디렉터리를 재귀적으로 순회하며 각 파일을 relativeToRoot 기준 POSIX 상대 경로로 스캔한다. */
const walkDirectory = async (
  absoluteDir,
  relativeToRoot,
  patterns,
  matches,
  skipped,
) => {
  const entries = await readdir(absoluteDir, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const absoluteChild = join(absoluteDir, entry.name);
    const relativeChild =
      relativeToRoot === "" ? entry.name : `${relativeToRoot}/${entry.name}`;
    if (entry.isDirectory()) {
      await walkDirectory(
        absoluteChild,
        relativeChild,
        patterns,
        matches,
        skipped,
      );
    } else if (entry.isFile()) {
      await scanFile(absoluteChild, relativeChild, patterns, matches, skipped);
    }
  }
};

/**
 * roots(파일 또는 디렉터리 경로 목록)에서 patterns의 등장을 찾는다.
 *
 * - 디렉터리 root는 재귀적으로 순회하며, 그 안에서 찾은 각 파일을 root
 *   기준 상대 경로(POSIX 구분자 "/")로 보고한다. 테스트가 만든 작은
 *   fixture 디렉터리를 통째로 스캔할 때 쓴다.
 * - 파일 root는 그 자체를 스캔하고, 호출자가 넘긴 문자열 그대로를 결과의
 *   file 값으로 쓴다. 실제 CLI(main())가 git-tracked 파일이나 tarball
 *   파일 하나하나를 넘길 때 이 경로를 쓴다 — 각 경로가 이미 저장소 루트
 *   기준 의미 있는 표시용 이름이기 때문이다.
 *
 * UTF-8 text만 line 단위로 검사한다. NUL byte를 포함하거나 유효한
 * UTF-8로 decode되지 않는 파일은 binary로 보고 건너뛰며, matches가
 * 아니라 skipped 목록에 별도로 담는다.
 *
 * @param {{ roots: readonly string[], patterns: readonly string[], cwd?: string }} options
 * @returns {Promise<{ matches: { file: string, line: number, pattern: string }[], skipped: string[] }>}
 */
export async function runScanner({ roots, patterns, cwd = process.cwd() }) {
  const matches = [];
  const skipped = [];

  for (const root of roots) {
    const absoluteRoot = resolve(cwd, root);
    const info = await stat(absoluteRoot).catch(() => undefined);
    if (info === undefined) {
      throw new Error(
        `scanner root가 존재하지 않습니다: ${root} (resolved: ${absoluteRoot})`,
      );
    }
    if (info.isDirectory()) {
      await walkDirectory(absoluteRoot, "", patterns, matches, skipped);
    } else {
      await scanFile(absoluteRoot, root, patterns, matches, skipped);
    }
  }

  matches.sort((a, b) => {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    if (a.line !== b.line) return a.line - b.line;
    return patterns.indexOf(a.pattern) - patterns.indexOf(b.pattern);
  });
  skipped.sort();

  return { matches, skipped };
}

// ---- 실제 파일 소스 수집(git-tracked / tarball) -----------------------------

/** repoRoot에서 `git ls-files -z`로 추적 파일 목록(repoRoot 기준 POSIX 상대 경로)을 얻는다. */
const listTrackedFiles = () => {
  const result = spawnSync("git", ["ls-files", "-z"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.error) {
    throw new Error(`git ls-files 실행 실패: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `git ls-files -z가 exit ${result.status}로 종료했습니다.\n${result.stderr}`,
    );
  }
  return result.stdout.split("\0").filter((entry) => entry.length > 0);
};

/** packages/*에서 private !== true인(=publish 대상) package 디렉터리를 모은다. */
const listPublicPackageDirs = async () => {
  const packagesDir = join(repoRoot, "packages");
  const entries = await readdir(packagesDir, { withFileTypes: true });
  const dirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const packageDir = join(packagesDir, entry.name);
    let manifest;
    try {
      manifest = JSON.parse(
        await readFile(join(packageDir, "package.json"), "utf8"),
      );
    } catch {
      continue; // package.json이 없거나 JSON이 아님: publish 대상이 아니다.
    }
    if (manifest.private !== true) dirs.push(packageDir);
  }
  return dirs.sort();
};

/**
 * 공개 package마다 `npm pack --dry-run --json`을 실행해, 그 tarball에
 * 포함될 파일들을 repoRoot 기준 상대 경로(root 문자열) 목록으로 만든다.
 */
const listTarballRoots = async () => {
  const roots = [];
  for (const packageDir of await listPublicPackageDirs()) {
    const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: packageDir,
      encoding: "utf8",
      // Windows(cmd.exe)에서는 npm.cmd를 shell 경유로 찾아야 한다. args는
      // 고정 literal이라 shell injection 위험이 없다.
      shell: process.platform === "win32",
    });
    if (result.error) {
      throw new Error(
        `npm pack 실행 실패(${packageDir}): ${result.error.message}`,
      );
    }
    if (result.status !== 0) {
      throw new Error(
        `npm pack --dry-run --json이 exit ${result.status}로 종료했습니다(${packageDir}).\nstderr:\n${result.stderr}`,
      );
    }
    let manifest;
    try {
      manifest = JSON.parse(result.stdout);
    } catch (cause) {
      throw new Error(
        `npm pack --dry-run --json 출력을 JSON으로 파싱하지 못했습니다(${packageDir}).`,
        { cause },
      );
    }
    const [entry] = manifest;
    if (!entry || !Array.isArray(entry.files)) {
      throw new Error(
        `npm pack --dry-run --json 출력 형식이 예상과 다릅니다(${packageDir}).`,
      );
    }
    const packageRelDir = relative(repoRoot, packageDir).split(sep).join("/");
    for (const file of entry.files) {
      roots.push(`${packageRelDir}/${file.path}`);
    }
  }
  return roots;
};

/** BB_CHECK_FORBIDDEN_WORDS를 comma로 나누고 앞뒤 공백을 trim한 뒤 빈 항목을 버린다. */
const parsePatterns = () => {
  const raw = process.env.BB_CHECK_FORBIDDEN_WORDS ?? "";
  return raw
    .split(",")
    .map((word) => word.trim())
    .filter((word) => word.length > 0);
};

// ---- CLI 진입점 --------------------------------------------------------------

async function main() {
  const release = process.argv.includes("--release");
  const patterns = parsePatterns();

  if (release && patterns.length === 0) {
    console.error(
      "[BB_PUBLIC_WORDS_MISSING] --release 모드인데 BB_CHECK_FORBIDDEN_WORDS가 " +
        "비어 있습니다. 실제 배포 전 검사에는 금지 pattern 목록이 반드시 필요합니다.",
    );
    process.exitCode = 1;
    return;
  }

  const trackedFiles = listTrackedFiles();
  const tarballRoots = await listTarballRoots();
  const roots = [...new Set([...trackedFiles, ...tarballRoots])];

  const { matches, skipped } = await runScanner({
    roots,
    patterns,
    cwd: repoRoot,
  });

  if (patterns.length === 0) {
    console.log(
      `check-public-words: 제네릭 모드(pattern 0개) — 파일 ${roots.length}개 수집, ` +
        `binary skip ${skipped.length}개. 실제 금지 pattern 검사는 --release 모드에서 ` +
        "BB_CHECK_FORBIDDEN_WORDS를 채워 수행하세요.",
    );
    process.exitCode = 0;
    return;
  }

  if (matches.length > 0) {
    console.error(
      `check-public-words: FAIL (금지 pattern ${matches.length}건)\n`,
    );
    for (const match of matches) {
      const patternIndex = patterns.indexOf(match.pattern);
      console.error(`  - pattern[${patternIndex}] ${match.file}:${match.line}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    `check-public-words: OK (pattern ${patterns.length}개, 파일 ${roots.length}개, ` +
      `binary skip ${skipped.length}개, 금지 pattern 0건)`,
  );
}

// 이 파일을 직접 실행했을 때만 main()을 돈다 — 테스트가 runScanner만
// import할 때는 git/npm pack을 건드리는 실제 side effect가 돌면 안 된다.
const isMainModule =
  process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMainModule) {
  await main();
}
