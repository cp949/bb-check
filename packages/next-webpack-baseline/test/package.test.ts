import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const readManifest = async () =>
  JSON.parse(
    await readFile(
      fileURLToPath(new URL("../package.json", import.meta.url)),
      "utf8",
    ),
  ) as {
    name: string;
    private?: boolean;
    license: string;
    engines: { node: string };
    exports: { ".": { import: string; types: string } };
    dependencies?: Record<string, string>;
  };

describe("@cp949/next-webpack-baseline 공개 package 계약", () => {
  it("공개 ESM root export와 Node 20 계약을 제공한다", async () => {
    const manifest = await readManifest();

    expect(manifest.name).toBe("@cp949/next-webpack-baseline");
    expect(manifest.private).not.toBe(true);
    expect(manifest.license).toBe("MIT");
    expect(manifest.engines.node).toBe(">=20");
    expect(manifest.exports["."]).toEqual({
      import: "./dist/index.js",
      types: "./dist/index.d.ts",
    });
  });

  it("bb-check와 Chromium 구현을 runtime dependency로 노출하지 않는다", async () => {
    const manifest = await readManifest();
    const runtimeDependencies = Object.keys(manifest.dependencies ?? {});

    expect(runtimeDependencies).not.toContain("@cp949/bb-check");
    expect(runtimeDependencies).not.toContain("bb-library");
    expect(runtimeDependencies).not.toContain("@cp949/bb-library");
    expect(
      runtimeDependencies.some((name) =>
        /chromium|puppeteer|playwright/iu.test(name),
      ),
    ).toBe(false);
  });
});
