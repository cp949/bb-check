import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDirectory = resolve(import.meta.dirname, "..");
// 배포를 허용하는 package와 그 package를 배포하기 전에 실행할 verify script를
// 한 테이블에서 함께 관리한다. @cp949/legacy-browser-smoke처럼 새 package를
// 여기에 추가하려면 같은 변경에서 그 package 전용 verify script도 지정해야
// 하고, 그 script는 최소한 해당 package의 packed tarball 검증
// (`npm run test-packed-package -- --package <이름>`)을 포함해야 한다.
// 현재 verify:next-release는 next-webpack-baseline tarball만 검증한다.
const allowedPackages = new Map([
  [
    "@cp949/next-webpack-baseline",
    {
      packageDirectory: "packages/next-webpack-baseline",
      verifyScript: "verify:next-release",
    },
  ],
]);
const defaultSelectedPackage = {
  packageName: "@cp949/next-webpack-baseline",
  packageDirectory: "packages/next-webpack-baseline",
  publishSpec: "./packages/next-webpack-baseline",
  verifyScript: "verify:next-release",
};

export function selectPublishPackage(packageName, manifest) {
  const entry = allowedPackages.get(packageName);
  if (entry === undefined) {
    throw new Error(`허용하지 않은 package입니다: ${packageName}`);
  }
  if (manifest.private === true) {
    throw new Error(`private package는 배포할 수 없습니다: ${packageName}`);
  }
  if (manifest.name !== packageName) {
    throw new Error(
      `package 이름이 manifest와 일치하지 않습니다: ${packageName}`,
    );
  }
  return {
    packageName,
    packageDirectory: entry.packageDirectory,
    publishSpec: `./${entry.packageDirectory}`,
    verifyScript: entry.verifyScript,
  };
}

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

function run(command, args, { capture = false, env = process.env } = {}) {
  const invocation = createCommandInvocation(command, args);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: rootDirectory,
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
    env,
  });

  if (result.error) throw result.error;
  return result;
}

export function parsePublishArguments(argv) {
  let packageName;
  let publish = false;
  let confirmed = false;
  let explicitDryRun = false;
  const seenActionFlags = new Set();

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--package") {
      if (packageName !== undefined) {
        throw new Error("--package는 하나만 지정하세요.");
      }
      packageName = argv[index + 1];
      if (packageName === undefined || packageName.startsWith("--")) {
        throw new Error("--package 뒤에 package 이름을 지정하세요.");
      }
      index += 1;
      continue;
    }
    if (argument === "--dry-run") {
      if (seenActionFlags.has(argument)) {
        throw new Error(`${argument} 중복은 허용하지 않습니다.`);
      }
      seenActionFlags.add(argument);
      explicitDryRun = true;
      continue;
    }
    if (argument === "--publish") {
      if (seenActionFlags.has(argument)) {
        throw new Error(`${argument} 중복은 허용하지 않습니다.`);
      }
      seenActionFlags.add(argument);
      publish = true;
      continue;
    }
    if (argument === "--confirm-publish") {
      if (seenActionFlags.has(argument)) {
        throw new Error(`${argument} 중복은 허용하지 않습니다.`);
      }
      seenActionFlags.add(argument);
      confirmed = true;
      continue;
    }
    throw new Error(`알 수 없는 인자입니다: ${argument}`);
  }

  if (packageName === undefined) {
    throw new Error("--package로 배포 package 이름을 명시하세요.");
  }
  if (explicitDryRun && publish) {
    throw new Error("--dry-run과 --publish는 함께 사용할 수 없습니다.");
  }
  if (publish && !confirmed) {
    throw new Error("실제 publish에는 --confirm-publish가 필요합니다.");
  }
  if (!publish && confirmed) {
    throw new Error("--confirm-publish는 --publish와 함께 사용하세요.");
  }
  return { packageName, dryRun: !publish, confirmed };
}

