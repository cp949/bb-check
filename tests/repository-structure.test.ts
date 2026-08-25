import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const readJson = async (path: string) =>
  JSON.parse(await readFile(path, "utf8"));

describe("workspace 공개 경계", () => {
  it("next-webpack-baseline만 active 공개 패키지다", async () => {
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
});
