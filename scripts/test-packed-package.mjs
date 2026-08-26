#!/usr/bin/env node
// 공개 package tarball을 격리 소비자에 설치해 public facade와 (있다면) bin
// entry point를 검증한다. `--package <이름>`으로 두 공개 package 중 하나를
// 선택한다 — 이름마다 별도 시나리오를 실행하므로 패키지 사이에 assertion을
// 공유하지 않는다.

import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** `--package`가 선택할 수 있는 공개 package와 각 workspace 디렉터리. */
export const packageTable = {
  "@cp949/next-webpack-baseline": {
    workspaceDir: join(repoRoot, "packages", "next-webpack-baseline"),
  },
  "@cp949/legacy-browser-smoke": {
    workspaceDir: join(repoRoot, "packages", "legacy-browser-smoke"),
  },
};

const usage = () =>
  new Error(
    `사용법: npm run test-packed-package -- --package <${Object.keys(
      packageTable,
    ).join(" | ")}>`,
  );

export const parsePackageSelection = (args) => {
  if (
    args.length !== 2 ||
    args[0] !== "--package" ||
    !Object.hasOwn(packageTable, args[1])
  ) {
    throw usage();
  }
  return args[1];
};

export const forceActualNpmOperationEnv = (env) => ({
  ...env,
  npm_config_dry_run: "false",
});

export const createCommandInvocation = (command, args, options = {}) => {
  const { platform = process.platform, nodeExecPath = process.execPath } =
    options;
  if (platform !== "win32" || (command !== "npm" && command !== "npx"))
    return { command, args };
  const npmExecPath = Object.hasOwn(options, "npmExecPath")
    ? options.npmExecPath
    : process.env.npm_execpath;
  if (typeof npmExecPath !== "string" || npmExecPath.length === 0)
    throw new Error("Windows에서는 npm_execpath가 필요합니다.");
  const cli =
    command === "npm"
      ? npmExecPath
      : win32.join(win32.dirname(npmExecPath), "npx-cli.js");
  return { command: nodeExecPath, args: [cli, ...args] };
};

const run = (label, command, args, options = {}) => {
  const invocation = createCommandInvocation(command, args, options);
  const result = spawnSync(invocation.command, invocation.args, {
    encoding: "utf8",
    ...options,
  });
  if (result.error)
    throw new Error(`${label} 실행 실패: ${result.error.message}`);
  return result;
};

const expectExitCode = (label, result, expected) => {
  if (result.status !== expected)
    throw new Error(
      `${label}: exit ${expected}가 아니라 ${result.status}입니다.\n${result.stdout}\n${result.stderr}`,
    );
};

const expectNoUnresolvedModule = (label, result) => {
  const output = `${result.stdout}\n${result.stderr}`;
  if (/ERR_MODULE_NOT_FOUND|Cannot find (module|package)/u.test(output))
    throw new Error(
      `${label}: unresolved dependency가 발견되었습니다.\n${output}`,
    );
};

/** 지정한 workspace를 pack해 packDir에 tarball을 만들고 절대 경로를 돌려준다. */
const packTarball = (workspaceDir, packDir, env) => {
  const pack = run(
    "npm pack",
    "npm",
    ["pack", "--json", "--pack-destination", packDir],
    { cwd: workspaceDir, env },
  );
  expectExitCode("npm pack", pack, 0);
  const [{ filename }] = JSON.parse(pack.stdout);
  return join(packDir, filename);
};

/** 격리 consumer에 tarball을 설치한다. */
const installTarball = (consumerDir, tgz, env) => {
  const install = run(
    "npm install",
    "npm",
    [
      "install",
      "--save-dev",
      tgz,
      "--no-audit",
      "--no-fund",
      "--loglevel=error",
    ],
    { cwd: consumerDir, env },
  );
  expectExitCode("npm install", install, 0);
};

/**
 * `@cp949/next-webpack-baseline` 시나리오. consumer의 production browserslist,
 * README/LICENSE 존재, root facade의 own-keys와 `webpackPlugin` 형태를
 * 격리된 node process에서 확인한다.
 */
