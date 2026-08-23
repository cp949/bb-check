import { describe, expect, it } from "vitest";
import { normalizeConfig } from "../src/index.js";

describe("normalizeConfig", () => {
  it("own index가 없는 sparse allow 배열을 거절한다", () => {
    const allow = new Array(1);
    expect(() =>
      normalizeConfig({ library: { projectDir: ".", allow } }, "/repo"),
    ).toThrowError(/\[BB_CONFIG_INVALID\].*library\.allow\[0\]/);
  });

  it("상속 property와 입력 객체 mutation을 차단한다", () => {
    const library = Object.create({ projectDir: "/leak" }) as Record<
      string,
      unknown
    >;
    library.allow = [];
    expect(() => normalizeConfig({ library }, "/repo")).toThrowError(
      /\[BB_CONFIG_INVALID\].*library/,
    );

    const input = { library: { projectDir: ".", allow: [] } };
    const normalized = normalizeConfig(input, "/repo");
    input.library.projectDir = "changed";
    expect(normalized.library?.projectDir).toBe("/repo");
    expect(Object.isFrozen(normalized.library?.allow)).toBe(true);
  });

  it("root가 object가 아니면 거절한다", () => {
    expect(() => normalizeConfig(null, "/repo")).toThrowError(
      /\[BB_CONFIG_INVALID\]/,
    );
    expect(() => normalizeConfig("config", "/repo")).toThrowError(
      /\[BB_CONFIG_INVALID\]/,
    );
    expect(() => normalizeConfig([], "/repo")).toThrowError(
      /\[BB_CONFIG_INVALID\]/,
    );
  });

  // 잡는 생산 결함: root의 prototype을 검사하지 않으면 class instance와
  // 사용자 정의 prototype object의 library getter를 실행해 신뢰 경계를 넘는다.
  it("root는 class instance나 사용자 정의 prototype object를 getter 실행 없이 거절한다", () => {
    let classGetterInvoked = false;
    class ConfigClass {
      library = { projectDir: ".", allow: [] };

      get trap() {
        classGetterInvoked = true;
        return "must not run";
      }
    }

    let customPrototypeGetterInvoked = false;
    const customPrototypeRoot = Object.create({}) as Record<string, unknown>;
    customPrototypeRoot.library = { projectDir: ".", allow: [] };
    Object.defineProperty(customPrototypeRoot, "trap", {
      get() {
        customPrototypeGetterInvoked = true;
        return "must not run";
      },
    });

    expect(() => normalizeConfig(new ConfigClass(), "/repo")).toThrowError(
      /\[BB_CONFIG_INVALID\].*config/,
    );
    expect(classGetterInvoked).toBe(false);
    expect(() => normalizeConfig(customPrototypeRoot, "/repo")).toThrowError(
      /\[BB_CONFIG_INVALID\].*config/,
    );
    expect(customPrototypeGetterInvoked).toBe(false);
  });

  it("library 필드가 없으면 거절한다", () => {
    expect(() => normalizeConfig({}, "/repo")).toThrowError(
      /\[BB_CONFIG_INVALID\].*library/,
    );
  });

  it("library가 object가 아니면 거절한다", () => {
    expect(() =>
      normalizeConfig({ library: "not-an-object" }, "/repo"),
    ).toThrowError(/\[BB_CONFIG_INVALID\].*library/);
  });

  // 잡는 생산 결함: library의 prototype을 검사하지 않으면 class instance와
  // 사용자 정의 prototype object의 projectDir getter를 실행한다.
  it("library는 class instance나 사용자 정의 prototype object를 getter 실행 없이 거절한다", () => {
    let classGetterInvoked = false;
    class LibraryClass {
      projectDir = ".";
      allow = [];

      get trap() {
        classGetterInvoked = true;
        return "must not run";
      }
    }

    let customPrototypeGetterInvoked = false;
    const customPrototypeLibrary = Object.create({}) as Record<string, unknown>;
    customPrototypeLibrary.projectDir = ".";
    customPrototypeLibrary.allow = [];
    Object.defineProperty(customPrototypeLibrary, "trap", {
      get() {
        customPrototypeGetterInvoked = true;
        return "must not run";
      },
    });

    expect(() =>
      normalizeConfig({ library: new LibraryClass() }, "/repo"),
    ).toThrowError(/\[BB_CONFIG_INVALID\].*library/);
    expect(classGetterInvoked).toBe(false);
    expect(() =>
      normalizeConfig({ library: customPrototypeLibrary }, "/repo"),
    ).toThrowError(/\[BB_CONFIG_INVALID\].*library/);
    expect(customPrototypeGetterInvoked).toBe(false);
  });

  it("projectDir이 빈 문자열이면 거절한다", () => {
    expect(() =>
      normalizeConfig({ library: { projectDir: "" } }, "/repo"),
    ).toThrowError(/\[BB_CONFIG_INVALID\].*library\.projectDir/);
  });

  it("projectDir이 문자열이 아니면 거절한다", () => {
    expect(() =>
      normalizeConfig({ library: { projectDir: 123 } }, "/repo"),
    ).toThrowError(/\[BB_CONFIG_INVALID\].*library\.projectDir/);
  });

  it("projectDir의 getter를 절대 실행하지 않고 거절한다", () => {
    let invoked = false;
    const library: Record<string, unknown> = { allow: [] };
    Object.defineProperty(library, "projectDir", {
      enumerable: true,
      configurable: true,
      get() {
        invoked = true;
        return "/leak";
      },
    });

    expect(() => normalizeConfig({ library }, "/repo")).toThrowError(
      /\[BB_CONFIG_INVALID\].*library\.projectDir/,
    );
    expect(invoked).toBe(false);
  });

  it("allow가 배열이 아니면 거절한다", () => {
    expect(() =>
      normalizeConfig({ library: { projectDir: ".", allow: "nope" } }, "/repo"),
    ).toThrowError(/\[BB_CONFIG_INVALID\].*library\.allow/);
  });

  it("allow 필드가 없으면 빈 배열로 취급한다", () => {
    const normalized = normalizeConfig(
      { library: { projectDir: "." } },
      "/repo",
    );
    expect(normalized.library.allow).toEqual([]);
  });

  it("library.allow 자체가 getter로 정의되면 빈 배열로 기본 처리하지 않고 절대 실행하지 않은 채 거절한다", () => {
    let invoked = false;
    const library: Record<string, unknown> = { projectDir: "." };
    Object.defineProperty(library, "allow", {
      enumerable: true,
      configurable: true,
      get() {
        invoked = true;
        return [];
      },
    });

    expect(() => normalizeConfig({ library }, "/repo")).toThrowError(
      /\[BB_CONFIG_INVALID\].*library\.allow/,
    );
    expect(invoked).toBe(false);
  });

  it("allow 항목이 getter로 정의되면 절대 실행하지 않고 거절한다", () => {
    let invoked = false;
    const allow: unknown[] = [];
    Object.defineProperty(allow, 0, {
      enumerable: true,
      configurable: true,
      get() {
        invoked = true;
        return { file: "a.js", name: "lib", reason: "ok" };
      },
    });

    expect(() =>
      normalizeConfig({ library: { projectDir: ".", allow } }, "/repo"),
    ).toThrowError(/\[BB_CONFIG_INVALID\].*library\.allow\[0\]/);
    expect(invoked).toBe(false);
  });

  it("allow 항목이 object가 아니면 거절한다", () => {
    expect(() =>
      normalizeConfig(
        { library: { projectDir: ".", allow: ["nope"] } },
        "/repo",
      ),
    ).toThrowError(/\[BB_CONFIG_INVALID\].*library\.allow\[0\]/);
  });

  // 잡는 생산 결함: allowance item의 prototype을 검사하지 않으면 class
  // instance와 사용자 정의 prototype object의 file getter를 실행한다.
  it("allowance item은 class instance나 사용자 정의 prototype object를 getter 실행 없이 거절한다", () => {
    let classGetterInvoked = false;
    class AllowanceClass {
      file = "a.js";
      name = "lib";
      reason = "ok";

      get trap() {
        classGetterInvoked = true;
        return "must not run";
      }
    }

    let customPrototypeGetterInvoked = false;
    const customPrototypeAllowance = Object.create({}) as Record<
      string,
      unknown
    >;
    customPrototypeAllowance.file = "a.js";
    customPrototypeAllowance.name = "lib";
    customPrototypeAllowance.reason = "ok";
    Object.defineProperty(customPrototypeAllowance, "trap", {
      get() {
        customPrototypeGetterInvoked = true;
        return "must not run";
      },
    });

    expect(() =>
      normalizeConfig(
        {
          library: {
            projectDir: ".",
            allow: [new AllowanceClass()],
          },
        },
        "/repo",
      ),
    ).toThrowError(/\[BB_CONFIG_INVALID\].*library\.allow\[0\]/);
    expect(classGetterInvoked).toBe(false);
    expect(() =>
      normalizeConfig(
        {
          library: {
            projectDir: ".",
            allow: [customPrototypeAllowance],
          },
        },
        "/repo",
      ),
    ).toThrowError(/\[BB_CONFIG_INVALID\].*library\.allow\[0\]/);
    expect(customPrototypeGetterInvoked).toBe(false);
  });

  it("allow 항목의 file/name/reason이 own non-empty string이 아니면 거절한다", () => {
    expect(() =>
      normalizeConfig(
        {
          library: {
            projectDir: ".",
            allow: [{ file: "", name: "lib", reason: "ok" }],
          },
        },
        "/repo",
      ),
    ).toThrowError(/\[BB_CONFIG_INVALID\].*library\.allow\[0\]\.file/);

    expect(() =>
      normalizeConfig(
        {
          library: {
            projectDir: ".",
            allow: [{ file: "a.js", reason: "ok" }],
          },
        },
        "/repo",
      ),
    ).toThrowError(/\[BB_CONFIG_INVALID\].*library\.allow\[0\]\.name/);

    expect(() =>
      normalizeConfig(
        {
          library: {
            projectDir: ".",
            allow: [{ file: "a.js", name: "lib" }],
          },
        },
        "/repo",
      ),
    ).toThrowError(/\[BB_CONFIG_INVALID\].*library\.allow\[0\]\.reason/);
  });

  it("allow 항목의 file/name/reason이 공백만으로 이루어지면 거절한다", () => {
    expect(() =>
      normalizeConfig(
        {
          library: {
            projectDir: ".",
            allow: [{ file: "   ", name: "lib", reason: "ok" }],
          },
        },
        "/repo",
      ),
    ).toThrowError(/\[BB_CONFIG_INVALID\].*library\.allow\[0\]\.file/);

    expect(() =>
      normalizeConfig(
        {
          library: {
            projectDir: ".",
            allow: [{ file: "a.js", name: "\t\n", reason: "ok" }],
          },
        },
        "/repo",
      ),
    ).toThrowError(/\[BB_CONFIG_INVALID\].*library\.allow\[0\]\.name/);

    expect(() =>
      normalizeConfig(
        {
          library: {
            projectDir: ".",
            allow: [{ file: "a.js", name: "lib", reason: "  " }],
          },
        },
        "/repo",
      ),
    ).toThrowError(/\[BB_CONFIG_INVALID\].*library\.allow\[0\]\.reason/);
  });

  it("사용자 정의 prototype을 가진 allow 항목을 거절한다", () => {
    const proto = { name: "lib" };
    const item = Object.create(proto) as Record<string, unknown>;
    item.file = "a.js";
    item.reason = "ok";

    expect(() =>
      normalizeConfig({ library: { projectDir: ".", allow: [item] } }, "/repo"),
    ).toThrowError(/\[BB_CONFIG_INVALID\].*library\.allow\[0\]/);
  });

  it("file + name 중복을 거절한다", () => {
    expect(() =>
      normalizeConfig(
        {
          library: {
            projectDir: ".",
            allow: [
              { file: "a.js", name: "lib", reason: "one" },
              { file: "a.js", name: "lib", reason: "two" },
            ],
          },
        },
        "/repo",
      ),
    ).toThrowError(/\[BB_CONFIG_INVALID\].*library\.allow\[1\]/);
  });

  it("같은 file이라도 name이 다르면 중복이 아니다", () => {
    const normalized = normalizeConfig(
      {
        library: {
          projectDir: ".",
          allow: [
            { file: "a.js", name: "lib-a", reason: "one" },
            { file: "a.js", name: "lib-b", reason: "two" },
          ],
        },
      },
      "/repo",
    );
    expect(normalized.library.allow).toHaveLength(2);
  });

  it("projectDir을 configDir 기준 절대 경로로 만든다", () => {
    const normalized = normalizeConfig(
      { library: { projectDir: "sub/dir", allow: [] } },
      "/repo",
    );
    expect(normalized.library.projectDir).toBe("/repo/sub/dir");
  });

  it("projectDir이 이미 절대 경로면 그대로 사용한다", () => {
    const normalized = normalizeConfig(
      { library: { projectDir: "/abs/path", allow: [] } },
      "/repo",
    );
    expect(normalized.library.projectDir).toBe("/abs/path");
  });

  it("정상 입력을 깊게 동결된 새 객체 그래프로 반환한다", () => {
    const input = {
      library: {
        projectDir: ".",
        allow: [{ file: "a.js", name: "lib", reason: "ok" }],
      },
    };
    const normalized = normalizeConfig(input, "/repo");

    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen(normalized.library)).toBe(true);
    expect(Object.isFrozen(normalized.library.allow)).toBe(true);
    expect(Object.isFrozen(normalized.library.allow[0])).toBe(true);
    expect(normalized).not.toBe(input);
    expect(normalized.library).not.toBe(input.library);
    expect(normalized.library.allow).not.toBe(input.library.allow);
    expect(normalized.library.allow[0]).not.toBe(input.library.allow[0]);
    expect(normalized.library.allow[0]).toEqual({
      file: "a.js",
      name: "lib",
      reason: "ok",
    });

    // 입력을 나중에 mutate해도 반환된 결과는 영향받지 않는다.
    input.library.allow[0]!.file = "changed.js";
    expect(normalized.library.allow[0]?.file).toBe("a.js");
  });
});
