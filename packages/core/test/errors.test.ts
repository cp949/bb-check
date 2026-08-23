import { describe, expect, it } from "vitest";
import { BbError } from "../src/index.js";

describe("BbError", () => {
  it("오류 code와 cause를 보존한다", () => {
    const cause = new Error("disk");
    const error = new BbError("BB_TARGET_READ", "읽기 실패", { cause });
    expect(error).toMatchObject({
      code: "BB_TARGET_READ",
      message: "읽기 실패",
      cause,
    });
  });

  it("Error의 인스턴스이며 name이 BbError다", () => {
    const error = new BbError("BB_USAGE", "사용법 오류");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("BbError");
  });

  it("cause 없이도 생성할 수 있다", () => {
    const error = new BbError("BB_CONFIG_NOT_FOUND", "설정 파일 없음");
    expect(error.code).toBe("BB_CONFIG_NOT_FOUND");
    expect(error.cause).toBeUndefined();
  });
});
