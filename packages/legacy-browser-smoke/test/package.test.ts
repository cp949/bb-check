import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import * as packageRoot from "../src/index.js";
import { defineSmokeConfig } from "../src/index.js";

const readManifest = async () =>
  JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as {
    name: string;
    private?: boolean;
    type: string;
    license: string;
    engines: { node: string };
    exports: { ".": { import: string; types: string } };
    files: readonly string[];
    publishConfig: { access: string };
    dependencies?: Record<string, string>;
  };

describe("@cp949/legacy-browser-smoke 공개 package 계약", () => {
  it("공개 ESM, Node 22, publish 파일 계약을 제공한다", async () => {
    const manifest = await readManifest();

    expect(manifest.name).toBe("@cp949/legacy-browser-smoke");
    expect(manifest.private).not.toBe(true);
    expect(manifest.type).toBe("module");
    expect(manifest.license).toBe("MIT");
    expect(manifest.engines.node).toBe(">=22");
    expect(manifest.exports["."]).toEqual({
      import: "./dist/index.js",
      types: "./dist/index.d.ts",
    });
    expect(manifest.files).toEqual([
      "dist/**",
      "README.md",
      "LICENSE",
      "package.json",
    ]);
    expect(manifest.publishConfig).toEqual({ access: "public" });
  });

  it("자동화 및 소비자 package runtime dependency를 추가하지 않는다", async () => {
    const manifest = await readManifest();
    const dependencies = Object.keys(manifest.dependencies ?? {});

    expect(dependencies).not.toContain("@cp949/next-webpack-baseline");
    expect(
      dependencies.some((name) => /chromium|puppeteer|playwright/iu.test(name)),
    ).toBe(false);
  });

  it("B1 package root는 defineSmokeConfig만 export한다", () => {
    expect(Object.keys(packageRoot)).toEqual(["defineSmokeConfig"]);
    expect(
      defineSmokeConfig({
        pages: [
          {
            name: "home",
            path: "/",
            ready: { kind: "selector", selector: "main" },
          },
        ],
        timeoutMs: 1_000,
      }).pages[0]?.name,
    ).toBe("home");
  });
});
