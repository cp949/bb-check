import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeConfig } from "../src/config.js";
import { NextWebpackBaselineError } from "../src/errors.js";

const projectDir = resolve("test-project");

describe("normalizeConfig", () => {
  it("상대 projectDir와 policy 및 waiver를 독립된 판정용 값으로 정상화한다", () => {
    const normalized = normalizeConfig({
      projectDir: "test-project",
      policy: [
        {
          package: "legacy-widget",
          reason: "  legacy syntax requires transpilation  ",
        },
      ],
      waivers: [
        {
          package: "legacy-widget",
          reason: "  vendored compatibility branch  ",
          allowedEntrypoints: ["dist/compat.js"],
        },
      ],
    });

    expect(normalized.projectDir).toBe(projectDir);
    expect([...normalized.policyByPackage.entries()]).toEqual([
      [
        "legacy-widget",
        {
          package: "legacy-widget",
          reason: "legacy syntax requires transpilation",
        },
      ],
    ]);
    expect([...normalized.waiversByPackage.entries()]).toEqual([
      [
        "legacy-widget",
        [
          {
            package: "legacy-widget",
            reason: "vendored compatibility branch",
            allowedEntrypoints: ["dist/compat.js"],
          },
        ],
      ],
    ]);
  });

  it("알 수 없는 설정 키를 NWB_CONFIG_INVALID로 거부한다", () => {
    expect(() =>
      normalizeConfig({
        projectDir,
        policy: [],
        unsupported: true,
      }),
    ).toThrow(
      expect.objectContaining<Partial<NextWebpackBaselineError>>({
        code: "NWB_CONFIG_INVALID",
      }),
    );
  });

  it("trim 후 빈 policy reason을 NWB_CONFIG_INVALID로 거부한다", () => {
    expect(() =>
      normalizeConfig({
        projectDir,
        policy: [{ package: "legacy-widget", reason: " \t " }],
      }),
    ).toThrow(
      expect.objectContaining<Partial<NextWebpackBaselineError>>({
        code: "NWB_CONFIG_INVALID",
      }),
    );
  });

  it("동일 package의 policy 중복을 NWB_CONFIG_INVALID로 거부한다", () => {
    expect(() =>
      normalizeConfig({
        projectDir,
        policy: [
          { package: "legacy-widget", reason: "first rule" },
          { package: "legacy-widget", reason: "second rule" },
        ],
      }),
    ).toThrow(
      expect.objectContaining<Partial<NextWebpackBaselineError>>({
        code: "NWB_CONFIG_INVALID",
      }),
    );
  });

  it("같은 package와 entrypoint의 waiver 중복을 NWB_CONFIG_INVALID로 거부한다", () => {
    expect(() =>
      normalizeConfig({
        projectDir,
        policy: [],
        waivers: [
          {
            package: "legacy-widget",
            reason: "first waiver",
            allowedEntrypoints: ["dist/compat.js"],
          },
          {
            package: "legacy-widget",
            reason: "second waiver",
            allowedEntrypoints: ["dist/compat.js"],
          },
        ],
      }),
    ).toThrow(
      expect.objectContaining<Partial<NextWebpackBaselineError>>({
        code: "NWB_CONFIG_INVALID",
      }),
    );
  });

  it("hole이 있는 policy 배열을 NWB_CONFIG_INVALID로 거부한다", () => {
    const policy = new Array(2) as Array<{
      package: string;
      reason: string;
    }>;
    policy[1] = { package: "legacy-widget", reason: "later entry" };

    expect(() => normalizeConfig({ projectDir, policy })).toThrow(
      expect.objectContaining<Partial<NextWebpackBaselineError>>({
        code: "NWB_CONFIG_INVALID",
      }),
    );
  });

  it("입력 객체와 배열을 바꿔도 이미 정상화한 policy와 waiver 판정은 바뀌지 않는다", () => {
    const input = {
      projectDir,
      policy: [{ package: "legacy-widget", reason: "initial policy" }],
      waivers: [
        {
          package: "legacy-widget",
          reason: "initial waiver",
          allowedEntrypoints: ["dist/compat.js"],
        },
      ],
    };
    const normalized = normalizeConfig(input);

    input.policy[0]!.reason = "changed policy";
    input.waivers[0]!.reason = "changed waiver";
    input.waivers[0]!.allowedEntrypoints[0] = "dist/changed.js";
    input.policy.push({ package: "other-widget", reason: "new policy" });

    expect(normalized.policyByPackage.get("legacy-widget")).toEqual({
      package: "legacy-widget",
      reason: "initial policy",
    });
    expect(normalized.waiversByPackage.get("legacy-widget")).toEqual([
      {
        package: "legacy-widget",
        reason: "initial waiver",
        allowedEntrypoints: ["dist/compat.js"],
      },
    ]);
    expect(normalized.policyByPackage.has("other-widget")).toBe(false);
  });
});
