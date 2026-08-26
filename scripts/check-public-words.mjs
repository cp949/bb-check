#!/usr/bin/env node
// 공개 저장소에 내부 전용 식별자가 섞여 있지 않은지 검사한다. 두 소스를
// 스캔한다:
//   1. root 공개 README와 공개 package(next-webpack-baseline,
//      legacy-browser-smoke) 각각의 git 추적 파일
//   2. 각 공개 package가 실제로 publish할 tarball 파일 목록
//      (`npm pack --dry-run --json`)
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

export function createNpmInvocation(
  args,
  {
    platform = process.platform,
    npmExecPath = process.env.npm_execpath,
    nodeExecPath = process.execPath,
  } = {},
) {
  if (platform !== "win32") return { command: "npm", args };
  if (typeof npmExecPath !== "string" || npmExecPath.length === 0) {
    throw new Error(
      "Windows에서는 npm_execpath가 필요합니다. npm run check-public-words로 실행하세요.",
    );
  }
  return { command: nodeExecPath, args: [npmExecPath, ...args] };
}

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
  for (const pattern of patterns) {
    if (reportedName.includes(pattern)) {
      matches.push({ kind: "path", file: reportedName, pattern });
    }
  }
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
        matches.push({
          kind: "content",
          file: reportedName,
          line: index + 1,
          pattern,
        });
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
 * @returns {Promise<{ matches: ({ kind: "path", file: string, pattern: string } | { kind: "content", file: string, line: number, pattern: string })[], skipped: string[] }>}
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
    if (a.kind !== b.kind) return a.kind === "path" ? -1 : 1;
    const leftLine = a.kind === "content" ? a.line : 0;
    const rightLine = b.kind === "content" ? b.line : 0;
    if (leftLine !== rightLine) return leftLine - rightLine;
    return patterns.indexOf(a.pattern) - patterns.indexOf(b.pattern);
  });
  skipped.sort();

  return { matches, skipped };
}

// ---- 실제 파일 소스 수집(git-tracked / tarball) -----------------------------

/** 공개 README와 공개 package들의 추적 파일 목록을 얻는다. */
export const listTrackedFiles = () => {
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
  return result.stdout
    .split("\0")
    .filter(
      (entry) =>
        entry === "README.md" ||
        entry.startsWith("packages/next-webpack-baseline/") ||
        entry.startsWith("packages/legacy-browser-smoke/"),
    );
};

// A8 release 대상 공개 package 목록. 순서가 스캔·tarball 수집 순서를
// 결정하므로 next-webpack-baseline을 먼저, legacy-browser-smoke를
// 다음으로 고정한다.
const PUBLIC_PACKAGES = [
  {
    workspacePath: "packages/next-webpack-baseline",
    name: "@cp949/next-webpack-baseline",
  },
  {
    workspacePath: "packages/legacy-browser-smoke",
    name: "@cp949/legacy-browser-smoke",
  },
];

/**
 * A8 release 대상인 공개 package 디렉터리들을 fail-closed로 검증해
 * PUBLIC_PACKAGES 순서 그대로 반환한다. 각 package는 manifest가
 * 존재하고, name이 정확히 일치하고, private이 true가 아니어야 한다 —
 * 하나라도 어긋나면 어느 workspace가 문제인지 명시해 즉시 던진다.
 *
 * @param {{ root?: string }} [options] 테스트가 임시 fixture 저장소를
 *   주입할 수 있는 유일한 경계. 생략하면 실제 저장소 root를 쓴다.
 */
export const listPublicPackageDirs = async ({ root = repoRoot } = {}) => {
  const dirs = [];
  for (const { workspacePath, name } of PUBLIC_PACKAGES) {
    const packageDir = join(root, ...workspacePath.split("/"));
    let manifest;
    try {
      manifest = JSON.parse(
        await readFile(join(packageDir, "package.json"), "utf8"),
      );
    } catch (cause) {
      throw new Error(
        `${workspacePath} 공개 package manifest를 읽을 수 없습니다(package.json 존재 여부를 확인하세요).`,
        { cause },
      );
    }
    if (manifest.name !== name || manifest.private === true) {
      throw new Error(
        `${workspacePath} 공개 package manifest가 올바르지 않습니다(name 또는 private 필드를 확인하세요).`,
      );
    }
    dirs.push(packageDir);
  }
  return dirs;
};

