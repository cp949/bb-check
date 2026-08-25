#!/usr/bin/env node
// 선택한 공개 package가 "이 패키지만 설치한 새 프로젝트"에서 실제로
// 동작하는지 검증한다. workspace symlink나 Vite resolver를 거치지 않는,
// 진짜 격리된 소비자를 흉내낸다. 인자가 없으면 기존 bb-check를 선택한다.
//
//   1. `npm pack`으로 실제 tgz를 만든다.
//   2. mkdtemp로 만든 빈 프로젝트에 그 tgz와 esbuild를 dev dependency로
//      `npm install`한다(레지스트리에서 5개 runtime external도 함께 설치됨).
//   3. `node -e 'import(...)'`로 두 공개 entry가 로드되는지 확인한다.
//   4. 설치된 `bb-check` bin이 shebang·실행 권한을 갖고 동작하는지 확인한다.
//   5. npm README의 최소 흐름대로 pass/fail source를 esbuild로 빌드한 뒤
//      `library check`를 실행해 exit code 0/1을 확인한다 — bb-core/
//      bb-library가 제대로 번들되어 있지 않으면 이 단계에서
//      ERR_MODULE_NOT_FOUND로 드러난다.
//
// 임시 디렉터리는 성공·실패 관계없이 finally에서 제거한다.

import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// `new URL(...)` global 대신 fileURLToPath + dirname을 쓴다 — 저장소
// eslint globals 설정(process/console만 허용)과 충돌하지 않는다.
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const PACKAGE_DIR_NAMES = new Map([
  ["@cp949/bb-check", "bb-check"],
  ["@cp949/next-webpack-baseline", "next-webpack-baseline"],
]);

/** `--package <name>`을 해석한다. 인자가 없으면 기존 package를 유지한다. */
export const parsePackageSelection = (args) => {
  if (args.length === 0) return "@cp949/bb-check";
  if (args.length !== 2 || args[0] !== "--package" || args[1] === undefined) {
    throw new Error(
      "사용법: npm run test-packed-package -- --package <npm-package-name>",
    );
  }
  if (!PACKAGE_DIR_NAMES.has(args[1])) {
    throw new Error(`지원하지 않는 공개 package입니다: ${args[1]}`);
  }
  return args[1];
};

/** 상위 npm publish --dry-run 설정을 내부 pack/install에 전파하지 않는다. */
export const forceActualNpmOperationEnv = (env) => ({
  ...env,
  npm_config_dry_run: "false",
});

/** Windows npm/npx는 shell을 쓰지 않고 각 CLI를 Node로 직접 실행한다. */
export const createCommandInvocation = (command, args, options = {}) => {
  const { platform = process.platform, nodeExecPath = process.execPath } =
    options;
  if (platform !== "win32" || (command !== "npm" && command !== "npx")) {
    return { command, args };
  }
  const configuredNpmExecPath = Object.hasOwn(options, "npmExecPath")
    ? options.npmExecPath
    : process.env.npm_execpath;
  const npmCliPath =
    typeof configuredNpmExecPath === "string" &&
    configuredNpmExecPath.length > 0
      ? configuredNpmExecPath
      : win32.join(
          win32.dirname(nodeExecPath),
          "node_modules",
          "npm",
          "bin",
          "npm-cli.js",
        );
  const cliPath =
    command === "npm"
      ? npmCliPath
      : win32.join(win32.dirname(npmCliPath), "npx-cli.js");
  return { command: nodeExecPath, args: [cliPath, ...args] };
};

/** 실패 시 stdout/stderr을 포함한 진단 메시지로 던진다. */
const run = (label, command, args, options) => {
  const invocation = createCommandInvocation(command, args);
  const result = spawnSync(invocation.command, invocation.args, {
    encoding: "utf8",
    ...options,
  });
  if (result.error) {
    throw new Error(`${label} 실행 실패: ${result.error.message}`);
  }
  return result;
};

