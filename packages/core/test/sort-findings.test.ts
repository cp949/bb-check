import { describe, expect, it } from "vitest";
import { sortFindings } from "../src/index.js";
import type { Finding } from "../src/index.js";

describe("sortFindings", () => {
  it("finding을 axis, file, line, name 순서로 정렬한다", () => {
    const input = [
      { axis: "runtime-js", file: "b.js", line: 2, name: "at", detail: "x" },
      {
        axis: "syntax",
        file: "a.js",
        line: 9,
        name: "optional-chaining",
        detail: "x",
      },
    ] as const;

    expect(sortFindings(input).map(({ axis }) => axis)).toEqual([
      "syntax",
      "runtime-js",
    ]);
    expect(input[0]?.file).toBe("b.js");
  });

  it("axis 순서는 syntax, runtime-js, dependency, css다", () => {
    const input: readonly Finding[] = [
      { axis: "css", file: "a.css", line: 1, name: "gap", detail: "x" },
      { axis: "dependency", file: "a.js", line: 1, name: "lib", detail: "x" },
      { axis: "runtime-js", file: "a.js", line: 1, name: "at", detail: "x" },
      { axis: "syntax", file: "a.js", line: 1, name: "chain", detail: "x" },
    ];

    expect(sortFindings(input).map(({ axis }) => axis)).toEqual([
      "syntax",
      "runtime-js",
      "dependency",
      "css",
    ]);
  });

  it("같은 axis에서는 file 오름차순으로 정렬한다", () => {
    const input: readonly Finding[] = [
      { axis: "syntax", file: "z.js", line: 1, name: "n", detail: "x" },
      { axis: "syntax", file: "a.js", line: 1, name: "n", detail: "x" },
    ];

    expect(sortFindings(input).map(({ file }) => file)).toEqual([
      "a.js",
      "z.js",
    ]);
  });

  it("같은 file 안에서는 line 오름차순으로 정렬하고 line: null은 뒤에 둔다", () => {
    const input: readonly Finding[] = [
      { axis: "syntax", file: "a.js", line: null, name: "n", detail: "x" },
      { axis: "syntax", file: "a.js", line: 10, name: "n", detail: "x" },
      { axis: "syntax", file: "a.js", line: 3, name: "n", detail: "x" },
    ];

    expect(sortFindings(input).map(({ line }) => line)).toEqual([3, 10, null]);
  });

  it("axis, file, line이 같으면 name 오름차순으로 정렬한다", () => {
    const input: readonly Finding[] = [
      { axis: "syntax", file: "a.js", line: 1, name: "z", detail: "x" },
      { axis: "syntax", file: "a.js", line: 1, name: "a", detail: "x" },
    ];

    expect(sortFindings(input).map(({ name }) => name)).toEqual(["a", "z"]);
  });

  it("입력 배열과 요소를 변경하지 않고 복사본을 정렬한다", () => {
    const input: readonly Finding[] = [
      { axis: "runtime-js", file: "b.js", line: 2, name: "at", detail: "x" },
      {
        axis: "syntax",
        file: "a.js",
        line: 9,
        name: "optional-chaining",
        detail: "x",
      },
    ];
    const snapshot = [...input];

    const sorted = sortFindings(input);

    expect(sorted).not.toBe(input);
    expect(input).toEqual(snapshot);
    expect(input[0]?.file).toBe("b.js");
  });
});
