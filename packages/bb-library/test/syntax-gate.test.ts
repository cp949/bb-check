import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findFirstSyntaxDivergence } from "../src/index.js";

const fixture = (...segments: string[]) =>
  join(import.meta.dirname, "fixtures", ...segments);

describe("findFirstSyntaxDivergence", () => {
  it("계약 target에서 변환되는 첫 문법을 보고한다", async () => {
    const result = await findFirstSyntaxDivergence(
      "const x = value?.name;",
      "chrome80",
    );
    expect(result).toMatchObject({ line: expect.any(Number) });
  });

  it("발산을 찾으면 kind가 divergence이고 line·column을 함께 준다", async () => {
    const result = await findFirstSyntaxDivergence(
      "const x = value?.name;",
      "chrome80",
    );
    expect(result).toMatchObject({
      kind: "divergence",
      line: 1,
      column: expect.any(Number),
    });
  });

  it("실제 dist fixture에서 optional chaining이 걸린 line을 정확히 찾는다", async () => {
    const source = await readFile(
      fixture("syntax-violation", "dist", "index.js"),
      "utf8",
    );
    const result = await findFirstSyntaxDivergence(source, "chrome70");
    expect(result).toMatchObject({ kind: "divergence", line: 3 });
  });

  it("baseline target으로도 다시 쓸 문법이 없으면 발산이 없다", async () => {
    const result = await findFirstSyntaxDivergence(
      "const x = 1;\nconsole.log(x);\n",
      "chrome80",
    );
    expect(result).toEqual({ kind: "none" });
  });

  it("esbuild가 입력 자체를 파싱하지 못하면 typed parse-failure를 반환한다(예외를 던지지 않음)", async () => {
    const result = await findFirstSyntaxDivergence("const x = ;", "chrome80");
    expect(result).toMatchObject({ kind: "parse-failure", line: 1 });
    expect(result).not.toMatchObject({ kind: "none" });
    expect(result).not.toMatchObject({ kind: "divergence" });
  });

  it("baseline target이 아예 표현할 수 없는 문법은 그 실패 위치를 발산으로 보고한다", async () => {
    // esnext에서는 정상 파싱되지만(top-level await), es2017 target으로는
    // 아예 표현할 수 없어 esbuild가 transform 자체를 실패시키는 경우다.
    // 이는 입력 파싱 실패가 아니라 가장 극단적인 문법 발산이므로
    // parse-failure가 아니라 divergence로 보고해야 한다.
    const result = await findFirstSyntaxDivergence(
      "const x = await Promise.resolve(1);",
      "es2017",
    );
    expect(result).toMatchObject({ kind: "divergence", line: 1 });
  });

  it("문법 발산과 parse-failure는 서로 다른 shape다", async () => {
    const divergence = await findFirstSyntaxDivergence(
      "const x = value?.name;",
      "chrome80",
    );
    const parseFailure = await findFirstSyntaxDivergence(
      "const x = ;",
      "chrome80",
    );
    const none = await findFirstSyntaxDivergence("const x = 1;", "chrome80");

    const kinds = new Set([divergence.kind, parseFailure.kind, none.kind]);
    expect(kinds).toEqual(new Set(["divergence", "parse-failure", "none"]));
  });
});
