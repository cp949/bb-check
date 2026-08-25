import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const readJson = async (path: string) =>
  JSON.parse(await readFile(path, "utf8"));

describe("workspace 공개 경계", () => {
  it("Track B legacy-browser-smoke는 독립된 공개 workspace package다", async () => {
    const manifest = await readJson(
      "packages/legacy-browser-smoke/package.json",
    );

    expect([manifest.name, manifest.private]).toEqual([
      "@cp949/legacy-browser-smoke",
      false,
    ]);

    const packageRoot =
      await import("../packages/legacy-browser-smoke/src/index.js");
    expect(Object.keys(packageRoot)).toEqual(["defineSmokeConfig"]);
  });

  it("next-webpack-baseline은 Track A 공개 package다", async () => {
    const manifest = await readJson(
      "packages/next-webpack-baseline/package.json",
    );
    expect([manifest.name, manifest.private]).toEqual([
      "@cp949/next-webpack-baseline",
      false,
    ]);
  });

  it("Track A root와 fixture 검증 명령은 active package와 Webpack build를 선택한다", async () => {
    const [fixtureManifest, rootManifest] = await Promise.all([
      readJson("apps/next-pages-fixture/package.json"),
      readJson("package.json"),
    ]);

    expect(fixtureManifest.scripts.build).toBe("next build --webpack");
    expect(rootManifest.scripts.check).toContain(
      "npm run test-packed-package -- --package @cp949/next-webpack-baseline",
    );
    expect(rootManifest.scripts["verify:package-release"]).toContain(
      "npm run test-packed-package -- --package @cp949/next-webpack-baseline",
    );
  });

  it("root Vitest는 공유 dist build를 file 병렬 실행하지 않는다", async () => {
    const rootManifest = await readJson("package.json");

    expect(rootManifest.scripts.test).toBe(
      'vitest run --exclude "scripts/**" --no-file-parallelism',
    );
  });

  it("hosted Node 22 full gate는 전체 root 정적 검사와 테스트를 실행한다", async () => {
    const workflow = await readFile(".github/workflows/ci.yml", "utf8");

    expect(workflow).toContain("          tests\n");
    expect(workflow).toContain("npx eslint tests scripts");
    expect(workflow).toContain("npx tsc -p tsconfig.json --noEmit");
    expect(workflow).toContain("npx vitest run tests --no-file-parallelism");
  });

  it("root README는 내부 소비자 식별자를 공개하지 않는다", async () => {
    const readme = await readFile("README.md", "utf8");

    expect(readme).not.toMatch(/\bcodiny\b/iu);
  });
});
