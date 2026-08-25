import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { defineConfig } from "../src/index.js";

const packageDir = fileURLToPath(new URL("..", import.meta.url));

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
  it("Node 20.0 ESM 환경에서도 public config의 projectDir를 만들 수 있다", () => {
    const dirname = Object.getOwnPropertyDescriptor(import.meta, "dirname");
    Reflect.deleteProperty(import.meta, "dirname");
    try {
      const config = defineConfig({
        projectDir: fileURLToPath(new URL(".", import.meta.url)),
        policy: [],
      });

      expect(config.projectDir).toBe(
        fileURLToPath(new URL(".", import.meta.url)),
      );
    } finally {
      if (dirname !== undefined) {
        Object.defineProperty(import.meta, "dirname", dirname);
      }
    }
  });

  it("공개 config type은 빈 policy의 중립 사용 예를 허용한다", () => {
    const config = defineConfig({ projectDir: packageDir, policy: [] });

    expect(config).toEqual({ projectDir: packageDir, policy: [] });
  });

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

  it("빌드된 root export에서 facade를 import하고 정상 객체를 반환한다", async () => {
    const npmCliPath = process.env.npm_execpath;
    if (npmCliPath === undefined) {
      throw new Error("npm_execpath가 없어 package build를 실행할 수 없다");
    }

    const build = spawnSync(process.execPath, [npmCliPath, "run", "build"], {
      cwd: packageDir,
      encoding: "utf8",
    });

    if (build.status !== 0) {
      throw new Error(
        `package build가 실패했다:\n${build.stdout}${build.stderr}`,
      );
    }

    const packageRoot = await import(
      `${pathToFileURL(resolve(packageDir, "dist/index.js")).href}?${Date.now()}`
    );
    const config = { projectDir: packageDir, policy: [] };

    expect(packageRoot.defineConfig(config)).toEqual(config);
    expect(packageRoot.createNextWebpackBaseline(config)).toEqual({
      options: config,
    });
  });
});
