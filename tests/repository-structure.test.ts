import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const readJson = async (path: string) =>
  JSON.parse(await readFile(path, "utf8"));

describe("workspace 공개 경계", () => {
  it("bb-check와 next-webpack-baseline은 독립 공개 패키지다", async () => {
    const names = ["core", "bb-library", "bb-check", "next-webpack-baseline"];
    const manifests = await Promise.all(
      names.map((name) => readJson(`packages/${name}/package.json`)),
    );

    expect(
      manifests.map(({ name, private: isPrivate }) => [name, isPrivate]),
    ).toEqual([
      ["@cp949/bb-core", true],
      ["@cp949/bb-library", true],
      ["@cp949/bb-check", false],
      ["@cp949/next-webpack-baseline", false],
    ]);
  });

  it("demo app도 비공개다(npm tarball에 포함되지 않는다)", async () => {
    const manifest = await readJson("apps/demo/package.json");
    expect([manifest.name, manifest.private]).toEqual(["bb-check-demo", true]);
  });
});