/** exit code가 expected와 다르면 stdout/stderr을 포함해 던진다. */
const expectExitCode = (label, result, expected) => {
  if (result.status !== expected) {
    throw new Error(
      `${label}: exit ${expected}를 기대했지만 ${result.status}였다.\n` +
        `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
};

/** stdout+stderr 어디에도 module-resolution 실패의 흔적이 없는지 확인한다. */
const expectNoUnresolvedModule = (label, result) => {
  const combined = `${result.stdout}\n${result.stderr}`;
  if (/ERR_MODULE_NOT_FOUND|Cannot find (module|package)/.test(combined)) {
    throw new Error(
      `${label}: 번들에 남은 미해결 dependency로 보이는 오류가 발견됐다.\n${combined}`,
    );
  }
};

/** 기존 consumer manifest를 보존하며 browserslist와 src/index.js fixture를 쓴다. */
const writeSourceFixture = async (dir, browserslist, source) => {
  const manifestPath = join(dir, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(
    manifestPath,
    `${JSON.stringify({ ...manifest, browserslist }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(join(dir, "src", "index.js"), source, "utf8");
};

const verifyInstalledDocs = async (consumerDir, packageName) => {
  const installedPackageDir = join(
    consumerDir,
    "node_modules",
    ...packageName.split("/"),
  );
  for (const name of ["README.md", "LICENSE"]) {
    await stat(join(installedPackageDir, name)).catch(() => {
      throw new Error(`설치된 ${packageName} package에 ${name}이 없다.`);
    });
  }
};

const verifyNextWebpackBaseline = (consumerDir) => {
  const source = [
    'import { createNextWebpackBaseline, defineConfig } from "@cp949/next-webpack-baseline";',
    "const config = defineConfig({",
    "  projectDir: process.cwd(),",
    '  policy: [{ package: "example-package", reason: "legacy syntax check" }],',
    "});",
    "const facade = createNextWebpackBaseline(config);",
    'if (JSON.stringify(Object.keys(facade)) !== JSON.stringify(["transpilePackages", "webpackPlugin"])) throw new Error("facade keys mismatch");',
    'if (JSON.stringify(facade.transpilePackages) !== JSON.stringify(["example-package"])) throw new Error("transpilePackages mismatch");',
    'if (typeof facade.webpackPlugin({ dev: false }).apply !== "function") throw new Error("webpack plugin mismatch");',
  ].join("\n");
  const result = run(
    "node -e next-webpack-baseline facade",
    "node",
    ["--input-type=module", "-e", source],
    { cwd: consumerDir },
  );
  expectExitCode("node -e next-webpack-baseline facade", result, 0);
  expectNoUnresolvedModule("node -e next-webpack-baseline facade", result);
};

const main = async (args = process.argv.slice(2)) => {
  const packageName = parsePackageSelection(args);
  const packageDirName = PACKAGE_DIR_NAMES.get(packageName);
  if (packageDirName === undefined) {
    throw new Error(`package directory를 찾을 수 없습니다: ${packageName}`);
  }
  const packageDir = join(repoRoot, "packages", packageDirName);
  const tmpRoot = await mkdtemp(join(tmpdir(), "packed-package-consumer-"));
  try {
    const packDestDir = join(tmpRoot, "pack");
    const consumerDir = join(tmpRoot, "consumer");
    await mkdir(packDestDir, { recursive: true });
    await mkdir(consumerDir, { recursive: true });

    // 1. 실제 tgz를 만든다(--dry-run 아님).
    const packResult = run(
      "npm pack",
      "npm",
      ["pack", "--json", "--pack-destination", packDestDir],
      { cwd: packageDir, env: forceActualNpmOperationEnv(process.env) },
    );
    expectExitCode("npm pack", packResult, 0);
    const [{ filename }] = JSON.parse(packResult.stdout);
    const tgzPath = join(packDestDir, filename);

    // 2. README 최소 예제와 같은 source/build/exports 구조의 빈 프로젝트를
    //    만들고 tgz와 esbuild를 dev dependency로 실제 설치한다. esbuild는
    //    package가 검증한 고정 버전을 직접 설치해 registry latest 변동을
    //    release gate에 섞지 않는다. workspace symlink는 전혀 거치지 않는다.
    const consumerManifest =
      packageName === "@cp949/bb-check"
        ? {
            name: "bb-check-isolated-consumer",
            version: "0.0.0",
            private: true,
            type: "module",
            exports: "./dist/index.js",
            scripts: {
              build:
                "esbuild src/index.js --bundle --format=esm --target=chrome80 --outfile=dist/index.js",
            },
            browserslist: ["Chrome >= 80"],
          }
        : {
            name: "next-webpack-baseline-isolated-consumer",
            version: "0.0.0",
            private: true,
            type: "module",
            browserslist: { production: ["chrome 75"] },
          };
    await writeFile(
      join(consumerDir, "package.json"),
      JSON.stringify(consumerManifest, null, 2),
      "utf8",
    );
    const packageManifest = JSON.parse(
      await readFile(join(packageDir, "package.json"), "utf8"),
    );
    const extraInstallSpecs = [];
    if (packageName === "@cp949/bb-check") {
      const esbuildVersion = packageManifest.dependencies?.esbuild;
      if (typeof esbuildVersion !== "string" || esbuildVersion.length === 0) {
        throw new Error("@cp949/bb-check package.json에 esbuild 버전이 없다.");
      }
      extraInstallSpecs.push(`esbuild@${esbuildVersion}`);
    }
    const installResult = run(
      "npm install",
      "npm",
      [
        "install",
        "--save-dev",
        tgzPath,
        ...extraInstallSpecs,
        "--no-audit",
        "--no-fund",
        "--loglevel=error",
      ],
      { cwd: consumerDir, env: forceActualNpmOperationEnv(process.env) },
    );
    expectExitCode("npm install", installResult, 0);

    await verifyInstalledDocs(consumerDir, packageName);
    if (packageName === "@cp949/next-webpack-baseline") {
      verifyNextWebpackBaseline(consumerDir);
      console.log(
        "test-packed-package: OK (@cp949/next-webpack-baseline, 격리 설치, root facade import 확인)",
      );
      return;
    }

    // 3. 공개 entry 두 개가 로드되는지 확인한다.
    const importIndex = run(
      "node -e import(index)",
      "node",
      ["-e", 'import("@cp949/bb-check")'],
      { cwd: consumerDir },
    );
    expectExitCode("node -e import(@cp949/bb-check)", importIndex, 0);
    expectNoUnresolvedModule("node -e import(@cp949/bb-check)", importIndex);

    const importLibrary = run(
      "node -e import(library)",
      "node",
      ["-e", 'import("@cp949/bb-check/library")'],
      { cwd: consumerDir },
    );
    expectExitCode("node -e import(@cp949/bb-check/library)", importLibrary, 0);
    expectNoUnresolvedModule(
      "node -e import(@cp949/bb-check/library)",
      importLibrary,
    );

    // 4. 설치된 bin이 shebang과 실행 권한을 갖는지 확인한다.
    const binPath = join(consumerDir, "node_modules", ".bin", "bb-check");
    const binStat = await stat(binPath);
    if (process.platform !== "win32" && (binStat.mode & 0o111) === 0) {
      throw new Error(
        `설치된 bb-check bin에 실행 권한이 없다: mode=${binStat.mode.toString(8)}`,
      );
    }
    const cliDistPath = join(
      consumerDir,
      "node_modules",
      "@cp949",
      "bb-check",
      "dist",
      "cli.js",
    );
    const cliFirstLine = (await readFile(cliDistPath, "utf8")).split("\n")[0];
    if (cliFirstLine !== "#!/usr/bin/env node") {
      throw new Error(
        `dist/cli.js 첫 줄이 shebang이 아니다: ${JSON.stringify(cliFirstLine)}`,
      );
    }

    // README.md/LICENSE도 실제로 설치됐는지 확인한다(README는 package가
    // 소유하고 LICENSE는 `prepack`이 저장소 루트에서 복사한다 —
    // check-package-files.mjs가 tarball manifest 수준에서 이미 검사하지만,
    // 여기서는 실제 설치 결과로도 다시 확인한다).
    // --help가 미해결 dependency 없이 standalone으로 로드·실행되고, 셸
    // 관례대로 exit 0으로 끝나는지 확인한다(usage ERROR가 아니라 usage
    // REQUEST이므로 0이 맞다 — CLI 자체가 --help/-h를 명시적으로 처리한다).
    const helpResult = run(
      "npx bb-check --help",
      "npx",
      ["--no-install", "bb-check", "--help"],
      { cwd: consumerDir },
    );
    expectNoUnresolvedModule("npx bb-check --help", helpResult);
    if (helpResult.status !== 0) {
      throw new Error(
        `npx bb-check --help: exit 0을 기대했지만 ${helpResult.status}이었다.\n` +
          `stdout:\n${helpResult.stdout}\nstderr:\n${helpResult.stderr}`,
      );
    }
    if (!helpResult.stdout.includes("사용법:")) {
      throw new Error(
        `npx bb-check --help: stdout에 사용법 안내가 없다.\nstdout:\n${helpResult.stdout}`,
      );
    }

    // --version도 같은 계약(exit 0, stdout에 버전)을 지키는지 확인한다.
    const versionResult = run(
      "npx bb-check --version",
      "npx",
      ["--no-install", "bb-check", "--version"],
      { cwd: consumerDir },
    );
    expectNoUnresolvedModule("npx bb-check --version", versionResult);
    if (versionResult.status !== 0) {
      throw new Error(
        `npx bb-check --version: exit 0을 기대했지만 ${versionResult.status}이었다.\n` +
          `stdout:\n${versionResult.stdout}\nstderr:\n${versionResult.stderr}`,
      );
    }
    if (versionResult.stdout.trim().length === 0) {
      throw new Error(
        `npx bb-check --version: stdout이 비어 있다(버전 문자열을 기대함).`,
      );
    }

    // 5. README의 source -> esbuild build -> library check 흐름을 pass/fail
    //    fixture 각각에 대해 실행한다. config도 공개 defineConfig entry를
    //    사용하며, --config/--dir 없이 소비자 프로젝트 루트에서 찾는다.
    await writeFile(
      join(consumerDir, "bb-check.config.mjs"),
      [
        'import { defineConfig } from "@cp949/bb-check";',
        "",
        "export default defineConfig({",
        '  library: { projectDir: ".", allow: [] },',
        "});",
        "",
      ].join("\n"),
      "utf8",
    );

    await writeSourceFixture(
      consumerDir,
      ["Chrome >= 80"],
      "export const add = (left, right) => left + right;\n",
    );
    const passBuildResult = run(
      "npm run build (pass fixture)",
      "npm",
      ["run", "build"],
      { cwd: consumerDir },
    );
    expectExitCode("npm run build (pass fixture)", passBuildResult, 0);
    const passResult = run(
      "npx bb-check library check (pass fixture)",
      "npx",
      ["--no-install", "bb-check", "library", "check"],
      { cwd: consumerDir },
    );
    expectNoUnresolvedModule("library check (pass fixture)", passResult);
    expectExitCode("library check (pass fixture)", passResult, 0);
    if (!passResult.stdout.includes("통과")) {
      throw new Error(
        `pass fixture 보고서에 "통과"가 없다.\nstdout:\n${passResult.stdout}`,
      );
    }

    await writeSourceFixture(
      consumerDir,
      ["Chrome >= 50"],
      [
        "export function greet(person) {",
        '  return person?.name ?? "guest";',
        "}",
        "",
      ].join("\n"),
    );
    const failBuildResult = run(
      "npm run build (fail fixture)",
      "npm",
      ["run", "build"],
      { cwd: consumerDir },
    );
    expectExitCode("npm run build (fail fixture)", failBuildResult, 0);
    const failResult = run(
      "npx bb-check library check (fail fixture)",
      "npx",
      ["--no-install", "bb-check", "library", "check"],
      { cwd: consumerDir },
    );
    expectNoUnresolvedModule("library check (fail fixture)", failResult);
    expectExitCode("library check (fail fixture)", failResult, 1);
    if (!failResult.stdout.includes("위반")) {
      throw new Error(
        `fail fixture 보고서에 "위반"이 없다.\nstdout:\n${failResult.stdout}`,
      );
    }
    if (!failResult.stdout.includes("syntax-divergence")) {
      throw new Error(
        `fail fixture 보고서에 syntax-divergence가 없다.\nstdout:\n${failResult.stdout}`,
      );
    }

    console.log(
      "test-packed-package: OK (@cp949/bb-check, 격리 설치, entry import 2건, bin 실행, source build 2건, pass/fail exit code 모두 확인)",
    );
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
};

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((cause) => {
    console.error("test-packed-package: FAIL\n");
    console.error(
      cause instanceof Error ? (cause.stack ?? cause.message) : String(cause),
    );
    process.exitCode = 1;
  });
}
