import { describe, expect, it } from "vitest";
import type { NormalizedConfig } from "../src/config.js";
import { NextWebpackBaselineError } from "../src/errors.js";
import { classifyModule } from "../src/classification.js";

const config: NormalizedConfig = {
  projectDir: "/consumer",
  unlistedPackages: "warn",
  policyByPackage: new Map([
    ["legacy-widget", { package: "legacy-widget", reason: "legacy syntax" }],
  ]),
  waiversByPackage: new Map(),
};

describe("classifyModule", () => {
  it.each([
    {
      name: "등록 package",
      resource: "/consumer/node_modules/legacy-widget/dist/index.js",
      isClientEntryReachable: true,
      expected: {
        kind: "registered",
        resource: { package: "legacy-widget", entrypoint: "dist/index.js" },
      },
    },
    {
      name: "미등록 package",
      resource: "/consumer/node_modules/unlisted-widget/dist/index.js",
      isClientEntryReachable: true,
      expected: {
        kind: "unlisted",
        resource: { package: "unlisted-widget", entrypoint: "dist/index.js" },
      },
    },
    {
      name: "일반 application resource",
      resource: "/consumer/src/index.js",
      isClientEntryReachable: true,
      expected: { kind: "ignored" },
    },
    {
      name: "도달하지 않은 package",
      resource: "/consumer/node_modules/legacy-widget/dist/index.js",
      isClientEntryReachable: false,
      expected: { kind: "ignored" },
    },
    {
      name: "barrel optimize resource",
      resource: "__barrel_optimize__",
      isClientEntryReachable: true,
      expected: { kind: "ignored" },
    },
  ])("$name을 discriminated union으로 분류한다", (fixture) => {
    expect(
      classifyModule({
        config,
        resource: fixture.resource,
        isClientEntryReachable: fixture.isClientEntryReachable,
      }),
    ).toEqual(fixture.expected);
  });

  it.each([
    "relative/index.js",
    "/consumer/node_modules/legacy-widget",
    "/consumer/.yarn/cache/widget.zip/node_modules/widget/index.js",
  ])("해석 불가능한 resource %s는 안정된 오류로 중단한다", (resource) => {
    expect(() =>
      classifyModule({ config, resource, isClientEntryReachable: false }),
    ).toThrow(
      expect.objectContaining<Partial<NextWebpackBaselineError>>({
        code: "NWB_PACKAGE_PATH_UNRESOLVED",
      }),
    );
  });
});