export function validatePublishLifecycle(environment) {
  if (
    environment.npm_config_dry_run === "true" ||
    environment.NWB_PUBLISH_CONFIRMED === "1"
  ) {
    return;
  }
  throw new Error(
    "[NWB_PUBLISH_DIRECT_DENIED] 실제 publish는 root publish:npm wrapper로만 실행하세요.",
  );
}

const hasReleasePatterns = (environment) =>
  (environment.BB_CHECK_FORBIDDEN_WORDS ?? "")
    .split(",")
    .some((word) => word.trim().length > 0);

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

export function planPublish({
  dryRun,
  registryLookup,
  packageName = "package",
}) {
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
  selectedPackage = defaultSelectedPackage,
  confirmed = false,
  environment = process.env,
) {
  const { packageName, publishSpec, verifyScript } = selectedPackage;
  if (typeof verifyScript !== "string" || verifyScript.length === 0) {
    console.log(
      `${packageName}의 release 검증 script를 알 수 없어 배포를 중단합니다.`,
    );
    return false;
  }
  if (!dryRun && !confirmed) {
    console.log("실제 publish confirmation이 없어 배포를 중단합니다.");
    return false;
  }
  if (!dryRun && !hasReleasePatterns(environment)) {
    console.log("release forbidden pattern이 없어 실제 배포를 중단합니다.");
    return false;
  }
  const plan = planPublish({ dryRun, registryLookup, packageName });
  if (plan.action === "abort") {
    console.log(plan.reason);
    return false;
  }

  console.log(`\n$ npm run ${verifyScript}`);
  const verified = runCommand("npm", ["run", verifyScript]);
  if (verified.status !== 0) {
    console.log("\nrelease 전체 검증에 실패해 배포를 중단합니다.");
    return false;
  }

  if (!dryRun) {
    console.log("\n$ npm run check-public-words -- --release");
    const publicWords = runCommand(
      "npm",
      ["run", "check-public-words", "--", "--release"],
      { env: environment },
    );
    if (publicWords.status !== 0) {
      console.log("\nrelease 공개 문자열 검증에 실패해 배포를 중단합니다.");
      return false;
    }

    console.log("\n$ npm whoami");
    const authenticated = runCommand("npm", ["whoami"], { env: environment });
    if (authenticated.status !== 0) {
      console.log("\nnpm 인증을 확인할 수 없어 실제 배포를 중단합니다.");
      return false;
    }
  }

  const args = ["publish", publishSpec, "--access", "public"];
  if (dryRun) args.push("--dry-run");

  console.log(`\n$ npm ${args.join(" ")}`);
  const published = runCommand("npm", args, {
    env: dryRun ? environment : { ...environment, NWB_PUBLISH_CONFIRMED: "1" },
  });
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

function readRegistryVersion(packageName, version) {
  return classifyRegistryVersionResult(
    run("npm", ["view", `${packageName}@${version}`, "version"], {
      capture: true,
    }),
  );
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 1 && argv[0] === "--lifecycle-guard") {
    validatePublishLifecycle(process.env);
    return;
  }
  const options = parsePublishArguments(argv);
  if (!options.dryRun && !hasReleasePatterns(process.env)) {
    throw new Error("실제 publish에는 BB_CHECK_FORBIDDEN_WORDS가 필요합니다.");
  }
  const entry = allowedPackages.get(options.packageName);
  if (entry === undefined) {
    throw new Error(`허용하지 않은 package입니다: ${options.packageName}`);
  }
  const manifest = JSON.parse(
    await readFile(
      resolve(rootDirectory, entry.packageDirectory, "package.json"),
      "utf8",
    ),
  );
  const selectedPackage = selectPublishPackage(options.packageName, manifest);
  const version = manifest.version;
  if (typeof version !== "string" || version.length === 0) {
    throw new Error("release version이 비어 있습니다.");
  }

  const registryLookup = readRegistryVersion(options.packageName, version);
  if (
    !publishPackage(
      version,
      options.dryRun,
      registryLookup,
      run,
      selectedPackage,
      options.confirmed,
      process.env,
    )
  ) {
    process.exitCode = 1;
  }
}

if (resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
