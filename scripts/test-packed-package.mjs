#!/usr/bin/env node
// @cp949/bb-check가 "이 패키지만 설치한 새 프로젝트"에서 실제로 동작하는지
// 검증한다. workspace symlink나 vitest의 Vite 기반 resolver를 거치지
// 않는, 진짜 격리된 소비자를 흉내낸다:
//
//   1. `npm pack`으로 실제 tgz를 만든다.
//   2. mkdtemp로 만든 빈 프로젝트에 그 tgz를 `npm install`한다(레지스트리에서
//      5개 runtime external도 함께 설치됨).
//   3. `node -e 'import(...)'`로 두 공개 entry가 로드되는지 확인한다.
//   4. 설치된 `bb-check` bin이 shebang·실행 권한을 갖고 동작하는지 확인한다.
//   5. `library check`를 pass/fail fixture에 대해 실행해 exit code 0/1을
//      확인한다 — bb-core/bb-library가 제대로 번들되어 있지 않으면 이
//      단계에서 ERR_MODULE_NOT_FOUND로 드러난다.
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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// `new URL(...)` global 대신 fileURLToPath + dirname을 쓴다 — 저장소
// eslint globals 설정(process/console만 허용)과 충돌하지 않는다.
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageDir = join(repoRoot, "packages", "bb-check");
const useShell = process.platform === "win32";

/** 상위 npm publish --dry-run 설정을 내부 pack/install에 전파하지 않는다. */
export const forceActualNpmOperationEnv = (env) => ({
  ...env,
  npm_config_dry_run: "false",
});

/** 실패 시 stdout/stderr을 포함한 진단 메시지로 던진다. */
const run = (label, command, args, options) => {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    shell: useShell,
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

/** package.json + dist/index.js + bb-check.config.mjs로 구성된 최소 project fixture를 만든다. */
const writeProjectFixture = async (dir, browserslist, distSource) => {
  await mkdir(join(dir, "dist"), { recursive: true });
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({
      name: "bb-check-isolated-fixture",
      version: "1.0.0",
      private: true,
      browserslist,
      exports: "./dist/index.js",
    }),
    "utf8",
  );
  await writeFile(join(dir, "dist", "index.js"), distSource, "utf8");
};

const main = async () => {
  const tmpRoot = await mkdtemp(join(tmpdir(), "bb-check-packed-consumer-"));
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

    // 2. 빈 프로젝트를 만들고 그 tgz를 실제로 설치한다(registry에서 5개
    //    runtime external도 함께 받는다 — workspace symlink를 전혀 거치지 않는다).
    await writeFile(
      join(consumerDir, "package.json"),
      JSON.stringify(
        { name: "bb-check-isolated-consumer", version: "0.0.0", private: true },
        null,
        2,
      ),
      "utf8",
    );
    const installResult = run(
      "npm install",
      "npm",
      ["install", tgzPath, "--no-audit", "--no-fund", "--loglevel=error"],
      { cwd: consumerDir, env: forceActualNpmOperationEnv(process.env) },
    );
    expectExitCode("npm install", installResult, 0);

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
    const installedPackageDir = join(
      consumerDir,
      "node_modules",
      "@cp949",
      "bb-check",
    );
    for (const name of ["README.md", "LICENSE"]) {
      await stat(join(installedPackageDir, name)).catch(() => {
        throw new Error(`설치된 package에 ${name}이 없다.`);
      });
    }

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

    // 5. pass/fail fixture에 대해 실제 library check를 실행한다.
    await writeFile(
      join(consumerDir, "bb-check.config.mjs"),
      'export default { library: { projectDir: ".", allow: [] } };\n',
      "utf8",
    );

    await writeProjectFixture(
      join(consumerDir, "fixture-pass"),
      ["chrome >= 80"],
      "export const noop = () => {};\n",
    );
    const passResult = run(
      "npx bb-check library check (pass fixture)",
      "npx",
      [
        "--no-install",
        "bb-check",
        "library",
        "check",
        "--config",
        "./bb-check.config.mjs",
        "--dir",
        "./fixture-pass",
      ],
      { cwd: consumerDir },
    );
    expectNoUnresolvedModule("library check (pass fixture)", passResult);
    expectExitCode("library check (pass fixture)", passResult, 0);
    if (!passResult.stdout.includes("통과")) {
      throw new Error(
        `pass fixture 보고서에 "통과"가 없다.\nstdout:\n${passResult.stdout}`,
      );
    }

    await writeProjectFixture(
      join(consumerDir, "fixture-fail"),
      ["chrome >= 50"],
      [
        "export function greet(person) {",
        '  return person?.name ?? "guest";',
        "}",
        "",
      ].join("\n"),
    );
    const failResult = run(
      "npx bb-check library check (fail fixture)",
      "npx",
      [
        "--no-install",
        "bb-check",
        "library",
        "check",
        "--config",
        "./bb-check.config.mjs",
        "--dir",
        "./fixture-fail",
      ],
      { cwd: consumerDir },
    );
    expectNoUnresolvedModule("library check (fail fixture)", failResult);
    expectExitCode("library check (fail fixture)", failResult, 1);
    if (!failResult.stdout.includes("위반")) {
      throw new Error(
        `fail fixture 보고서에 "위반"이 없다.\nstdout:\n${failResult.stdout}`,
      );
    }

    console.log(
      "test-packed-package: OK (격리 설치, entry import 2건, bin 실행, pass/fail exit code 모두 확인)",
    );
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
};

if (resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((cause) => {
    console.error("test-packed-package: FAIL\n");
    console.error(
      cause instanceof Error ? (cause.stack ?? cause.message) : String(cause),
    );
    process.exitCode = 1;
  });
}
