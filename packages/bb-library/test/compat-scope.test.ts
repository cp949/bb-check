// collectGlobalReferences가 "가려지지 않은 전역 참조"만 정확히 골라내는지
// 검사한다. runtime API 판정(compat-scanner)의 Tier 1은 이 함수가 만드는
// 증명 위에서만 성립하므로, 오탐(shadow된 이름을 전역으로 봄)과 미탐(진짜
// 전역을 가려진 것으로 봄) 둘 다 여기서 막아야 한다.

import { parse } from "acorn";
import type { Program } from "acorn";
import { describe, expect, it } from "vitest";
import { collectGlobalReferences } from "../src/index.js";

const parseModule = (source: string): Program =>
  parse(source, { ecmaVersion: "latest", sourceType: "module" }) as Program;

/** source에서 전역으로 해석된 식별자 이름만 정렬해서 뽑는다. */
const globalNames = (source: string): string[] =>
  [...collectGlobalReferences(parseModule(source))]
    .map((node) => node.name)
    .sort();

describe("collectGlobalReferences", () => {
  it("브리프 예시: 매개변수가 전역을 가리면 global reference가 아니다", () => {
    const ast = parseModule(
      "function f(AbortSignal) { return AbortSignal.timeout(1); }",
    );
    expect(collectGlobalReferences(ast)).not.toContainEqual(
      expect.objectContaining({ name: "AbortSignal" }),
    );
  });

  it("선언되지 않은 식별자는 전역이다", () => {
    expect(globalNames("structuredClone(value);")).toEqual([
      "structuredClone",
      "value",
    ]);
  });

  it("const 선언이 전역을 가린다", () => {
    expect(
      globalNames("const structuredClone = f;\nstructuredClone(v);"),
    ).toEqual(["f", "v"]);
  });

  it("let/var 선언이 전역을 가린다", () => {
    expect(
      globalNames(
        "let WeakRef = 1; var reportError = 2; WeakRef; reportError;",
      ),
    ).toEqual([]);
  });

  it("함수 선언이 전역을 가린다(호이스팅으로 선언 앞 참조도 가림)", () => {
    expect(globalNames("reportError();\nfunction reportError() {}")).toEqual(
      [],
    );
  });

  it("클래스 선언이 전역을 가린다", () => {
    expect(globalNames("class WeakRef {}\nnew WeakRef();")).toEqual([]);
  });

  it("module 최상위 let/const/class는 선언 전 TDZ 참조도 가린다", () => {
    const source = [
      "structuredClone(v);",
      "reportError(e);",
      "new WeakRef(x);",
      "let structuredClone = f;",
      "const reportError = g;",
      "class WeakRef {}",
    ].join("\n");
    expect(globalNames(source)).toEqual(["e", "f", "g", "v", "x"]);
  });

  it("함수 body 안 let/const/class도 선언 전 TDZ 참조를 가린다", () => {
    const source = [
      "function outer() {",
      "  structuredClone(v);",
      "  let structuredClone = f;",
      "}",
    ].join("\n");
    expect(globalNames(source)).toEqual(["f", "v"]);
  });

  it("block 안 let 선언도 선언 전 참조를 가린다", () => {
    const source = "{ structuredClone(v); let structuredClone = f; }";
    expect(globalNames(source)).toEqual(["f", "v"]);
  });

  it("block 밖에서는 block 안 let 선언이 가리지 못한다", () => {
    const source = "{ let structuredClone = 1; }\nstructuredClone(v);";
    expect(globalNames(source)).toEqual(["structuredClone", "v"]);
  });

  it("static block의 var는 static block 전체에 선언 전 참조까지 hoist된다", () => {
    const source =
      "class C { static { structuredClone(v); var structuredClone = f; } }";
    expect(globalNames(source)).toEqual(["f", "v"]);
  });

  it("static block 안 중첩 block의 var도 static block 전체에 hoist된다", () => {
    const source =
      "class C { static { structuredClone(v); { var structuredClone = f; } } }";
    expect(globalNames(source)).toEqual(["f", "v"]);
  });

  it("static block의 var는 바깥 참조를 가리지 않는다", () => {
    const source =
      "class C { static { var structuredClone = 1; } }\nstructuredClone(v);";
    expect(globalNames(source)).toEqual(["structuredClone", "v"]);
  });

  it("import 바인딩이 전역을 가린다(선언 앞 참조까지)", () => {
    const source = [
      "structuredClone(v);",
      'import structuredClone from "polyfill";',
    ].join("\n");
    expect(globalNames(source)).toEqual(["v"]);
  });

  it("import 네임스페이스/기본 바인딩도 전역을 가린다", () => {
    const source = [
      'import * as WeakRef from "a";',
      'import AggregateError, { x } from "b";',
      "WeakRef; AggregateError; x;",
    ].join("\n");
    expect(globalNames(source)).toEqual([]);
  });

  it("매개변수가 전역을 가린다", () => {
    expect(
      globalNames("function f(structuredClone) { structuredClone(1); }"),
    ).toEqual([]);
  });

  it("구조분해 매개변수(배열/객체/rest)가 전역을 가린다", () => {
    const source =
      "function f({ a: structuredClone }, [WeakRef], ...AggregateError) {" +
      " structuredClone; WeakRef; AggregateError; }";
    expect(globalNames(source)).toEqual([]);
  });

  it("기본값 있는 매개변수도 가리고, 기본값 표현식은 값 참조로 남는다", () => {
    expect(globalNames("const f = (WeakRef = fallback) => WeakRef;")).toEqual([
      "fallback",
    ]);
  });

  it("catch 바인딩이 전역을 가린다", () => {
    const source = "try { x(); } catch (AggregateError) { AggregateError; }";
    expect(globalNames(source)).toEqual(["x"]);
  });

  it("var는 함수 스코프이므로 중첩 block 밖에서도 가린다", () => {
    const source =
      "function f() { { var structuredClone = 1; } structuredClone(); }";
    expect(globalNames(source)).toEqual([]);
  });

  it("멤버 표현식의 프로퍼티 이름은 전역 참조가 아니다", () => {
    expect(globalNames("obj.structuredClone;")).toEqual(["obj"]);
  });

  it("computed 멤버의 key는 전역 참조다", () => {
    expect(globalNames("obj[WeakRef];")).toEqual(["WeakRef", "obj"]);
  });

  it("객체 리터럴의 non-computed key는 전역 참조가 아니지만 축약 프로퍼티는 값 참조다", () => {
    expect(globalNames("({ structuredClone: 1, [WeakRef]: 2 });")).toEqual([
      "WeakRef",
    ]);
    expect(globalNames("({ structuredClone });")).toEqual(["structuredClone"]);
  });

  it("라벨은 전역 참조가 아니다", () => {
    expect(globalNames("outer: for (;;) { break outer; }")).toEqual([]);
  });

  it("함수 표현식의 이름은 자기 스코프 안에서만 보인다", () => {
    const source =
      "const f = function WeakRef() { return WeakRef; };\nWeakRef;";
    expect(globalNames(source)).toEqual(["WeakRef"]);
  });

  it("클래스 표현식의 이름도 자기 스코프 안에서만 보인다", () => {
    expect(globalNames("const X = class WeakRef {};")).toEqual([]);
    const source =
      "const f = class WeakRef { static m() { return WeakRef; } };\nWeakRef;";
    expect(globalNames(source)).toEqual(["WeakRef"]);
  });

  it("같은 이름을 여러 번 참조하면 참조마다 별개 항목으로 담긴다", () => {
    const ast = parseModule("structuredClone(structuredClone);");
    expect(collectGlobalReferences(ast).size).toBe(2);
  });

  it("new.target과 import.meta는 전역 참조가 아니다", () => {
    expect(globalNames("function f(){ return new.target; }")).toEqual([]);
    expect(globalNames("import.meta.url;")).toEqual([]);
  });

  it("export * as 별칭은 실제 전역 이름과 겹쳐도 스코프 참조가 아니다", () => {
    expect(globalNames('export * as structuredClone from "mod";')).toEqual([]);
  });

  it("for-of/for-in/C형 for의 바인딩이 전역을 가린다", () => {
    expect(globalNames("for (const x of arr) { x; }")).toEqual(["arr"]);
    expect(globalNames("for (const k in obj) { k; }")).toEqual(["obj"]);
    expect(globalNames("for (let i = 0; i < n; i++) { i; }")).toEqual(["n"]);
  });

  it("클래스 non-computed 메서드 이름은 전역 참조가 아니지만 computed 키는 참조다", () => {
    expect(globalNames("class C { structuredClone() {} }")).toEqual([]);
    expect(globalNames("class C { [WeakRef]() {} }")).toEqual(["WeakRef"]);
  });

  it("export된 함수 선언도 module 안에서 호이스팅된다", () => {
    const source = "reportError();\nexport function reportError() {}";
    expect(globalNames(source)).toEqual([]);
  });
});
