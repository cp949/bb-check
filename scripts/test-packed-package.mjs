#!/usr/bin/env node
// @cp949/next-webpack-baseline tarball을 격리 소비자에 설치해 public facade를 검증한다.

import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageName = "@cp949/next-webpack-baseline";
const packageDir = join(repoRoot, "packages", "next-webpack-baseline");

export const parsePackageSelection = (args) => {
  if (args.length !== 2 || args[0] !== "--package" || args[1] !== packageName) {
    throw new Error(`사용법: npm run test-packed-package -- --package ${packageName}`);
  }
  return packageName;
};

export const forceActualNpmOperationEnv = (env) => ({ ...env, npm_config_dry_run: "false" });

export const createCommandInvocation = (command, args, options = {}) => {
  const { platform = process.platform, nodeExecPath = process.execPath } = options;
  if (platform !== "win32" || (command !== "npm" && command !== "npx")) return { command, args };
  const npmExecPath = Object.hasOwn(options, "npmExecPath") ? options.npmExecPath : process.env.npm_execpath;
  if (typeof npmExecPath !== "string" || npmExecPath.length === 0) throw new Error("Windows에서는 npm_execpath가 필요합니다.");
  const cli = command === "npm" ? npmExecPath : win32.join(win32.dirname(npmExecPath), "npx-cli.js");
  return { command: nodeExecPath, args: [cli, ...args] };
};

const run = (label, command, args, options = {}) => {
  const invocation = createCommandInvocation(command, args, options);
  const result = spawnSync(invocation.command, invocation.args, { encoding: "utf8", ...options });
  if (result.error) throw new Error(`${label} 실행 실패: ${result.error.message}`);
  return result;
};

const expectExitCode = (label, result, expected) => {
  if (result.status !== expected) throw new Error(`${label}: exit ${expected}가 아니라 ${result.status}입니다.\n${result.stdout}\n${result.stderr}`);
};

const expectNoUnresolvedModule = (label, result) => {
  const output = `${result.stdout}\n${result.stderr}`;
  if (/ERR_MODULE_NOT_FOUND|Cannot find (module|package)/u.test(output)) throw new Error(`${label}: unresolved dependency가 발견되었습니다.\n${output}`);
};

const main = async (args = process.argv.slice(2)) => {
  parsePackageSelection(args);
  const tmpRoot = await mkdtemp(join(tmpdir(), "packed-next-webpack-baseline-"));
  try {
    const packDir = join(tmpRoot, "pack");
    const consumerDir = join(tmpRoot, "consumer");
    await mkdir(packDir, { recursive: true });
    await mkdir(consumerDir, { recursive: true });
    const env = forceActualNpmOperationEnv(process.env);
    const pack = run("npm pack", "npm", ["pack", "--json", "--pack-destination", packDir], { cwd: packageDir, env });
    expectExitCode("npm pack", pack, 0);
    const [{ filename }] = JSON.parse(pack.stdout);
    const tgz = join(packDir, filename);
    await writeFile(join(consumerDir, "package.json"), JSON.stringify({ name: "next-webpack-baseline-consumer", version: "0.0.0", private: true, type: "module", browserslist: { production: ["chrome 75"] } }, null, 2));
    const install = run("npm install", "npm", ["install", "--save-dev", tgz, "--no-audit", "--no-fund", "--loglevel=error"], { cwd: consumerDir, env });
    expectExitCode("npm install", install, 0);
    for (const file of ["README.md", "LICENSE"]) await stat(join(consumerDir, "node_modules/@cp949/next-webpack-baseline", file));
    const source = `import { createNextWebpackBaseline, defineConfig } from "${packageName}";\nconst facade = createNextWebpackBaseline(defineConfig({ projectDir: process.cwd(), policy: [] }));\nif (JSON.stringify(Object.keys(facade)) !== JSON.stringify(["transpilePackages", "webpackPlugin"])) throw new Error("facade keys mismatch");\nif (typeof facade.webpackPlugin({ dev: false }).apply !== "function") throw new Error("plugin mismatch");`;
    const result = run("isolated facade import", "node", ["--input-type=module", "-e", source], { cwd: consumerDir });
    expectExitCode("isolated facade import", result, 0);
    expectNoUnresolvedModule("isolated facade import", result);
    console.log(`test-packed-package: OK (${packageName}, 격리 설치, root facade import 확인)`);
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
};

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((cause) => {
    console.error("test-packed-package: FAIL\n");
    console.error(cause instanceof Error ? cause.stack ?? cause.message : String(cause));
    process.exitCode = 1;
  });
}
