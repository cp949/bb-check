import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../../..");
const fixtureDir = resolve(workspaceRoot, "apps/next-pages-fixture");

interface BuildResult {
  readonly status: number | null;
  readonly output: string;
}

const buildFixture = (fixtureCase: string): BuildResult => {
  rmSync(resolve(fixtureDir, ".next"), { recursive: true, force: true });
  const result = spawnSync(
    "npm",
    ["run", "build", "--workspace=next-pages-fixture", "--", "--webpack"],
    {
      cwd: workspaceRoot,
      encoding: "utf8",
      env: { ...process.env, NWB_FIXTURE_CASE: fixtureCase },
      timeout: 120_000,
    },
  );
  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
  };
};

beforeAll(() => {
  const result = spawnSync(
    "npm",
    ["run", "build", "--workspace=@cp949/next-webpack-baseline"],
    { cwd: workspaceRoot, encoding: "utf8", timeout: 120_000 },
  );
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
}, 120_000);

describe.sequential("Next.js Pages Router Webpack integration", () => {
  it("정책 밖 client package는 plugin이 활성화되어도 빌드를 막지 않는다", () => {
    const result = buildFixture("control");

    expect(result.status, result.output).toBe(0);
  }, 120_000);

  it("정책 package를 transpile하지 않으면 실제 client build를 차단한다", () => {
    const result = buildFixture("red");

    expect(result.status).not.toBe(0);
    expect(result.output).toContain("NWB_SYNTAX_UNSUPPORTED");
  }, 120_000);

  it("정책 package를 transpilePackages에 합성하면 같은 build가 통과한다", () => {
    const result = buildFixture("green");

    expect(result.status, result.output).toBe(0);
  }, 120_000);

  it("정확한 entrypoint waiver만 호환성 예외로 인정한다", () => {
    const exact = buildFixture("waiver-exact");
    const similarPrefix = buildFixture("waiver-prefix");

    expect(exact.status, exact.output).toBe(0);
    expect(similarPrefix.status).not.toBe(0);
    expect(similarPrefix.output).toContain("NWB_SYNTAX_UNSUPPORTED");
  }, 120_000);

  it("getServerSideProps에서만 사용하는 package는 client verdict에서 제외한다", () => {
    const result = buildFixture("server-only");

    expect(result.status, result.output).toBe(0);
  }, 120_000);
});
