#!/usr/bin/env node
// 공개 workspace package를 각각 독립된 tarball 단위로 검사한다.
// manifest files/exports, declaration, sourcemap과 공개 불가능한 runtime
// dependency를 package 사이에 공유하지 않고 검증한다.

import { readdir, readFile } from "node:fs/promises";
import { dirname, join, posix, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const defaultRepoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const PUBLIC_ALLOWED_EXACT = new Set(["README.md", "LICENSE", "package.json"]);
const DIST_FILE_DECLARATIONS = new Set(["dist", "dist/", "dist/*", "dist/**"]);
const LEGACY_FORBIDDEN_DEPENDENCIES = new Set([
  "@cp949/bb-core",
  "@cp949/bb-library",
  "@cp949/bb-nextjs",
]);
const DEPENDENCY_FIELDS = [
  "dependencies",
  "peerDependencies",
  "optionalDependencies",
];

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

const workspacePatternsOf = (manifest) => {
  const { workspaces } = manifest;
  if (Array.isArray(workspaces)) return workspaces;
  if (
    typeof workspaces === "object" &&
    workspaces !== null &&
    Array.isArray(workspaces.packages)
  ) {
    return workspaces.packages;
  }
  throw new Error("root package.json의 workspaces 배열을 읽을 수 없습니다.");
};

const workspacePathsForPattern = async (repoRoot, pattern) => {
  if (typeof pattern !== "string" || pattern === "") {
    throw new Error("workspace pattern은 비어 있지 않은 문자열이어야 합니다.");
  }
  const normalized = pattern.replaceAll("\\", "/").replace(/^\.\//u, "");
  if (!normalized.includes("*")) return [normalized];
  if (!normalized.endsWith("/*") || normalized.slice(0, -2).includes("*")) {
    throw new Error(`지원하지 않는 workspace pattern입니다: ${pattern}`);
  }

  const parentPath = normalized.slice(0, -2);
  const entries = await readdir(join(repoRoot, parentPath), {
    withFileTypes: true,
  }).catch((cause) => {
    if (cause?.code === "ENOENT") return [];
    throw cause;
  });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${parentPath}/${entry.name}`);
};

const discoverWorkspacePackages = async (repoRoot) => {
  const rootManifest = await readJson(join(repoRoot, "package.json"));
  const workspacePaths = new Set();
  for (const pattern of workspacePatternsOf(rootManifest)) {
    for (const workspacePath of await workspacePathsForPattern(
      repoRoot,
      pattern,
    )) {
      workspacePaths.add(workspacePath);
    }
  }

  const packages = [];
  for (const workspacePath of [...workspacePaths].sort()) {
    const packageDir = join(repoRoot, workspacePath);
    let manifest;
    try {
      manifest = await readJson(join(packageDir, "package.json"));
    } catch (cause) {
      if (cause?.code === "ENOENT") continue;
      throw new Error(`${workspacePath}/package.json을 읽을 수 없습니다.`, {
        cause,
      });
    }
    packages.push({ workspacePath, packageDir, manifest });
  }
  return packages;
};

/** root workspaces 전체에서 private이 아닌 package를 path 순서로 반환한다. */
export const discoverPublicWorkspacePackages = async (repoRoot) =>
  (await discoverWorkspacePackages(repoRoot)).filter(
    ({ manifest }) => manifest.private !== true,
  );

/** Windows에서는 npm.cmd를 shell로 열지 않고 npm CLI를 Node로 실행한다. */
export const createCommandInvocation = (
  command,
  args,
  {
    platform = process.platform,
    npmExecPath = process.env.npm_execpath,
    nodeExecPath = process.execPath,
  } = {},
) => {
  if (platform !== "win32" || command !== "npm") return { command, args };
  if (typeof npmExecPath !== "string" || npmExecPath.length === 0) {
    throw new Error(
      "Windows에서는 npm_execpath가 필요합니다. npm script로 실행하세요.",
    );
  }
  return { command: nodeExecPath, args: [npmExecPath, ...args] };
};

const readNpmPackFiles = ({ packageDir, workspacePath }) => {
  const invocation = createCommandInvocation("npm", [
    "pack",
    "--dry-run",
    "--json",
  ]);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: packageDir,
    encoding: "utf8",
  });
  if (result.error) {
    throw new Error(
      `npm pack 실행 실패(${workspacePath}): ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `npm pack --dry-run --json이 exit ${result.status}로 종료했습니다(${workspacePath}).\nstderr:\n${result.stderr}`,
    );
  }
  let output;
  try {
    output = JSON.parse(result.stdout);
  } catch (cause) {
    throw new Error(
      `npm pack --dry-run --json 출력을 JSON으로 파싱하지 못했습니다(${workspacePath}).`,
      { cause },
    );
  }
  const [entry] = output;
  if (!entry || !Array.isArray(entry.files)) {
    throw new Error(
      `npm pack --dry-run --json 출력 형식이 예상과 다릅니다(${workspacePath}).`,
    );
  }
  return entry.files.map((file) => file.path);
};

