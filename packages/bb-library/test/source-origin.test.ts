import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createOriginLookup } from "../src/index.js";

const fixture = (...segments: string[]) =>
  join(import.meta.dirname, "fixtures", ...segments);

describe("createOriginLookup", () => {
  it("생성 위치를 원본 파일 위치로 바꾼다", async () => {
    const validMapText = await readFile(
      fixture("source-map", "dist", "index.js.map"),
      "utf8",
    );
    const result = createOriginLookup(validMapText, { mapDir: "dist" });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("unreachable");
    expect(result.originOf(1)).toMatch(/src\/input\.ts$/);
  });

  it("여러 line에 걸쳐 sourceIndex가 누적된다(line마다 리셋되지 않는다)", () => {
    // mappings의 sourceIndex/originalLine/originalColumn은 generatedColumn과
    // 달리 파일 전체에 걸쳐 누적되는 delta다(source map v3 스펙). 3번째
    // line은 자신의 sourceIndex delta가 0이라 "누적값을 그대로 유지"와
    // "line마다 0으로 리셋 후 0을 더함"을 구분하지 못하는 2-line 구성으로는
    // 이 버그를 잡을 수 없어, 의도적으로 3 line을 쓴다: 1번째 line은
    // source[0], 2번째 line에서 +1 delta로 source[1]로 넘어가고, 3번째
    // line은 delta 0으로 그 누적을 유지해야 한다. 리셋 버그가 있으면
    // 3번째 line이 다시 source[0]로 잘못 돌아간다.
    const mapText = JSON.stringify({
      version: 3,
      sources: ["a.ts", "b.ts"],
      sourcesContent: ["", ""],
      mappings: "AAAA;ACAA;AAAA",
      names: [],
    });
    const result = createOriginLookup(mapText, { mapDir: "dist" });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("unreachable");
    expect(result.originOf(1)).toBe("dist/a.ts");
    expect(result.originOf(2)).toBe("dist/b.ts");
    expect(result.originOf(3)).toBe("dist/b.ts");
  });

  it("mapDir 밖으로 벗어나는 sources 항목도 정보로 보존한다", () => {
    const mapText = JSON.stringify({
      version: 3,
      sources: ["../../outside/lib.ts"],
      sourcesContent: ["export {};"],
      mappings: "AAAA",
      names: [],
    });
    const result = createOriginLookup(mapText, { mapDir: "packages/a/dist" });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("unreachable");
    expect(result.originOf(1)).toBe("packages/outside/lib.ts");
  });

  it("이미 절대 경로인 sources 항목은 mapDir과 합치지 않고 그대로 둔다", () => {
    const mapText = JSON.stringify({
      version: 3,
      sources: ["/abs/src/lib.ts"],
      sourcesContent: ["export {};"],
      mappings: "AAAA",
      names: [],
    });
    const result = createOriginLookup(mapText, { mapDir: "dist" });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("unreachable");
    expect(result.originOf(1)).toBe("/abs/src/lib.ts");
  });

  // 잡는 생산 결함: sourceRoot의 마지막 segment를 잘라내면 ECMA-426
  // DecodeSourceMapSources(trailing slash가 없으면 "/"만 붙인다) 대신
  // src가 사라진 ../를 sourceURLPrefix로 쓴다.
  it("trailing slash가 없는 상대 sourceRoot는 slash만 덧붙인 sourceURLPrefix를 쓴다", () => {
    const mapText = JSON.stringify({
      version: 3,
      sourceRoot: "../src",
      sources: ["input.ts"],
      mappings: "AAAA",
    });
    const result = createOriginLookup(mapText, { mapDir: "packages/a/dist" });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("unreachable");
    expect(result.originOf(1)).toBe("packages/a/src/input.ts");
  });

  // 잡는 생산 결함: present 빈 sourceRoot를 absent처럼 취급하면 §5.2가
  // 요구하는 sourceURLPrefix '/'를 누락한다.
  it("빈 sourceRoot는 slash sourceURLPrefix를 만든다", () => {
    const mapText = JSON.stringify({
      version: 3,
      sourceRoot: "",
      sources: ["input.ts"],
      mappings: "AAAA",
    });
    const result = createOriginLookup(mapText, { mapDir: "dist" });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("unreachable");
    expect(result.originOf(1)).toBe("/input.ts");
  });

  // 잡는 생산 결함: POSIX sourceRoot의 마지막 segment를 잘라내면
  // /workspace/src/ 대신 src가 사라진 /workspace/를 사용한다.
  it("trailing slash가 없는 POSIX 절대 sourceRoot는 slash만 덧붙인 sourceURLPrefix를 쓴다", () => {
    const mapText = JSON.stringify({
      version: 3,
      sourceRoot: "/workspace/src",
      sources: ["nested/input.ts"],
      mappings: "AAAA",
    });
    const result = createOriginLookup(mapText, { mapDir: "packages/a/dist" });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("unreachable");
    expect(result.originOf(1)).toBe("/workspace/src/nested/input.ts");
  });

  // 잡는 생산 결함: Windows sourceRoot의 마지막 segment를 잘라내면
  // C:/workspace/src/ 대신 src가 사라진 C:/workspace/를 사용한다.
  it("trailing slash가 없는 Windows 절대 sourceRoot는 slash만 덧붙인 sourceURLPrefix를 쓴다", () => {
    const mapText = JSON.stringify({
      version: 3,
      sourceRoot: "C:\\workspace\\src",
      sources: ["nested\\input.ts"],
      mappings: "AAAA",
    });
    const result = createOriginLookup(mapText, { mapDir: "packages/a/dist" });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("unreachable");
    expect(result.originOf(1)).toBe("C:/workspace/src/nested/input.ts");
  });

  // 잡는 생산 결함: UNC sourceRoot의 마지막 segment를 잘라내는 문제와
  // //server/share/... 경로를 posix.normalize에 넘겼을 때 선행 double
  // slash가 single slash로 축약되는 문제를 동시에 잡는다.
  it("trailing slash가 없는 UNC sourceRoot는 src를 보존하고 선행 double slash도 보존한다", () => {
    const mapText = JSON.stringify({
      version: 3,
      sourceRoot: "\\\\server\\share\\src",
      sources: ["nested\\a.ts"],
      mappings: "AAAA",
    });
    const result = createOriginLookup(mapText, { mapDir: "packages/a/dist" });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("unreachable");
    expect(result.originOf(1)).toBe("//server/share/src/nested/a.ts");
  });

  // 잡는 생산 결함: trailing slash가 있는 URL sourceRoot도 prefix 자체에는
  // 포함되어야 하므로 URL의 마지막 path segment를 잃으면 안 된다.
  it("trailing slash가 있는 absolute URL sourceRoot를 sourceURLPrefix로 쓴다", () => {
    const mapText = JSON.stringify({
      version: 3,
      sourceRoot: "https://cdn.example.test/pkg/src/",
      sources: ["nested/input.ts"],
      mappings: "AAAA",
    });
    const result = createOriginLookup(mapText, { mapDir: "packages/a/dist" });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("unreachable");
    expect(result.originOf(1)).toBe(
      "https://cdn.example.test/pkg/src/nested/input.ts",
    );
  });

  // 잡는 생산 결함: trailing slash가 없는 URL sourceRoot의 마지막 segment를
  // 잘라내면 .../pkg/src/ 대신 src가 사라진 .../pkg/를 사용한다.
  it("trailing slash가 없는 absolute URL sourceRoot는 slash만 덧붙인 sourceURLPrefix를 쓴다", () => {
    const mapText = JSON.stringify({
      version: 3,
      sourceRoot: "https://cdn.example.test/pkg/src",
      sources: ["nested/input.ts"],
      mappings: "AAAA",
    });
    const result = createOriginLookup(mapText, { mapDir: "packages/a/dist" });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("unreachable");
    expect(result.originOf(1)).toBe(
      "https://cdn.example.test/pkg/src/nested/input.ts",
    );
  });

  // 잡는 생산 결함: string이 아닌 sourceRoot를 무시하면 malformed map이
  // 성공으로 분류되어 상위가 BB_TARGET_PARSE로 다루지 못한다.
  it("string이 아닌 sourceRoot는 typed parse-failure다", () => {
    const mapText = JSON.stringify({
      version: 3,
      sourceRoot: 123,
      sources: ["input.ts"],
      mappings: "AAAA",
    });
    expect(createOriginLookup(mapText, { mapDir: "dist" }).kind).toBe(
      "parse-failure",
    );
  });

  it("매핑이 없는 line은 undefined를 준다", () => {
    const mapText = JSON.stringify({
      version: 3,
      sources: ["input.ts"],
      sourcesContent: ["x"],
      mappings: "AAAA",
      names: [],
    });
    const result = createOriginLookup(mapText, { mapDir: "dist" });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("unreachable");
    expect(result.originOf(99)).toBeUndefined();
  });

  it("JSON이 아닌 map text는 typed parse-failure다(예외를 던지지 않음)", () => {
    const result = createOriginLookup("not json", { mapDir: "dist" });
    expect(result.kind).toBe("parse-failure");
  });

  it("sources나 mappings가 없는 map은 typed parse-failure다", () => {
    const result = createOriginLookup(JSON.stringify({ version: 3 }), {
      mapDir: "dist",
    });
    expect(result.kind).toBe("parse-failure");
  });

  it("mappings에 잘못된 VLQ 문자가 있으면 typed parse-failure다", () => {
    const mapText = JSON.stringify({
      version: 3,
      sources: ["input.ts"],
      sourcesContent: ["x"],
      mappings: "!!!!",
      names: [],
    });
    const result = createOriginLookup(mapText, { mapDir: "dist" });
    expect(result.kind).toBe("parse-failure");
  });

  it("성공과 실패는 kind로 구분되는 서로 다른 shape다", async () => {
    const validMapText = await readFile(
      fixture("source-map", "dist", "index.js.map"),
      "utf8",
    );
    const ok = createOriginLookup(validMapText, { mapDir: "dist" });
    const failure = createOriginLookup("not json", { mapDir: "dist" });
    expect(ok.kind).not.toBe(failure.kind);
    expect("originOf" in ok).toBe(true);
    expect("originOf" in failure).toBe(false);
  });
});
