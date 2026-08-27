import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { createNextWebpackBaseline, defineConfig } from "../src/index.js";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const legacyProjectDir = fileURLToPath(
  new URL("./fixtures/browserslist-legacy", import.meta.url),
);

const readManifest = async () =>
  JSON.parse(
    await readFile(
      fileURLToPath(new URL("../package.json", import.meta.url)),
      "utf8",
    ),
  ) as {
    name: string;
    version: string;
    private?: boolean;
    license: string;
    engines: { node: string };
    exports: { ".": { import: string; types: string } };
    dependencies?: Record<string, string>;
  };

describe("@cp949/next-webpack-baseline 공개 package 계약", () => {
  it("공개 config type은 빈 policy의 중립 사용 예를 허용한다", () => {
    const config = defineConfig({
      projectDir: packageDir,
      policy: [],
      unlistedPackages: "error" as const,
    });

    expect(config).toEqual({
      projectDir: packageDir,
      policy: [],
      unlistedPackages: "error",
    });
  });

  it("모든 내부 factory를 정확한 두 key의 공개 facade로 결합한다", () => {
    const facade = createNextWebpackBaseline(
      defineConfig({
        projectDir: legacyProjectDir,
        policy: [
          { package: "example-beta", reason: "legacy syntax check" },
          { package: "example-alpha", reason: "legacy syntax check" },
        ],
      }),
    );

    expect(Object.keys(facade)).toEqual(["transpilePackages", "webpackPlugin"]);
    expect(facade.transpilePackages).toEqual(["example-beta", "example-alpha"]);
    expect(typeof facade.webpackPlugin({ dev: false }).apply).toBe("function");
  });

  it("공개 ESM root export와 Node 20 계약을 제공한다", async () => {
    const manifest = await readManifest();

    expect(manifest.name).toBe("@cp949/next-webpack-baseline");
    expect(manifest.version).toBe("0.2.0");
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

  it("빌드된 root는 정확한 runtime 함수와 facade own key만 노출한다", async () => {
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
    const config = {
      projectDir: legacyProjectDir,
      policy: [{ package: "example-package", reason: "legacy syntax check" }],
    };

    expect(Object.keys(packageRoot).sort()).toEqual([
      "createNextWebpackBaseline",
      "defineConfig",
    ]);
    expect(packageRoot.defineConfig(config)).toEqual(config);
    const facade = packageRoot.createNextWebpackBaseline(config);
    expect(Object.keys(facade)).toEqual(["transpilePackages", "webpackPlugin"]);
    expect(facade.transpilePackages).toEqual(["example-package"]);
    expect(typeof facade.webpackPlugin({ dev: true }).apply).toBe("function");
  });

  it("packed declaration의 exports.types를 A2 config 계약으로 소비자 typecheck한다", async () => {
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

    const consumerDir = await mkdtemp(
      join(tmpdir(), "next-webpack-baseline-types-"),
    );
    try {
      const packDir = join(consumerDir, "pack");
      await mkdir(packDir, { recursive: true });
      const pack = spawnSync(
        process.execPath,
        [npmCliPath, "pack", "--json", "--pack-destination", packDir],
        {
          cwd: packageDir,
          encoding: "utf8",
          env: { ...process.env, npm_config_dry_run: "false" },
        },
      );
      expect(pack.status, `${pack.stdout}${pack.stderr}`).toBe(0);
      const [{ filename }] = JSON.parse(pack.stdout) as [{ filename: string }];

      await writeFile(
        join(consumerDir, "package.json"),
        `${JSON.stringify(
          {
            name: "next-webpack-baseline-type-consumer",
            private: true,
            type: "module",
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      const install = spawnSync(
        process.execPath,
        [
          npmCliPath,
          "install",
          "--save-dev",
          join(packDir, filename),
          "--no-audit",
          "--no-fund",
          "--loglevel=error",
        ],
        {
          cwd: consumerDir,
          encoding: "utf8",
          env: { ...process.env, npm_config_dry_run: "false" },
        },
      );
      expect(install.status, `${install.stdout}${install.stderr}`).toBe(0);

      await writeFile(
        join(consumerDir, "consumer.ts"),
        [
          'import { createNextWebpackBaseline, defineConfig, type NextWebpackBaselineConfig, type PackagePolicy, type PackageWaiver, type UnlistedPackagesMode } from "@cp949/next-webpack-baseline";',
          "",
          'const policy: PackagePolicy = { package: "example-package", reason: "legacy syntax check" };',
          'const waiver: PackageWaiver = { package: "example-package", reason: "reviewed entrypoint", allowedEntrypoints: ["dist/index.js"] };',
          'const unlistedPackages: UnlistedPackagesMode = "error";',
          `const input: NextWebpackBaselineConfig = { projectDir: ${JSON.stringify(legacyProjectDir)}, policy: [policy], waivers: [waiver], unlistedPackages };`,
          "const facade = createNextWebpackBaseline(defineConfig(input));",
          "const packages: readonly string[] = facade.transpilePackages;",
          "const plugin: { apply(compiler: { readonly hooks: object }): void } = facade.webpackPlugin({ dev: false });",
          "void packages;",
          "void plugin;",
          "",
        ].join("\n"),
        "utf8",
      );
      await writeFile(
        join(consumerDir, "tsconfig.json"),
        `${JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              module: "NodeNext",
              moduleResolution: "NodeNext",
              target: "ES2022",
              noEmit: true,
              skipLibCheck: false,
              types: [],
            },
            files: ["consumer.ts"],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const typecheck = spawnSync(
        process.execPath,
        [
          resolve(packageDir, "../../node_modules/typescript/bin/tsc6"),
          "-p",
          "tsconfig.json",
        ],
        { cwd: consumerDir, encoding: "utf8" },
      );
      expect(typecheck.status, `${typecheck.stdout}${typecheck.stderr}`).toBe(
        0,
      );
    } finally {
      await rm(consumerDir, { recursive: true, force: true });
    }
  });
});