const normalizeArtifactPath = (value) =>
  value.startsWith("./") ? value.slice(2) : value;

const isAllowedPublicPath = (path) =>
  PUBLIC_ALLOWED_EXACT.has(path) || path.startsWith("dist/");

const isAllowedFilesDeclaration = (value) => {
  const normalized = normalizeArtifactPath(value);
  return (
    PUBLIC_ALLOWED_EXACT.has(normalized) ||
    DIST_FILE_DECLARATIONS.has(normalized)
  );
};

const isCoveredByFiles = (path, patterns) =>
  patterns.some((pattern) => {
    const normalized = normalizeArtifactPath(pattern);
    if (DIST_FILE_DECLARATIONS.has(normalized)) return path.startsWith("dist/");
    return path === normalized;
  });

const invalidExportTarget = (problems, workspacePath, label, value) => {
  const type =
    value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  problems.push(
    formatProblem(
      workspacePath,
      "exports",
      `${label}: invalid export target type (${type})`,
    ),
  );
};

const collectExportTargets = (
  value,
  label,
  workspacePath,
  problems,
  targets,
) => {
  if (value === null) return;
  if (typeof value === "string") {
    targets.push(value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectExportTargets(
        item,
        `${label}[${index}]`,
        workspacePath,
        problems,
        targets,
      ),
    );
    return;
  }
  if (typeof value !== "object") {
    invalidExportTarget(problems, workspacePath, label, value);
    return;
  }

  const keys = Object.keys(value);
  if (keys.some((key) => key.startsWith("."))) {
    problems.push(
      formatProblem(
        workspacePath,
        "exports",
        `${label}: condition map 안에는 subpath key를 사용할 수 없습니다.`,
      ),
    );
  }
  for (const [condition, target] of Object.entries(value)) {
    collectExportTargets(
      target,
      `${label}.${condition}`,
      workspacePath,
      problems,
      targets,
    );
  }
};

const validatedExportEntries = (exportsField, workspacePath, problems) => {
  if (exportsField === undefined) {
    problems.push(
      formatProblem(workspacePath, "exports", "manifest exports가 없습니다."),
    );
    return [];
  }
  if (
    exportsField !== null &&
    typeof exportsField === "object" &&
    !Array.isArray(exportsField)
  ) {
    const entries = Object.entries(exportsField);
    const subpathKeys = entries.filter(([key]) => key.startsWith("."));
    const conditionKeys = entries.filter(([key]) => !key.startsWith("."));
    if (subpathKeys.length > 0 && conditionKeys.length > 0) {
      problems.push(
        formatProblem(
          workspacePath,
          "exports",
          "exports에서 subpath key와 condition key를 혼합할 수 없습니다.",
        ),
      );
    }
    if (subpathKeys.length > 0) {
      return subpathKeys.map(([subpath, value]) => {
        const targets = [];
        collectExportTargets(
          value,
          `exports[${JSON.stringify(subpath)}]`,
          workspacePath,
          problems,
          targets,
        );
        return [subpath, targets];
      });
    }
  }

  const targets = [];
  collectExportTargets(
    exportsField,
    "exports",
    workspacePath,
    problems,
    targets,
  );
  return [[".", targets]];
};

const declarationFor = (runtimePath) =>
  runtimePath
    .replace(/\.mjs$/u, ".d.mts")
    .replace(/\.cjs$/u, ".d.cts")
    .replace(/\.js$/u, ".d.ts");

const targetsMatching = (targets, pattern) =>
  targets.map(normalizeArtifactPath).filter((path) => pattern.test(path));

const binTargetsOf = (bin) => {
  if (typeof bin === "string") return [normalizeArtifactPath(bin)];
  if (typeof bin !== "object" || bin === null) return [];
  return Object.values(bin)
    .filter((value) => typeof value === "string")
    .map(normalizeArtifactPath);
};

const npmAliasTargetOf = (spec) => {
  if (!spec.startsWith("npm:")) return undefined;
  const alias = spec.slice("npm:".length);
  if (alias.startsWith("@")) {
    const slash = alias.indexOf("/");
    if (slash < 0) return alias;
    const version = alias.indexOf("@", slash);
    return version < 0 ? alias : alias.slice(0, version);
  }
  const version = alias.indexOf("@");
  return version < 0 ? alias : alias.slice(0, version);
};

