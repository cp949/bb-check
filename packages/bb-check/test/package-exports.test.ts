// @cp949/bb-check 공개 build artifact 계약을 package.json 매니페스트
// 수준에서 검증한다. 실제 tarball 내용물 검사(files allowlist)는
// scripts/check-package-files.mjs가, 격리된 소비자로서의 실행 가능성은
// scripts/test-packed-package.mjs가 각각 담당한다 — 이 파일은 소스에서
// 바로 읽을 수 있는 manifest 필드만 본다.

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const readJson = async (path: string) =>
  JSON.parse(await readFile(path, "utf8"));

describe("bb-check 공개 manifest 계약", () => {
  it("공개 entry와 실행 가능한 CLI만 export한다", async () => {
    const manifest = await readJson("packages/bb-check/package.json");
    expect(Object.keys(manifest.exports)).toEqual([".", "./library"]);
    expect(manifest.bin).toEqual({ "bb-check": "./dist/cli.js" });
    expect(manifest.dependencies).not.toHaveProperty("@cp949/bb-core");
    expect(manifest.dependencies).not.toHaveProperty("@cp949/bb-library");
  });

  it("exports는 정확히 index/library dist 산출물만 가리킨다", async () => {
    const manifest = await readJson("packages/bb-check/package.json");
    expect(manifest.exports).toEqual({
      ".": "./dist/index.js",
      "./library": "./dist/library.js",
    });
  });

  it("internal workspace package는 devDependencies에만 있다", async () => {
    const manifest = await readJson("packages/bb-check/package.json");
    expect(manifest.devDependencies).toMatchObject({
      "@cp949/bb-core": "0.1.0",
      "@cp949/bb-library": "0.1.0",
    });
  });

  it("runtime external 5종만 dependencies에 남는다", async () => {
    const manifest = await readJson("packages/bb-check/package.json");
    expect(Object.keys(manifest.dependencies).sort()).toEqual([
      "@mdn/browser-compat-data",
      "acorn",
      "browserslist",
      "browserslist-to-esbuild",
      "esbuild",
    ]);
  });

  it("files allowlist는 dist/README/LICENSE/package.json만 허용한다", async () => {
    const manifest = await readJson("packages/bb-check/package.json");
    expect(manifest.files).toEqual([
      "dist/**",
      "README.md",
      "LICENSE",
      "package.json",
    ]);
  });

  it("publishConfig.access는 public이다", async () => {
    const manifest = await readJson("packages/bb-check/package.json");
    expect(manifest.publishConfig).toMatchObject({ access: "public" });
  });
});