const runNextWebpackBaselineScenario = async ({ consumerDir, tgz, env }) => {
  const packageName = "@cp949/next-webpack-baseline";
  await writeFile(
    join(consumerDir, "package.json"),
    JSON.stringify(
      {
        name: "next-webpack-baseline-consumer",
        version: "0.0.0",
        private: true,
        type: "module",
        browserslist: { production: ["chrome 75"] },
      },
      null,
      2,
    ),
  );
  installTarball(consumerDir, tgz, env);
  for (const file of ["README.md", "LICENSE"])
    await stat(join(consumerDir, "node_modules", packageName, file));

  const source = `import { createNextWebpackBaseline, defineConfig } from "${packageName}";\nconst facade = createNextWebpackBaseline(defineConfig({ projectDir: process.cwd(), policy: [] }));\nif (JSON.stringify(Object.keys(facade)) !== JSON.stringify(["transpilePackages", "webpackPlugin"])) throw new Error("facade keys mismatch");\nif (typeof facade.webpackPlugin({ dev: false }).apply !== "function") throw new Error("plugin mismatch");`;
  const result = run(
    "isolated facade import",
    "node",
    ["--input-type=module", "-e", source],
    { cwd: consumerDir },
  );
  expectExitCode("isolated facade import", result, 0);
  expectNoUnresolvedModule("isolated facade import", result);

  console.log(
    `test-packed-package: OK (${packageName}, 격리 설치, root facade import 확인)`,
  );
};

/**
 * `@cp949/legacy-browser-smoke` 시나리오. browserslist는 필요 없다. README/
 * LICENSE 존재, root facade own-keys, `Reflect.ownKeys(facade)`가
 * `["run", "selfTest"]`인지를 격리된 node process에서 확인하고, 마지막으로
 * 설치된 bin entry point의 `--help` 경로가 exit 0인지만 본다 — 브라우저는
 * 실행하지 않는다.
 */
const runLegacyBrowserSmokeScenario = async ({ consumerDir, tgz, env }) => {
  const packageName = "@cp949/legacy-browser-smoke";
  await writeFile(
    join(consumerDir, "package.json"),
    JSON.stringify(
      {
        name: "legacy-browser-smoke-consumer",
        version: "0.0.0",
        private: true,
        type: "module",
      },
      null,
      2,
    ),
  );
  installTarball(consumerDir, tgz, env);
  for (const file of ["README.md", "LICENSE"])
    await stat(join(consumerDir, "node_modules", packageName, file));

  // 네이티브 ESM의 Module Namespace Exotic Object는 Object.keys()를 선언
  // 순서가 아니라 코드 포인트 알파벳 순으로 정렬해 돌려준다(spec 동작). 즉
  // "createLegacyBrowserSmoke" < "defineSmokeConfig"다. src/index.ts를 직접
  // 읽는 Vitest 쪽 테스트는 Vite의 module runner를 통해 선언 순서를 그대로
  // 보여주므로 순서가 다르게 보이는 것뿐이며, 여기서는 실제 설치된 tarball을
  // 네이티브 Node로 import하므로 정렬된 순서가 옳다(로컬 실행으로 실측).
  const source = `const packageRoot = await import("${packageName}");\nif (JSON.stringify(Object.keys(packageRoot)) !== JSON.stringify(["createLegacyBrowserSmoke", "defineSmokeConfig"])) throw new Error("package root keys mismatch: " + JSON.stringify(Object.keys(packageRoot)));\nconst config = packageRoot.defineSmokeConfig({ pages: [{ name: "placeholder", path: "/", ready: { kind: "expression", expression: "true" } }], timeoutMs: 10000 });\nconst facade = packageRoot.createLegacyBrowserSmoke(config);\nif (JSON.stringify(Reflect.ownKeys(facade)) !== JSON.stringify(["run", "selfTest"])) throw new Error("facade keys mismatch");`;
  const result = run(
    "isolated facade import",
    "node",
    ["--input-type=module", "-e", source],
    { cwd: consumerDir },
  );
  expectExitCode("isolated facade import", result, 0);
  expectNoUnresolvedModule("isolated facade import", result);

  // `--help`만 실행한다 — 실제 self-test(고정 Chromium 실행)는 human gate다.
  const help = run(
    "bin --help gate",
    "npx",
    ["legacy-browser-smoke-self-test", "--help"],
    { cwd: consumerDir },
  );
  expectExitCode("bin --help gate", help, 0);

  console.log(
    `test-packed-package: OK (${packageName}, 격리 설치, root facade import와 bin --help 확인)`,
  );
};

const scenariosByPackage = {
  "@cp949/next-webpack-baseline": runNextWebpackBaselineScenario,
  "@cp949/legacy-browser-smoke": runLegacyBrowserSmokeScenario,
};

const main = async (args = process.argv.slice(2)) => {
  const packageName = parsePackageSelection(args);
  const { workspaceDir } = packageTable[packageName];
  const tmpRoot = await mkdtemp(join(tmpdir(), "test-packed-package-"));
  try {
    const packDir = join(tmpRoot, "pack");
    const consumerDir = join(tmpRoot, "consumer");
    await mkdir(packDir, { recursive: true });
    await mkdir(consumerDir, { recursive: true });
    const env = forceActualNpmOperationEnv(process.env);
    const tgz = packTarball(workspaceDir, packDir, env);
    await scenariosByPackage[packageName]({ consumerDir, tgz, env });
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