const sourceMapReferences = (source) => {
  const references = [];
  const pattern = /\/\/[#@]\s*sourceMappingURL=([^\s]+)/gu;
  for (const match of source.matchAll(pattern)) {
    if (match[1] !== undefined) references.push(match[1]);
  }
  return references;
};

const formatProblem = (workspace, category, message) =>
  `${workspace} [${category}] ${message}`;

const validatePackage = async ({
  workspacePath,
  packageDir,
  manifest,
  packedPaths,
  privateWorkspaceNames,
}) => {
  const problems = [];
  const packed = new Set(packedPaths);
  const files = Array.isArray(manifest.files)
    ? manifest.files.filter(
        (entry) => typeof entry === "string" && entry !== "",
      )
    : [];
  if (
    !Array.isArray(manifest.files) ||
    files.length !== manifest.files.length
  ) {
    problems.push(
      formatProblem(
        workspacePath,
        "files",
        "manifest files는 비어 있지 않은 문자열 배열이어야 합니다.",
      ),
    );
  } else {
    for (const path of packedPaths) {
      if (!isAllowedPublicPath(path)) {
        problems.push(
          formatProblem(
            workspacePath,
            "files",
            `tarball 파일이 공개 allowlist 밖입니다: ${path}`,
          ),
        );
      }
      if (!isCoveredByFiles(path, files)) {
        problems.push(
          formatProblem(
            workspacePath,
            "files",
            `tarball 파일이 manifest files 범위 밖입니다: ${path}`,
          ),
        );
      }
    }
    for (const pattern of files) {
      if (!isAllowedFilesDeclaration(pattern)) {
        problems.push(
          formatProblem(
            workspacePath,
            "files",
            `manifest files 항목이 공개 allowlist 밖입니다: ${pattern}`,
          ),
        );
        continue;
      }
      if (!packedPaths.some((path) => isCoveredByFiles(path, [pattern]))) {
        problems.push(
          formatProblem(
            workspacePath,
            "files",
            `manifest files 항목에 대응하는 tarball 파일이 없습니다: ${pattern}`,
          ),
        );
      }
    }
  }

  const exports = validatedExportEntries(
    manifest.exports,
    workspacePath,
    problems,
  );
  for (const [subpath, targets] of exports) {
    for (const target of targets) {
      if (!target.startsWith("./")) {
        problems.push(
          formatProblem(
            workspacePath,
            "exports",
            `${subpath} target은 package 상대 경로여야 합니다: ${target}`,
          ),
        );
      } else if (!packed.has(normalizeArtifactPath(target))) {
        problems.push(
          formatProblem(
            workspacePath,
            "exports",
            `${subpath} target이 tarball에 없습니다: ${target}`,
          ),
        );
      }
    }

    const runtimes = targetsMatching(targets, /\.(?:mjs|cjs|js)$/u);
    const declarations = targetsMatching(targets, /\.d\.(?:mts|cts|ts)$/u);
    for (const runtimePath of runtimes) {
      const candidates = [...declarations, declarationFor(runtimePath)];
      if (!candidates.some((path) => packed.has(path))) {
        problems.push(
          formatProblem(
            workspacePath,
            "declaration",
            `${subpath} runtime target의 declaration이 없습니다: ${runtimePath}`,
          ),
        );
      }
    }
  }

  for (const binPath of binTargetsOf(manifest.bin)) {
    if (!packed.has(binPath)) {
      problems.push(
        formatProblem(
          workspacePath,
          "exports",
          `bin target이 tarball에 없습니다: ${binPath}`,
        ),
      );
    }
    if (!packed.has(declarationFor(binPath))) {
      problems.push(
        formatProblem(
          workspacePath,
          "declaration",
          `bin target의 declaration이 없습니다: ${binPath}`,
        ),
      );
    }
  }

  const sourceCandidates = packedPaths.filter((path) =>
    /(?:\.d\.(?:mts|cts|ts)|\.(?:mjs|cjs|js))$/u.test(path),
  );
  for (const sourcePath of sourceCandidates) {
    let source;
    try {
      source = await readFile(join(packageDir, sourcePath), "utf8");
    } catch {
      problems.push(
        formatProblem(
          workspacePath,
          "sourcemap",
          `tarball source를 읽을 수 없습니다: ${sourcePath}`,
        ),
      );
      continue;
    }
    for (const reference of sourceMapReferences(source)) {
      if (reference.startsWith("data:")) continue;
      if (/^[a-z][a-z+.-]*:/iu.test(reference)) {
        problems.push(
          formatProblem(
            workspacePath,
            "sourcemap",
            `외부 sourcemap URL은 검증할 수 없습니다: ${sourcePath}`,
          ),
        );
        continue;
      }
      const mapPath = posix.normalize(
        posix.join(posix.dirname(sourcePath), reference),
      );
      if (
        mapPath === ".." ||
        mapPath.startsWith("../") ||
        !packed.has(mapPath)
      ) {
        problems.push(
          formatProblem(
            workspacePath,
            "sourcemap",
            `참조한 sourcemap이 tarball에 없습니다: ${sourcePath} -> ${reference}`,
          ),
        );
      }
    }
  }
  for (const mapPath of packedPaths.filter((path) => path.endsWith(".map"))) {
    let sourceMap;
    try {
      sourceMap = JSON.parse(await readFile(join(packageDir, mapPath), "utf8"));
    } catch {
      problems.push(
        formatProblem(
          workspacePath,
          "sourcemap",
          `sourcemap JSON을 읽을 수 없습니다: ${mapPath}`,
        ),
      );
      continue;
    }
    if (
      typeof sourceMap !== "object" ||
      sourceMap === null ||
      Array.isArray(sourceMap) ||
      sourceMap.version !== 3 ||
      !Array.isArray(sourceMap.sources) ||
      !sourceMap.sources.every((source) => typeof source === "string") ||
      typeof sourceMap.mappings !== "string"
    ) {
      problems.push(
        formatProblem(
          workspacePath,
          "sourcemap",
          `${mapPath}: version 3, sources 문자열 배열, mappings 문자열이 필요합니다.`,
        ),
      );
    }
  }

  const forbiddenNames = new Set([
    ...LEGACY_FORBIDDEN_DEPENDENCIES,
    ...privateWorkspaceNames,
  ]);
  for (const field of DEPENDENCY_FIELDS) {
    const dependencies = manifest[field];
    if (typeof dependencies !== "object" || dependencies === null) continue;
    for (const [name, spec] of Object.entries(dependencies)) {
      if (forbiddenNames.has(name)) {
        problems.push(
          formatProblem(
            workspacePath,
            "dependencies",
            `${field}에 공개 불가능한 package가 남아 있습니다: ${name}`,
          ),
        );
      }
      if (typeof spec !== "string") {
        problems.push(
          formatProblem(
            workspacePath,
            "dependencies",
            `${field}[${JSON.stringify(name)}] spec은 문자열이어야 합니다.`,
          ),
        );
        continue;
      }
      if (/^(?:workspace|file|link):/u.test(spec)) {
        problems.push(
          formatProblem(
            workspacePath,
            "dependencies",
            `${field}[${JSON.stringify(name)}]에 공개 불가능한 spec이 남아 있습니다: ${spec}`,
          ),
        );
      }
      const aliasTarget = npmAliasTargetOf(spec);
      if (aliasTarget !== undefined && forbiddenNames.has(aliasTarget)) {
        problems.push(
          formatProblem(
            workspacePath,
            "dependencies",
            `${field} npm alias가 공개 불가능한 package를 가리킵니다: ${aliasTarget}`,
          ),
        );
      }
    }
  }

  return problems;
};

/** 공개 package를 stable workspace-path 순서로 pack하고 각각 검증한다. */
export const checkPublicWorkspacePackages = async ({
  repoRoot = defaultRepoRoot,
  readPackFiles = readNpmPackFiles,
} = {}) => {
  const workspaces = await discoverWorkspacePackages(repoRoot);
  const publicPackages = workspaces.filter(
    ({ manifest }) => manifest.private !== true,
  );
  const privateWorkspaceNames = new Set(
    workspaces
      .filter(({ manifest }) => manifest.private === true)
      .map(({ manifest }) => manifest.name)
      .filter((name) => typeof name === "string"),
  );
  const problems = [];
  let packedFileCount = 0;
  for (const packageInfo of publicPackages) {
    const packedPaths = await readPackFiles(packageInfo);
    if (!Array.isArray(packedPaths)) {
      throw new Error(
        `${packageInfo.workspacePath}의 npm pack 파일 목록이 배열이 아닙니다.`,
      );
    }
    packedFileCount += packedPaths.length;
    problems.push(
      ...(await validatePackage({
        ...packageInfo,
        packedPaths,
        privateWorkspaceNames,
      })),
    );
  }
  return {
    workspacePaths: publicPackages.map(({ workspacePath }) => workspacePath),
    packedFileCount,
    problems,
  };
};

const main = async () => {
  const result = await checkPublicWorkspacePackages();
  if (result.problems.length > 0) {
    console.error("check-package-files: FAIL\n");
    console.error(result.problems.join("\n"));
    process.exitCode = 1;
    return;
  }
  console.log(
    `check-package-files: OK (${result.workspacePaths.length}개 공개 package, ${result.packedFileCount}개 파일)`,
  );
};

const isMainModule =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMainModule) await main();