const invalidPack = (message) => {
  throw new Error(`[BB_PUBLIC_PACK_INVALID] ${message}`);
};

const validatePackedPath = (value) => {
  if (typeof value !== "string" || value.length === 0) {
    return invalidPack("file.path는 비어 있지 않은 문자열이어야 합니다.");
  }
  if (
    value.includes("\\") ||
    value.includes("%") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/u.test(value) ||
    value.includes("\0")
  ) {
    return invalidPack("file.path는 안전한 POSIX 상대 경로여야 합니다.");
  }
  const segments = value.split("/");
  if (
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    return invalidPack("file.path는 안전한 POSIX 상대 경로여야 합니다.");
  }
  return value;
};

export function parsePackResult(
  result,
  { packageName, version, packageRelDir },
) {
  if (result.error || result.status !== 0) {
    return invalidPack("npm pack 실행이 실패했습니다.");
  }
  let output;
  try {
    output = JSON.parse(result.stdout);
  } catch {
    return invalidPack("npm pack 출력을 JSON으로 파싱할 수 없습니다.");
  }
  if (!Array.isArray(output) || output.length !== 1) {
    return invalidPack("npm pack 결과는 정확히 한 package여야 합니다.");
  }
  const [entry] = output;
  if (
    typeof entry !== "object" ||
    entry === null ||
    entry.name !== packageName ||
    entry.version !== version
  ) {
    return invalidPack("npm pack package identity가 manifest와 다릅니다.");
  }
  if (!Array.isArray(entry.files) || entry.files.length === 0) {
    return invalidPack("npm pack files는 비어 있지 않은 배열이어야 합니다.");
  }
  return entry.files.map((file) => {
    if (typeof file !== "object" || file === null) {
      return invalidPack("npm pack file entry는 object여야 합니다.");
    }
    return `${packageRelDir}/${validatePackedPath(file.path)}`;
  });
}

/**
 * 공개 package마다 `npm pack --dry-run --json`을 실행해, 그 tarball에
 * 포함될 파일들을 repoRoot 기준 상대 경로(root 문자열) 목록으로 만든다.
 */
export const listTarballRoots = async ({ runCommand = spawnSync } = {}) => {
  const roots = [];
  for (const packageDir of await listPublicPackageDirs()) {
    const args = ["pack", "--dry-run", "--json"];
    const invocation = createNpmInvocation(args);
    const result = runCommand(invocation.command, invocation.args, {
      cwd: packageDir,
      encoding: "utf8",
    });
    let manifest;
    try {
      manifest = JSON.parse(
        await readFile(join(packageDir, "package.json"), "utf8"),
      );
    } catch {
      return invalidPack("package manifest를 읽을 수 없습니다.");
    }
    const packageRelDir = relative(repoRoot, packageDir).split(sep).join("/");
    roots.push(
      ...parsePackResult(result, {
        packageName: manifest.name,
        version: manifest.version,
        packageRelDir,
      }),
    );
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

const redactPatterns = (message, patterns) => {
  let redacted = message;
  for (const pattern of patterns)
    redacted = redacted.replaceAll(pattern, "[redacted]");
  return redacted;
};

export function parsePublicWordsArguments(argv) {
  if (argv.length === 0) return { release: false };
  if (argv.length === 1 && argv[0] === "--release") {
    return { release: true };
  }
  throw new Error(
    "[BB_PUBLIC_WORDS_ARGS] 사용법: check-public-words [--release]",
  );
}

// ---- CLI 진입점 --------------------------------------------------------------

async function main() {
  const { release } = parsePublicWordsArguments(process.argv.slice(2));
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

  if (release && skipped.length > 0) {
    console.error(
      `[BB_PUBLIC_WORDS_BINARY] release 공개 파일 ${skipped.length}개를 text로 검증할 수 없습니다.`,
    );
    process.exitCode = 1;
    return;
  }

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
    matches.forEach((match, index) => {
      const patternIndex = patterns.indexOf(match.pattern);
      const location = match.kind === "content" ? ` line ${match.line}` : "";
      console.error(
        `  - pattern[${patternIndex}] source[${index}] kind ${match.kind}${location}`,
      );
    });
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
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(redactPatterns(message, parsePatterns()));
    process.exitCode = 1;
  }
}
