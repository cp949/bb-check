import { describe, expect, it } from "vitest";
import type { KnownUnsupportedSignal } from "../src/config.js";
import { LegacyBrowserSmokeError } from "../src/errors.js";
import {
  isReadyResult,
  matchKnownUnsupported,
  readyExpression,
  validateLoopbackOrigin,
} from "../src/page-contract.js";
import type { PageSignal } from "../src/resources.js";
import { normalizeSignalText } from "../src/signal.js";

describe("validateLoopbackOrigin", () => {
  it.each([
    ["http://127.0.0.1", "http://127.0.0.1"],
    ["http://127.0.0.1:8080", "http://127.0.0.1:8080"],
    ["http://localhost", "http://localhost"],
    ["http://localhost:3000", "http://localhost:3000"],
    ["http://[::1]", "http://[::1]"],
    ["http://[::1]:9000", "http://[::1]:9000"],
  ])("%s를 %s로 정규화해 허용한다", (input, expected) => {
    expect(validateLoopbackOrigin(input)).toBe(expected);
  });

  it.each([
    ["https://127.0.0.1", "protocol이 http가 아님"],
    ["http://example.com", "hostname이 loopback이 아님"],
    ["http://user@127.0.0.1", "userinfo 포함"],
    ["http://127.0.0.1/path", "path가 루트가 아님"],
    ["http://127.0.0.1?q=1", "search 포함"],
    ["http://127.0.0.1#frag", "hash 포함"],
    ["not a url", "URL 파싱 실패"],
    ["ftp://localhost", "protocol이 http가 아님"],
  ])("%s를 거부한다 (%s)", (input) => {
    let thrown: unknown;
    try {
      validateLoopbackOrigin(input);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(LegacyBrowserSmokeError);
    expect((thrown as LegacyBrowserSmokeError).code).toBe(
      "LBS_ORIGIN_NOT_LOOPBACK",
    );
  });

  it("URL 파싱 실패는 원래 오류를 cause로 보존한다", () => {
    let thrown: unknown;
    try {
      validateLoopbackOrigin("not a url");
    } catch (error) {
      thrown = error;
    }
    expect((thrown as LegacyBrowserSmokeError).cause).toBeInstanceOf(Error);
  });

  it("port는 어떤 값이든 허용한다", () => {
    expect(validateLoopbackOrigin("http://127.0.0.1:1")).toBe(
      "http://127.0.0.1:1",
    );
    expect(validateLoopbackOrigin("http://127.0.0.1:65535")).toBe(
      "http://127.0.0.1:65535",
    );
  });
});

describe("readyExpression", () => {
  it("selector 조건을 JSON 이스케이프된 querySelector 식으로 컴파일한다", () => {
    expect(readyExpression({ kind: "selector", selector: "#app" })).toBe(
      'document.querySelector("#app") !== null',
    );
  });

  it("selector 안의 큰따옴표와 백슬래시도 안전하게 이스케이프한다", () => {
    const selector = 'div[data-x="y\\z"]';
    const expression = readyExpression({ kind: "selector", selector });
    expect(expression).toBe(
      `document.querySelector(${JSON.stringify(selector)}) !== null`,
    );
    expect(expression).toContain('\\"');
  });

  it("expression 조건은 그대로 반환한다", () => {
    expect(
      readyExpression({
        kind: "expression",
        expression: "window.__ready === true",
      }),
    ).toBe("window.__ready === true");
  });
});

describe("isReadyResult", () => {
  it("boolean type과 true value는 ready로 판정한다", () => {
    expect(isReadyResult({ result: { type: "boolean", value: true } })).toBe(
      true,
    );
  });

  it("value가 false면 not ready로 판정한다", () => {
    expect(isReadyResult({ result: { value: false } })).toBe(false);
  });

  it("exceptionDetails가 있으면 value가 truthy여도 not ready다", () => {
    expect(
      isReadyResult({
        result: { value: true },
        exceptionDetails: { text: "boom" },
      }),
    ).toBe(false);
  });

  it("expression 결과의 비boolean truthy 값도 ready로 판정한다", () => {
    expect(isReadyResult({ result: { value: "ready-marker" } })).toBe(true);
    expect(isReadyResult({ result: { value: 1 } })).toBe(true);
  });

  it("형식이 잘못되거나 비어 있는 결과는 예외 없이 not ready로 판정한다", () => {
    expect(isReadyResult({})).toBe(false);
    expect(isReadyResult(null)).toBe(false);
    expect(isReadyResult(undefined)).toBe(false);
    expect(isReadyResult("not an object")).toBe(false);
    expect(isReadyResult(42)).toBe(false);
    expect(isReadyResult({ result: {} })).toBe(false);
    expect(isReadyResult({ result: "not a record" })).toBe(false);
  });
});

describe("matchKnownUnsupported", () => {
  const signal = (kind: PageSignal["kind"], text: string): PageSignal => ({
    kind,
    text,
  });

  const declaration = (
    kind: KnownUnsupportedSignal["kind"],
    pattern: string,
    count: number,
    reason = "레거시 신호",
  ): KnownUnsupportedSignal => ({ kind, pattern, count, reason });

  it("선언한 count와 정확히 같은 개수의 signal은 두 출력 배열을 모두 비운다", () => {
    const result = matchKnownUnsupported(
      [signal("console", "warn A"), signal("console", "warn A")],
      [declaration("console", "warn A", 2)],
    );
    expect(result.unexpectedSignals).toEqual([]);
    expect(result.missingKnownUnsupported).toEqual([]);
  });

  it("선언한 count보다 signal이 적으면 부족분만 missingKnownUnsupported에 담는다", () => {
    const result = matchKnownUnsupported(
      [signal("console", "warn A")],
      [declaration("console", "warn A", 3)],
    );
    expect(result.missingKnownUnsupported).toEqual([
      declaration("console", "warn A", 2),
    ]);
    expect(result.unexpectedSignals).toEqual([]);
  });

  it("선언한 count보다 signal이 많으면 초과분이 unexpectedSignals에 남는다", () => {
    const result = matchKnownUnsupported(
      [
        signal("console", "warn A"),
        signal("console", "warn A"),
        signal("console", "warn A"),
      ],
      [declaration("console", "warn A", 2)],
    );
    expect(result.unexpectedSignals).toEqual([signal("console", "warn A")]);
    expect(result.missingKnownUnsupported).toEqual([]);
  });

  it("정규화된 text가 같아도 kind가 다르면 unexpectedSignals에 남고 선언은 missing으로 남는다", () => {
    const result = matchKnownUnsupported(
      [signal("page-error", "same text")],
      [declaration("console", "same text", 1)],
    );
    expect(result.unexpectedSignals).toEqual([
      signal("page-error", "same text"),
    ]);
    expect(result.missingKnownUnsupported).toEqual([
      declaration("console", "same text", 1),
    ]);
  });

  it("입력 순서가 달라도 정렬된 출력은 완전히 동일하다", () => {
    const signalsA = [
      signal("console", "b"),
      signal("console", "a"),
      signal("page-error", "z"),
    ];
    const signalsB = [
      signal("page-error", "z"),
      signal("console", "a"),
      signal("console", "b"),
    ];
    const resultA = matchKnownUnsupported(signalsA, []);
    const resultB = matchKnownUnsupported(signalsB, []);
    expect(resultA).toEqual(resultB);
    expect(resultA.unexpectedSignals.map((item) => item.text)).toEqual([
      "a",
      "b",
      "z",
    ]);
  });

  it("정규화되지 않은 signal text도 config 시점에 정규화된 pattern과 일치한다", () => {
    const rawText = "warn\r\n  A  \r";
    const normalized = normalizeSignalText(rawText);
    const result = matchKnownUnsupported(
      [signal("console", rawText)],
      [declaration("console", normalized, 1)],
    );
    expect(result.unexpectedSignals).toEqual([]);
    expect(result.missingKnownUnsupported).toEqual([]);
  });

  it("출력에 남는 signal의 text는 정규화된 값이다", () => {
    const rawText = "warn\r\nA \r";
    const normalized = normalizeSignalText(rawText);
    const result = matchKnownUnsupported(
      [signal("console", rawText), signal("console", rawText)],
      [declaration("console", normalized, 1)],
    );
    expect(result.unexpectedSignals).toEqual([
      { kind: "console", text: normalized },
    ]);
  });

  it("반환값과 그 원소를 모두 freeze한다", () => {
    const result = matchKnownUnsupported(
      [signal("console", "a")],
      [declaration("page-error", "unused", 1)],
    );
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.unexpectedSignals)).toBe(true);
    expect(Object.isFrozen(result.unexpectedSignals[0])).toBe(true);
    expect(Object.isFrozen(result.missingKnownUnsupported)).toBe(true);
    expect(Object.isFrozen(result.missingKnownUnsupported[0])).toBe(true);
  });
});
