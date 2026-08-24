#!/usr/bin/env node
// @cp949/bb-check가 실제로 publish할 tarball 내용물을 검사한다.
//
// 검사 세 가지:
// 1. `npm pack --dry-run --json`이 보고하는 파일 목록이 allowlist(dist/**,
//    README.md, LICENSE, package.json)를 벗어나지 않는가.
// 2. README.md/LICENSE/package.json과 dist/의 entry 산출물(index/library/cli의
//    .js와 .d.ts)이 실제로 그 목록에 있는가 — `files` allowlist는 "이 이름이
//    나오면 허용"일 뿐 "반드시 나와야 한다"는 보장이 아니다(예: 두 파일이
//    package 디렉터리에서 사라지면 `npm pack`은 조용히 그냥 빠뜨린다).
//    README.md는 package가 직접 소유하고, LICENSE는
//    `prepack`(scripts/copy-root-license.mjs)이 저장소 루트에서 복사한다.
//    LICENSE 최신화 step이 조용히 실패하거나 생략되는 회귀를 여기서 잡는다.
//    dist/*.js와 dist/*.d.ts는 build가 아예 안 됐거나
//    (dist/가 없거나) 오래된 상태로 남아 있는 회귀(예: C1 — test가 build보다
//    먼저 돌아 실제로는 한 번도 검증되지 않은 dist/를 그대로 pack하는 사고)를
//    여기서 잡는다 — `files`의 "dist/**"는 존재 여부를 전혀 강제하지
//    않으므로 이 REQUIRED_EXACT 목록이 유일한 강제 지점이다. hash가 붙는
//    공유 chunk 파일(예: dist/src-XXXXXXXX.js, dist/types-XXXXXXXX.d.ts)은
//    빌드마다 파일명이 달라 exact-name으로 강제할 수 없으므로 여기 포함하지
//    않는다 — entry 3개(index/library/cli)의 안정적인 파일명만 강제한다.
// 3. package.json의 `dependencies`에 private workspace package(@cp949/bb-core,
//    @cp949/bb-library, @cp949/bb-nextjs)나 `workspace:` protocol 지정이
//    남아있지 않은가 — 남아있으면 이 패키지만 설치한 소비자가 resolve하지
//    못하는 dependency가 생긴다.
//
// `npm pack --dry-run --json`은 파일 목록만 보고하고 package.json의
// dependencies 내용은 포함하지 않으므로(직접 확인함), dependency 검사는
// package.json을 별도로 읽어 수행한다.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

// `new URL(...)` global 대신 fileURLToPath + dirname을 쓴다 — 저장소
// eslint globals 설정(process/console만 허용)과 충돌하지 않는다.
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageDir = join(repoRoot, "packages", "bb-check");

const ALLOWED_EXACT = new Set(["README.md", "LICENSE", "package.json"]);
const ALLOWED_DIR_PREFIX = "dist/";
const REQUIRED_EXACT = [
  "README.md",
  "LICENSE",
  "package.json",
  // vite.config.ts의 lib.entry(index/library/cli) 3개가 각각 만드는
  // 안정적인 파일명. hash가 붙는 공유 chunk는 여기 포함하지 않는다(위
  // 파일 상단 주석 참고).
  "dist/index.js",
  "dist/index.d.ts",
  "dist/library.js",
  "dist/library.d.ts",
  "dist/cli.js",
  "dist/cli.d.ts",
];

const FORBIDDEN_DEPENDENCY_NAMES = [
  "@cp949/bb-core",
  "@cp949/bb-library",
  "@cp949/bb-nextjs",
];

/** path가 allowlist(dist/**, README.md, LICENSE, package.json) 안에 있는지 확인한다. */
const isAllowedPath = (path) =>
  ALLOWED_EXACT.has(path) || path.startsWith(ALLOWED_DIR_PREFIX);

/** dependencies 필드에 workspace protocol 지정이나 private workspace package가 남아있는지 확인한다. */
const findForbiddenDependencies = (dependencies) => {
  const problems = [];
  if (dependencies === undefined) return problems;
  for (const [name, spec] of Object.entries(dependencies)) {
    if (FORBIDDEN_DEPENDENCY_NAMES.includes(name)) {
      problems.push(
        `dependencies["${name}"] = "${spec}" (private workspace package)`,
      );
    }
    if (typeof spec === "string" && spec.includes("workspace:")) {
      problems.push(
        `dependencies["${name}"] = "${spec}" (workspace: protocol)`,
      );
    }
  }
  return problems;
};

/** `npm pack --dry-run --json`을 packageDir에서 실행해 파일 목록을 얻는다. */
const readPackFiles = () => {
  const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: packageDir,
    encoding: "utf8",
    // Windows(cmd.exe)에서는 npm.cmd를 shell 경유로 찾아야 한다. args는
    // 고정 literal이라 shell injection 위험이 없다.
    shell: process.platform === "win32",
  });
  if (result.error) {
    throw new Error(`npm pack 실행 실패: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `npm pack --dry-run --json이 exit ${result.status}로 종료했다.\nstderr:\n${result.stderr}`,
    );
  }
  let manifest;
  try {
    manifest = JSON.parse(result.stdout);
  } catch (cause) {
    throw new Error(
      `npm pack --dry-run --json 출력을 JSON으로 파싱하지 못했다.\nstdout:\n${result.stdout}`,
      { cause },
    );
  }
  const [entry] = manifest;
  if (!entry || !Array.isArray(entry.files)) {
    throw new Error(
      `npm pack --dry-run --json 출력 형식이 예상과 다르다: ${result.stdout}`,
    );
  }
  return entry.files.map((file) => file.path);
};

const main = async () => {
  const problems = [];

  const packedPaths = readPackFiles();
  const disallowedPaths = packedPaths.filter((path) => !isAllowedPath(path));
  if (disallowedPaths.length > 0) {
    problems.push(
      `허용되지 않은 파일이 tarball에 포함되어 있다:\n${disallowedPaths.map((p) => `  - ${p}`).join("\n")}`,
    );
  }

  const missingRequired = REQUIRED_EXACT.filter(
    (path) => !packedPaths.includes(path),
  );
  if (missingRequired.length > 0) {
    problems.push(
      `필수 파일이 tarball에 없다:\n${missingRequired.map((p) => `  - ${p}`).join("\n")}`,
    );
  }

  const manifestSource = JSON.parse(
    await readFile(join(packageDir, "package.json"), "utf8"),
  );
  const dependencyProblems = findForbiddenDependencies(
    manifestSource.dependencies,
  );
  if (dependencyProblems.length > 0) {
    problems.push(
      `dependencies에 publish 불가능한 항목이 남아있다:\n${dependencyProblems.map((p) => `  - ${p}`).join("\n")}`,
    );
  }

  if (problems.length > 0) {
    console.error("check-package-files: FAIL\n");
    console.error(problems.join("\n\n"));
    process.exit(1);
  }

  console.log(
    `check-package-files: OK (${packedPaths.length}개 파일, allowlist 통과, dependencies 정상)`,
  );
};

await main();
