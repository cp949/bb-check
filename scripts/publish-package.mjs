import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const rootDirectory = resolve(import.meta.dirname, "..");
// 배포를 허용하는 package와 그 package를 배포하기 전에 실행할 verify script를
// 한 테이블에서 함께 관리한다. 새 package를 여기에 추가하려면 같은 변경에서
// 그 package 전용 verify script도 지정해야 하고, 그 script는 최소한 해당
// package의 packed tarball 검증(`npm run test-packed-package -- --package
// <이름>`)을 포함해야 한다.
const allowedPackages = new Map([
  [
    "@cp949/next-webpack-baseline",
    {
      packageDirectory: "packages/next-webpack-baseline",
      verifyScript: "verify:next-release",
    },
  ],
  [
    "@cp949/legacy-browser-smoke",
    {
      packageDirectory: "packages/legacy-browser-smoke",
      verifyScript: "verify:package-release",
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
  // 인자 없이 실행하면 대화형 메뉴로 들어간다 — 이 조건 하나만 추가하고, 그 외
  // 명시적 인자 조합의 기존 검증·기본값(문서화된 CI/수동 호출 경로)은 그대로 둔다.
  if (argv.length === 0) return { menu: true };

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

// ---- 대화형 메뉴 -----------------------------------------------------------
// 인자 없이 실행했을 때만 진입한다(parsePublishArguments 참고). 실제 배포를
// 막는 검증(verify script, check-public-words, npm whoami, registry 중복
// 확인)은 publishPackage를 그대로 재사용하므로 메뉴 전용 우회는 없다. 유일한
// 차이는 --confirm-publish 플래그 대신 터미널에서 "1"을 직접 선택하는 행위
// 자체를 확인으로 인정한다는 것뿐이다.

export function collectExportPaths(exportsField) {
  const paths = [];
  const visit = (node) => {
    if (typeof node === "string") {
      paths.push(node);
      return;
    }
    if (node && typeof node === "object") {
      for (const value of Object.values(node)) visit(value);
    }
  };
  visit(exportsField);
  return [...new Set(paths)];
}

// 한글은 터미널에서 두 칸을 차지하므로 code unit 길이 대신 표시 폭으로 맞춘다.
export function displayWidth(value) {
  let width = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    const wide =
      (codePoint >= 0x1100 && codePoint <= 0x115f) ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60);
    width += wide ? 2 : 1;
  }
  return width;
}

// 레이블 표시 폭이 목표 width와 같거나 넘으면(예: 한글 레이블) 뒤 텍스트와
// 붙어버리므로 여백을 최소 한 칸은 보장한다.
function padDisplay(value, width) {
  return value + " ".repeat(Math.max(1, width - displayWidth(value)));
}

export function describeRegistryLookup(registryLookup) {
  if (registryLookup.status === "published") return registryLookup.version;
  if (registryLookup.status === "missing") return "미배포";
  return `조회 실패(${registryLookup.reason})`;
}

export function statusMark(registryLookup, version) {
  return registryLookup.status === "published" &&
    registryLookup.version === version
    ? "배포됨"
    : "대상";
}

// scope(@cp949/)를 뺀 이름으로 태그를 만든다. 이 저장소는 package가 여럿이라
// bare `vX.Y.Z`만으로는 어느 package의 release인지 구분할 수 없다.
export function shortPackageName(packageName) {
  const slash = packageName.indexOf("/");
  return slash === -1 ? packageName : packageName.slice(slash + 1);
}

export function formatTagMessage(packageName, version) {
  return `${packageName}@${version}`;
}

// 태그는 배포한 커밋의 기록이므로 작업 트리가 커밋 상태와 다르거나 같은
// 이름의 태그가 다른 커밋을 가리키면 만들지 않는다.
export function planTagPush({
  tagName,
  workingTreeDirty,
  tagCommit,
  headCommit,
}) {
  if (workingTreeDirty) {
    return {
      action: "abort",
      reason:
        "작업 트리가 깨끗하지 않습니다. 배포한 커밋 상태로 정리한 뒤 다시 시도하세요.",
    };
  }
  if (tagCommit === null) return { action: "create-and-push", tagName };
  if (tagCommit === headCommit) return { action: "push-only", tagName };
  return {
    action: "abort",
    reason: `${tagName} 태그가 이미 다른 커밋(${tagCommit})을 가리킵니다. 태그를 직접 확인하세요.`,
  };
}

function readEffectiveRegistry() {
  const result = run("npm", ["config", "get", "registry"], { capture: true });
  return result.status === 0 ? result.stdout.trim() : "(조회 실패)";
}

// 이 저장소는 package 디렉터리를 그대로 배포하므로 dist 상태가 곧 배포 산출물이다.
function collectWarnings(selectedPackage, manifest) {
  const warnings = [];
  const status = run("git", ["status", "--porcelain"], { capture: true });
  if (status.status === 0 && status.stdout.trim() !== "") {
    warnings.push(
      "작업 트리가 깨끗하지 않습니다. 배포 산출물이 커밋 상태와 다를 수 있습니다.",
    );
  }

  const packageRoot = resolve(rootDirectory, selectedPackage.packageDirectory);
  if (!existsSync(join(packageRoot, "dist"))) {
    warnings.push(
      `${selectedPackage.packageDirectory}/dist가 없습니다. 먼저 4번으로 빌드하세요.`,
    );
    return warnings;
  }

  const declared = [
    ...collectExportPaths(manifest.exports),
    ...Object.values(manifest.bin ?? {}),
  ];
  const missing = [...new Set(declared)].filter(
    (path) => !existsSync(join(packageRoot, path)),
  );
  if (missing.length > 0) {
    const sample = missing.slice(0, 3).join(", ");
    const rest = missing.length > 3 ? ` 외 ${missing.length - 3}건` : "";
    warnings.push(`package.json이 가리키는 파일이 없습니다: ${sample}${rest}`);
  }
  return warnings;
}

function printStatus(
  selectedPackage,
  version,
  registryLookup,
  registry,
  warnings,
) {
  const tagName = `${shortPackageName(selectedPackage.packageName)}@${version}`;
  console.log(
    `\n=== ${selectedPackage.packageName} 배포 도구 · release ${version} ===`,
  );
  console.log(`  registry ${registry}`);
  console.log(
    `  로컬 ${padDisplay(version, 8)} registry ${padDisplay(describeRegistryLookup(registryLookup), 8)} ${statusMark(registryLookup, version)}`,
  );
  for (const warning of warnings) console.log(`  경고: ${warning}`);

  console.log("");
  // 실제 배포 절차 순서(빌드 → 검증 → dry-run → 배포 → 확인 → 태그)를 그대로 번호로 매긴다.
  const items = [
    ["1", "빌드", `npm run build --workspace ${selectedPackage.packageName}`],
    ["2", "release 전체 검증", `npm run ${selectedPackage.verifyScript}`],
    [
      "3",
      "dry-run 배포",
      `npm publish ${selectedPackage.publishSpec} --access public --dry-run`,
    ],
    ["4", "배포", `npm publish ${selectedPackage.publishSpec} --access public`],
    ["5", "registry 상태 새로고침", ""],
    ["6", "배포 결과 확인", "version"],
    [
      "7",
      "버전 태그 붙여서 푸시",
      `git tag ${tagName} && git push origin ${tagName}`,
    ],
    ["q", "종료", ""],
  ];
  for (const [key, label, detail] of items) {
    console.log(
      detail === ""
        ? `  ${key}) ${label}`
        : `  ${key}) ${padDisplay(label, 20)}${detail}`,
    );
  }
  console.log("");
}

function reportPublished(selectedPackage, version) {
  const viewed = run(
    "npm",
    ["view", `${selectedPackage.packageName}@${version}`, "version"],
    { capture: true },
  );
  if (viewed.status !== 0) {
    console.log(
      `${selectedPackage.packageName}@${version}: registry에서 조회되지 않습니다.`,
    );
    return;
  }
  console.log(`${selectedPackage.packageName}@${version}: 배포됨`);
}

function pushVersionTag(selectedPackage, version) {
  const tagName = `${shortPackageName(selectedPackage.packageName)}@${version}`;
  const status = run("git", ["status", "--porcelain"], { capture: true });
  const head = run("git", ["rev-parse", "HEAD"], { capture: true });
  const tag = run(
    "git",
    ["rev-parse", "--verify", "--quiet", `refs/tags/${tagName}^{commit}`],
    { capture: true },
  );
  const plan = planTagPush({
    tagName,
    workingTreeDirty: status.status !== 0 || status.stdout.trim() !== "",
    tagCommit: tag.status === 0 ? tag.stdout.trim() : null,
    headCommit: head.stdout.trim(),
  });

  if (plan.action === "abort") {
    console.log(plan.reason);
    return false;
  }

  if (plan.action === "create-and-push") {
    const created = run("git", [
      "tag",
      "-a",
      plan.tagName,
      "-m",
      formatTagMessage(selectedPackage.packageName, version),
    ]);
    if (created.status !== 0) {
      console.log(`${plan.tagName} 태그 생성에 실패했습니다.`);
      return false;
    }
    console.log(`${plan.tagName} 태그를 HEAD에 만들었습니다.`);
  } else {
    console.log(
      `${plan.tagName} 태그가 이미 HEAD를 가리킵니다. push만 진행합니다.`,
    );
  }

  const pushed = run("git", ["push", "origin", plan.tagName]);
  if (pushed.status !== 0) {
    console.log(
      `태그 push에 실패했습니다. 재시도하세요: git push origin ${plan.tagName}`,
    );
    return false;
  }
  console.log(`origin에 ${plan.tagName} 태그를 push했습니다.`);
  return true;
}

// allowedPackages가 하나뿐이면 자동 선택하고, 여럿이면 번호로 고르게 한다.
// rl은 호출자(main)가 세션 전체에서 하나만 만들어 넘긴다 — 인터페이스를 여기서
// 새로 만들고 닫으면, 같은 tick에 도착한 다음 줄(예: "1\nq\n")이 이 인터페이스의
// 내부 버퍼에 먼저 먹혀 버려 이후 runMenu의 rl.question이 입력을 못 받는다.
async function resolveMenuPackage(rl) {
  const entries = [...allowedPackages.keys()];
  let packageName = entries[0];

  if (entries.length > 1) {
    console.log("배포할 package를 선택하세요.");
    entries.forEach((name, index) => console.log(`  ${index + 1}) ${name}`));
    const answer = (await rl.question("선택: ")).trim();
    const index = Number.parseInt(answer, 10) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= entries.length) {
      throw new Error(`알 수 없는 선택입니다: ${answer}`);
    }
    packageName = entries[index];
  }

  const entry = allowedPackages.get(packageName);
  const manifest = JSON.parse(
    await readFile(
      resolve(rootDirectory, entry.packageDirectory, "package.json"),
      "utf8",
    ),
  );
  const selectedPackage = selectPublishPackage(packageName, manifest);
  const version = manifest.version;
  if (typeof version !== "string" || version.length === 0) {
    throw new Error("release version이 비어 있습니다.");
  }
  return { selectedPackage, manifest, version };
}

async function runMenu(rl, selectedPackage, manifest, version) {
  let registryLookup = readRegistryVersion(
    selectedPackage.packageName,
    version,
  );
  const registry = readEffectiveRegistry();

  for (;;) {
    printStatus(
      selectedPackage,
      version,
      registryLookup,
      registry,
      collectWarnings(selectedPackage, manifest),
    );
    const choice = (await rl.question("선택: ")).trim().toLowerCase();

    if (choice === "q" || choice === "") return;

    if (choice === "1") {
      run("npm", ["run", "build", "--workspace", selectedPackage.packageName]);
    } else if (choice === "2") {
      run("npm", ["run", selectedPackage.verifyScript]);
    } else if (choice === "3") {
      publishPackage(
        version,
        true,
        registryLookup,
        run,
        selectedPackage,
        true,
        process.env,
      );
    } else if (choice === "4") {
      // 메뉴에서 "4"를 직접 선택하는 행위를 --confirm-publish로 인정한다.
      // BB_CHECK_FORBIDDEN_WORDS 등 나머지 게이트는 publishPackage가 그대로 검증한다.
      publishPackage(
        version,
        false,
        registryLookup,
        run,
        selectedPackage,
        true,
        process.env,
      );
    } else if (choice === "5") {
      registryLookup = readRegistryVersion(
        selectedPackage.packageName,
        version,
      );
    } else if (choice === "6") {
      reportPublished(selectedPackage, version);
    } else if (choice === "7") {
      pushVersionTag(selectedPackage, version);
    } else {
      console.log(`알 수 없는 선택입니다: ${choice}`);
    }
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 1 && argv[0] === "--lifecycle-guard") {
    validatePublishLifecycle(process.env);
    return;
  }
  const options = parsePublishArguments(argv);
  if (options.menu === true) {
    if (!process.stdin.isTTY) {
      throw new Error(
        "대화형 메뉴를 쓸 수 없습니다. --package와 --publish/--dry-run을 지정하세요.",
      );
    }
    // 인터페이스를 세션 전체에서 하나만 만든다 — resolveMenuPackage와 runMenu
    // 사이에서 새로 만들고 닫으면 같은 tick에 도착한 다음 입력을 놓칠 수 있다.
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      const { selectedPackage, manifest, version } =
        await resolveMenuPackage(rl);
      await runMenu(rl, selectedPackage, manifest, version);
    } finally {
      rl.close();
    }
    return;
  }
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
