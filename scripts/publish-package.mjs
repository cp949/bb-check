import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const rootDirectory = resolve(import.meta.dirname, "..");
const packageName = "@cp949/bb-check";
const packageDirectory = "packages/bb-check";
const publishSpec = `./${packageDirectory}`;

export function createCommandInvocation(
  command,
  args,
  { platform = process.platform, npmExecPath = process.env.npm_execpath } = {},
) {
  if (platform !== "win32" || command !== "npm") return { command, args };
  if (typeof npmExecPath !== "string" || npmExecPath.length === 0) {
    throw new Error(
      "Windows에서는 npm_execpath가 필요합니다. npm run publish:npm으로 실행하세요.",
    );
  }
  return { command: process.execPath, args: [npmExecPath, ...args] };
}

function run(command, args, { capture = false } = {}) {
  const invocation = createCommandInvocation(command, args);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: rootDirectory,
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
  });

  if (result.error) throw result.error;
  return result;
}

export function parsePublishArguments(argv) {
  const options = { action: "menu", dryRun: false };

  for (const argument of argv) {
    if (argument === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (argument !== "--publish") {
      throw new Error(`알 수 없는 인자입니다: ${argument}`);
    }
    if (options.action !== "menu") {
      throw new Error("동작 인자는 하나만 지정합니다: --publish, --publish");
    }
    options.action = "publish";
  }

  if (options.dryRun && options.action === "menu") {
    options.action = "publish";
  }
  return options;
}

export function classifyRegistryVersionResult(result) {
  if (result.status === 0) {
    const version = result.stdout.trim();
    return version === ""
      ? { status: "error", reason: "empty response" }
      : { status: "published", version };
  }

  const errorCode = result.stderr
    .match(/(?:^|\s)code\s+([A-Z0-9_]+)/i)?.[1]
    ?.toUpperCase();
  if (errorCode === "E404") return { status: "missing" };
  return {
    status: "error",
    reason: errorCode ?? `exit ${result.status ?? "unknown"}`,
  };
}

export function planPublish({ dryRun, registryLookup }) {
  if (dryRun || registryLookup.status === "missing") {
    return { action: "proceed" };
  }
  if (registryLookup.status === "published") {
    return {
      action: "abort",
      reason: `${packageName}@${registryLookup.version}은 이미 배포되어 있습니다.`,
    };
  }
  return {
    action: "abort",
    reason: `registry 조회에 실패해 실제 배포를 중단합니다: ${registryLookup.reason}`,
  };
}

export function publishPackage(
  version,
  dryRun,
  registryLookup,
  runCommand = run,
) {
  const plan = planPublish({ dryRun, registryLookup });
  if (plan.action === "abort") {
    console.log(plan.reason);
    return false;
  }

  console.log("\n$ npm run verify:release");
  const verified = runCommand("npm", ["run", "verify:release"]);
  if (verified.status !== 0) {
    console.log("\nrelease 전체 검증에 실패해 배포를 중단합니다.");
    return false;
  }

  if (!dryRun) {
    console.log("\n$ npm whoami");
    const authenticated = runCommand("npm", ["whoami"]);
    if (authenticated.status !== 0) {
      console.log("\nnpm 인증을 확인할 수 없어 실제 배포를 중단합니다.");
      return false;
    }
  }

  const args = ["publish", publishSpec, "--access", "public"];
  if (dryRun) args.push("--dry-run");

  console.log(`\n$ npm ${args.join(" ")}`);
  const published = runCommand("npm", args);
  if (published.status !== 0) {
    console.log(`\n${packageName} 배포에 실패했습니다.`);
    return false;
  }

  console.log(
    dryRun
      ? `\n${packageName}@${version} dry-run이 성공했습니다. 실제 배포는 되지 않았습니다.`
      : `\n${packageName}@${version} 배포 명령이 성공했습니다.`,
  );
  return true;
}

function readRegistryVersion(version) {
  return classifyRegistryVersionResult(
    run("npm", ["view", `${packageName}@${version}`, "version"], {
      capture: true,
    }),
  );
}

function formatRegistryStatus(lookup) {
  if (lookup.status === "published") return `배포됨 (${lookup.version})`;
  if (lookup.status === "missing") return "미배포";
  return `조회 실패 (${lookup.reason})`;
}

async function runMenu(version) {
  let registryLookup = readRegistryVersion(version);
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    for (;;) {
      console.log(`\n=== ${packageName} 배포 도구 · release ${version} ===`);
      console.log(`  registry: ${formatRegistryStatus(registryLookup)}`);
      console.log("  1) 전체 검증");
      console.log("  2) dry-run 배포");
      console.log("  3) 배포");
      console.log("  4) registry 상태 새로고침");
      console.log("  q) 종료\n");

      const choice = (await rl.question("선택: ")).trim().toLowerCase();
      if (choice === "" || choice === "q") return;
      if (choice === "1") run("npm", ["run", "verify:release"]);
      else if (choice === "2") publishPackage(version, true, registryLookup);
      else if (choice === "3") publishPackage(version, false, registryLookup);
      else if (choice === "4") registryLookup = readRegistryVersion(version);
      else console.log(`알 수 없는 선택입니다: ${choice}`);
    }
  } finally {
    rl.close();
  }
}

async function main() {
  const options = parsePublishArguments(process.argv.slice(2));
  const manifest = JSON.parse(
    await readFile(
      resolve(rootDirectory, packageDirectory, "package.json"),
      "utf8",
    ),
  );
  const version = manifest.version;
  if (typeof version !== "string" || version.length === 0) {
    throw new Error("release version이 비어 있습니다.");
  }

  if (options.action === "publish") {
    const registryLookup = readRegistryVersion(version);
    if (!publishPackage(version, options.dryRun, registryLookup)) {
      process.exitCode = 1;
    }
    return;
  }

  if (!process.stdin.isTTY) {
    throw new Error("대화형 메뉴를 쓸 수 없습니다. --publish를 지정하세요.");
  }
  await runMenu(version);
}

if (resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
