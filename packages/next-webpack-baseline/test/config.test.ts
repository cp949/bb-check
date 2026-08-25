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

  it.each([
    {
      name: "non-enumerable string key",
      createInput: () => {
        const input = { projectDir, policy: [] };
        Object.defineProperty(input, "hidden-key-sentinel", {
          enumerable: false,
          value: "hidden-value-sentinel",
        });
        return input;
      },
    },
    {
      name: "symbol accessor key",
      createInput: () => {
        const input = { projectDir, policy: [] };
        Object.defineProperty(input, Symbol("symbol-key-sentinel"), {
          get: () => {
            throw new Error("symbol-getter-sentinel");
          },
        });
        return input;
      },
    },
  ])(
    "알 수 없는 $name를 실행하거나 노출하지 않고 거부한다",
    ({ createInput }) => {
      let caught: unknown;
      try {
        normalizeConfig(createInput());
      } catch (error) {
        caught = error;
      }

      expect(caught).toEqual(
        expect.objectContaining<Partial<NextWebpackBaselineError>>({
          code: "NWB_CONFIG_INVALID",
        }),
      );
      expect(caught).toBeInstanceOf(Error);
      if (!(caught instanceof Error)) return;
      expect(caught.message).not.toContain("key-sentinel");
      expect(caught.message).not.toContain("value-sentinel");
      expect(caught.message).not.toContain("getter-sentinel");
    },
  );

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

  it("상속된 root config 값을 NWB_CONFIG_INVALID로 거부한다", () => {
    const input = Object.create({
      projectDir,
      policy: [],
    });

    expect(() => normalizeConfig(input)).toThrow(
      expect.objectContaining<Partial<NextWebpackBaselineError>>({
        code: "NWB_CONFIG_INVALID",
      }),
    );
  });

  it("상속된 policy와 waiver 값을 NWB_CONFIG_INVALID로 거부한다", () => {
    const inheritedPolicy = Object.create({
      package: "legacy-widget",
      reason: "inherited policy",
    });
    const inheritedWaiver = Object.create({
      package: "legacy-widget",
      reason: "inherited waiver",
      allowedEntrypoints: ["dist/compat.js"],
    });

    expect(() =>
      normalizeConfig({ projectDir, policy: [inheritedPolicy] }),
    ).toThrow(
      expect.objectContaining<Partial<NextWebpackBaselineError>>({
        code: "NWB_CONFIG_INVALID",
      }),
    );
    expect(() =>
      normalizeConfig({
        projectDir,
        policy: [],
        waivers: [inheritedWaiver],
      }),
    ).toThrow(
      expect.objectContaining<Partial<NextWebpackBaselineError>>({
        code: "NWB_CONFIG_INVALID",
      }),
    );
  });

  it.each([
    {
      name: "root projectDir",
      input: () => {
        const config = { policy: [] as unknown[] };
        Object.defineProperty(config, "projectDir", {
          enumerable: true,
          get: () => {
            throw new Error("root getter must not run");
          },
        });
        return config;
      },
    },
    {
      name: "policy reason",
      input: () => {
        const policy = { package: "legacy-widget" };
        Object.defineProperty(policy, "reason", {
          enumerable: true,
          get: () => {
            throw new Error("policy getter must not run");
          },
        });
        return { projectDir, policy: [policy] };
      },
    },
    {
      name: "waiver reason",
      input: () => {
        const waiver = {
          package: "legacy-widget",
          allowedEntrypoints: ["dist/compat.js"],
        };
        Object.defineProperty(waiver, "reason", {
          enumerable: true,
          get: () => {
            throw new Error("waiver getter must not run");
          },
        });
        return { projectDir, policy: [], waivers: [waiver] };
      },
    },
    {
      name: "allowedEntrypoints index",
      input: () => {
        const allowedEntrypoints: string[] = [];
        Object.defineProperty(allowedEntrypoints, "0", {
          configurable: true,
          enumerable: true,
          get: () => {
            throw new Error("entrypoint getter must not run");
          },
        });
        allowedEntrypoints.length = 1;
        return {
          projectDir,
          policy: [],
          waivers: [
            {
              package: "legacy-widget",
              reason: "accessor entrypoint",
              allowedEntrypoints,
            },
          ],
        };
      },
    },
  ])(
    "%s accessor를 실행하지 않고 NWB_CONFIG_INVALID로 거부한다",
    ({ input }) => {
      expect(() => normalizeConfig(input())).toThrow(
        expect.objectContaining<Partial<NextWebpackBaselineError>>({
          code: "NWB_CONFIG_INVALID",
        }),
      );
    },
  );

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
