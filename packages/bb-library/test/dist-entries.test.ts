import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveDistEntries } from "../src/index.js";

const fixture = (name: string) => join(import.meta.dirname, "fixtures", name);

/**
 * 브리프의 고정 fixture 3종(clean/multi-entry/empty-exports) 밖의
 * edge case는 커밋된 fixture를 늘리는 대신 이 임시 디렉터리에서
 * package.json/산출물을 직접 써서 검증한다.
 */
let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "bb-library-dist-entries-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

const writePackageJson = async (value: unknown) => {
  await writeFile(join(tempDir, "package.json"), JSON.stringify(value), "utf8");
};

describe("resolveDistEntries", () => {
  it("string, array, condition object, subpath object 형태를 모두 순회해 정렬·중복 제거한 JS 진입점을 반환한다", async () => {
    expect(await resolveDistEntries(fixture("multi-entry"))).toEqual([
      expect.stringMatching(/dist\/feature\.cjs$/),
      expect.stringMatching(/dist\/index\.js$/),
    ]);
  });

  it("최상위 exports가 string 하나뿐이어도 처리한다", async () => {
    expect(await resolveDistEntries(fixture("clean"))).toEqual([
      expect.stringMatching(/dist\/index\.js$/),
    ]);
  });

  it("exports에 JavaScript가 없으면 BB_INPUT_NOT_FOUND다", async () => {
    await expect(
      resolveDistEntries(fixture("empty-exports")),
    ).rejects.toMatchObject({ code: "BB_INPUT_NOT_FOUND" });
  });

  it("package.json이 없으면 BB_INPUT_NOT_FOUND다", async () => {
    await expect(
      resolveDistEntries(join(tempDir, "does-not-exist")),
    ).rejects.toMatchObject({ code: "BB_INPUT_NOT_FOUND" });
  });

  it("package.json이 올바른 JSON이 아니면 BB_CONFIG_INVALID다", async () => {
    await writeFile(join(tempDir, "package.json"), "{ not json", "utf8");
    await expect(resolveDistEntries(tempDir)).rejects.toMatchObject({
      code: "BB_CONFIG_INVALID",
    });
  });

  it("package root 밖을 가리키는 경로는 조용히 제외하고 나머지는 반환한다", async () => {
    await mkdir(join(tempDir, "dist"), { recursive: true });
    await writeFile(join(tempDir, "dist", "index.js"), "export {};", "utf8");
    await writePackageJson({
      name: "root-escape",
      version: "1.0.0",
      exports: {
        ".": "./dist/index.js",
        "./evil-relative": "../../etc/passwd.js",
        "./evil-absolute": "/etc/passwd.js",
      },
    });

    const entries = await resolveDistEntries(tempDir);
    expect(entries).toEqual([expect.stringMatching(/dist\/index\.js$/)]);
  });

  it("types, CSS, JSON, source map은 진입점에서 제외한다", async () => {
    await mkdir(join(tempDir, "dist"), { recursive: true });
    await writeFile(join(tempDir, "dist", "index.js"), "export {};", "utf8");
    await writeFile(join(tempDir, "dist", "index.d.ts"), "export {};", "utf8");
    await writeFile(join(tempDir, "dist", "index.js.map"), "{}", "utf8");
    await writeFile(join(tempDir, "dist", "style.css"), "", "utf8");
    await writeFile(join(tempDir, "dist", "data.json"), "{}", "utf8");
    await writePackageJson({
      name: "non-js-outputs",
      version: "1.0.0",
      exports: {
        ".": {
          types: "./dist/index.d.ts",
          default: "./dist/index.js",
        },
        "./style": "./dist/style.css",
        "./data": "./dist/data.json",
        "./map": "./dist/index.js.map",
      },
    });

    const entries = await resolveDistEntries(tempDir);
    expect(entries).toEqual([expect.stringMatching(/dist\/index\.js$/)]);
  });

  it("exports에 나열되어 있어도 실제 파일이 없으면 제외한다", async () => {
    await writePackageJson({
      name: "missing-on-disk",
      version: "1.0.0",
      exports: { ".": "./dist/does-not-exist.js" },
    });

    await expect(resolveDistEntries(tempDir)).rejects.toMatchObject({
      code: "BB_INPUT_NOT_FOUND",
    });
  });
});
