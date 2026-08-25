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
});
