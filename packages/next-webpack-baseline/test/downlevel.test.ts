import { describe, expect, it } from "vitest";
import { NextWebpackBaselineError } from "../src/errors.js";
import { resolvePackageResource } from "../src/package-name.js";

describe("resolvePackageResource", () => {
  it.each([
    {
      resource: "/consumer/node_modules/legacy-widget/dist/compat.cjs",
      want: { package: "legacy-widget", entrypoint: "dist/compat.cjs" },
    },
    {
      resource: "/consumer/node_modules/@scope/legacy-widget/lib/index.js",
      want: { package: "@scope/legacy-widget", entrypoint: "lib/index.js" },
    },
    {
      resource:
        "/consumer/node_modules/.pnpm/@scope+legacy-widget@1.2.3/node_modules/@scope/legacy-widget/dist/index.js",
      want: { package: "@scope/legacy-widget", entrypoint: "dist/index.js" },
    },
    {
      resource:
        "/consumer/node_modules/outer/node_modules/inner/lib/browser.js",
      want: { package: "inner", entrypoint: "lib/browser.js" },
    },
    {
      resource: "C:\\consumer\\node_modules\\legacy-widget\\dist\\compat.cjs",
      want: { package: "legacy-widget", entrypoint: "dist/compat.cjs" },
    },
    {
      resource:
        "\\\\server\\share\\consumer\\node_modules\\@scope\\legacy-widget\\index.js",
      want: { package: "@scope/legacy-widget", entrypoint: "index.js" },
    },
  ] satisfies ReadonlyArray<{
    resource: string;
    want: { package: string; entrypoint: string };
  }>)(
    "$resource에서 증명 가능한 npm package 경계를 만든다",
    ({ resource, want }) => {
      expect(resolvePackageResource(resource)).toEqual(want);
    },
  );

  it.each([
    "C:chunk.cjs",
    "/consumer/packages/legacy-widget/dist/compat.cjs",
    "/consumer/.yarn/cache/legacy-widget-npm-1.0.0.zip/node_modules/legacy-widget/index.js",
    "/consumer/node_modules/legacy-widget",
  ])("지원하지 않는 경로 %s를 안전한 코드로 거부한다", (resource) => {
    expect(() => resolvePackageResource(resource)).toThrow(
      expect.objectContaining<Partial<NextWebpackBaselineError>>({
        code: "NWB_PACKAGE_PATH_UNRESOLVED",
      }),
    );
  });

  it("경로 오류의 public message에서 절대 소비자 경로를 감춘다", () => {
    const resource = "/consumer/private-project/src/app.js";

    try {
      resolvePackageResource(resource);
      throw new Error("package 경로 판정이 실패해야 합니다.");
    } catch (error) {
      expect(error).toEqual(
        expect.objectContaining<Partial<NextWebpackBaselineError>>({
          code: "NWB_PACKAGE_PATH_UNRESOLVED",
        }),
      );
      expect((error as Error).message).not.toContain(resource);
      expect(Object.keys(error as object)).not.toContain("detail");
    }
  });
});
