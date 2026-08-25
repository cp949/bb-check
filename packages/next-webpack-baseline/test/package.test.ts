import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
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
    private?: boolean;
    license: string;
    engines: { node: string };
    exports: { ".": { import: string; types: string } };
    dependencies?: Record<string, string>;
  };

describe("@cp949/next-webpack-baseline 공개 package 계약", () => {
  it("공개 config type은 빈 policy의 중립 사용 예를 허용한다", () => {
    const config = defineConfig({ projectDir: packageDir, policy: [] });

    expect(config).toEqual({ projectDir: packageDir, policy: [] });
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

  it("빌드된 declaration을 A2 config 계약으로 소비자 typecheck한다", async () => {
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
      const declarationImport = relative(
        consumerDir,
        resolve(packageDir, "dist/index.js"),
      )
        .split(sep)
        .join("/");
      const specifier = declarationImport.startsWith(".")
        ? declarationImport
        : `./${declarationImport}`;
      await writeFile(
        join(consumerDir, "consumer.ts"),
        [
          `import { createNextWebpackBaseline, defineConfig, type NextWebpackBaselineConfig, type PackagePolicy, type PackageWaiver } from ${JSON.stringify(specifier)};`,
          "",
          'const policy: PackagePolicy = { package: "example-package", reason: "legacy syntax check" };',
          'const waiver: PackageWaiver = { package: "example-package", reason: "reviewed entrypoint", allowedEntrypoints: ["dist/index.js"] };',
          `const input: NextWebpackBaselineConfig = { projectDir: ${JSON.stringify(legacyProjectDir)}, policy: [policy], waivers: [waiver] };`,
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
              skipLibCheck: true,
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
