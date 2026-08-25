import {
  cpSync,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";

const testDir = fileURLToPath(new URL(".", import.meta.url));
const workspaceRoot = resolve(testDir, "../../..");
const fixtureDir = resolve(workspaceRoot, "apps/next-pages-fixture");
const fixturePackageSourceDir = resolve(fixtureDir, "packages/syntax-fixture");
const installedFixturePackageDir = resolve(
  workspaceRoot,
  "node_modules/syntax-fixture",
);
const childTimeoutMs = 90_000;

interface BuildResult {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly error: Error | undefined;
  readonly output: string;
}

const npmExecPathFrom = (env: NodeJS.ProcessEnv): string => {
  const npmExecPath = env.npm_execpath;
  if (typeof npmExecPath !== "string" || npmExecPath.trim() === "") {
    throw new Error("NWB_TEST_NPM_EXECPATH_MISSING");
  }
  return npmExecPath;
};

const runNpm = (
  args: readonly string[],
  options: { readonly env: NodeJS.ProcessEnv; readonly timeout: number },
): BuildResult => {
  const result = spawnSync(
    process.execPath,
    [npmExecPathFrom(options.env), ...args],
    {
      cwd: workspaceRoot,
      encoding: "utf8",
      env: options.env,
      timeout: options.timeout,
    },
  );
  return {
    status: result.status,
    signal: result.signal,
    error: result.error,
    output: `${result.stdout}${result.stderr}`,
  };
};

const buildFixture = (fixtureCase: string): BuildResult => {
  rmSync(resolve(fixtureDir, ".next"), { recursive: true, force: true });
  return runNpm(["run", "build", "--workspace=next-pages-fixture"], {
    env: { ...process.env, NWB_FIXTURE_CASE: fixtureCase },
    timeout: childTimeoutMs,
  });
};

const expectCompleted = (result: BuildResult): void => {
  expect(result.error, result.output).toBeUndefined();
  expect(result.signal, result.output).toBeNull();
  expect(result.status, result.output).not.toBeNull();
};

const readArtifactTree = (root: string): string => {
  if (!existsSync(root)) return "";
  const paths: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && /\.(?:js|json)$/u.test(entry.name)) {
        paths.push(path);
      }
    }
  }
  return paths
    .sort()
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");
};

const readNormalizedTraceFiles = (tracePath: string): readonly string[] => {
  const trace = JSON.parse(readFileSync(tracePath, "utf8")) as unknown;
  if (
    typeof trace !== "object" ||
    trace === null ||
    !("files" in trace) ||
    !Array.isArray(trace.files) ||
    trace.files.some((file) => typeof file !== "string")
  ) {
    throw new Error("NWB_TEST_SERVER_TRACE_INVALID");
  }
  return trace.files.map((file) => resolve(dirname(tracePath), file));
};

const materializeRegistryLikeFixturePackage = (): void => {
  if (!existsSync(installedFixturePackageDir)) {
    throw new Error("NWB_TEST_FIXTURE_DEPENDENCY_MISSING");
  }
  rmSync(installedFixturePackageDir, { recursive: true, force: true });
  cpSync(fixturePackageSourceDir, installedFixturePackageDir, {
    recursive: true,
  });
};

beforeAll(() => {
  materializeRegistryLikeFixturePackage();
  const result = runNpm(
    ["run", "build", "--workspace=@cp949/next-webpack-baseline"],
    { env: process.env, timeout: childTimeoutMs },
  );
  expectCompleted(result);
  expect(result.status, result.output).toBe(0);
}, 110_000);

describe.sequential("Next.js Pages Router Webpack integration", () => {
  it("registry 설치처럼 물리적인 fixture package를 사용한다", () => {
    expect(lstatSync(installedFixturePackageDir).isSymbolicLink()).toBe(false);
  });

  it("npm_execpath가 없으면 shell fallback 없이 안정된 infrastructure 오류로 중단한다", () => {
    expect(() => npmExecPathFrom({})).toThrow("NWB_TEST_NPM_EXECPATH_MISSING");
  });

  it("정책 밖 client package는 plugin이 활성화되어도 빌드를 막지 않는다", () => {
    const result = buildFixture("control");

    expectCompleted(result);
    expect(result.status, result.output).toBe(0);
  }, 110_000);

  it("정책 package를 transpile하지 않으면 실제 client build를 차단한다", () => {
    const result = buildFixture("red");

    expectCompleted(result);
    expect(result.status).toBe(1);
    expect(result.output).toContain("NWB_SYNTAX_UNSUPPORTED");
  }, 110_000);

  it("정책 package를 transpilePackages에 합성하면 같은 build가 통과한다", () => {
    const result = buildFixture("green");

    expectCompleted(result);
    expect(result.status, result.output).toBe(0);
  }, 110_000);

  it("정확한 entrypoint waiver만 호환성 예외로 인정한다", () => {
    const exact = buildFixture("waiver-exact");
    const similarPrefix = buildFixture("waiver-prefix");

    expectCompleted(exact);
    expect(exact.status, exact.output).toBe(0);
    expect(
      exact.output.match(/waiver applied: syntax-fixture\/index\.js/gu),
    ).toHaveLength(1);
    expectCompleted(similarPrefix);
    expect(similarPrefix.status).toBe(1);
    expect(similarPrefix.output).toContain("NWB_SYNTAX_UNSUPPORTED");
  }, 200_000);

  it("getServerSideProps에서만 사용하는 package는 client verdict에서 제외한다", () => {
    const result = buildFixture("server-only");

    expectCompleted(result);
    expect(result.status, result.output).toBe(0);
    const serverTraceFiles = readNormalizedTraceFiles(
      resolve(fixtureDir, ".next/server/pages/index.js.nft.json"),
    );
    const clientArtifacts = readArtifactTree(
      resolve(fixtureDir, ".next/static/chunks/pages"),
    );
    expect(serverTraceFiles).toContain(
      resolve(installedFixturePackageDir, "index.js"),
    );
    expect(clientArtifacts).not.toContain("syntax fixture");
    expect(clientArtifacts).not.toContain("readFixture");
  }, 110_000);
});
