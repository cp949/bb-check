import { describe, expect, it } from "vitest";
import type { KnownUnsupportedSignal } from "../src/config.js";
import { LegacyBrowserSmokeError } from "../src/errors.js";
import {
  isReadyResult,
  matchKnownUnsupported,
  navigateErrorText,
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
  /**
   * 컴파일된 식을 주입한 location/document/window 위에서 평가한다. CDP
   * `Runtime.evaluate`는 넘겨받은 소스를 program으로 실행하고 completion value를
   * 돌려주므로, 이 harness도 같은 방식(직접 `eval`)으로 평가해야 실제 semantics를
   * 재현한다 — `return (...)`로 감싸면 단일 식만 받는 다른 계약이 되어버린다.
   */
  const evaluate = (
    expression: string,
    location: { readonly href: string },
    documentDouble: object,
    windowDouble: object = {},
  ): unknown =>
    (
      Function(
        "location",
        "document",
        "window",
        "expression",
        "return eval(expression);",
      ) as (
        location: { readonly href: string },
        document: object,
        window: object,
        expression: string,
      ) => unknown
    )(location, documentDouble, windowDouble, expression);

  const matchingDocument = {
    readyState: "complete",
    querySelector: () => ({}),
  };
  const blank = { href: "about:blank" };
  const navigated = { href: "http://127.0.0.1:3000/" };

  it("selector 조건을 JSON 이스케이프된 querySelector 식으로 컴파일한다", () => {
    expect(readyExpression({ kind: "selector", selector: "#app" })).toContain(
      'document.querySelector("#app") !== null',
    );
  });

  it("selector 안의 큰따옴표와 백슬래시도 안전하게 이스케이프한다", () => {
    const selector = 'div[data-x="y\\z"]';
    const expression = readyExpression({ kind: "selector", selector });
    expect(expression).toContain(
      `document.querySelector(${JSON.stringify(selector)}) !== null`,
    );
    expect(expression).toContain('\\"');
  });

  it("컴파일 결과는 navigation gate로 감싼 program 전체와 정확히 일치한다", () => {
    // toContain만으로는 gate 본문의 오타(about_blank 등)나 이중 wrapping을
    // 잡지 못하므로 전체 문자열을 그대로 고정한다.
    expect(
      readyExpression({
        kind: "expression",
        expression: "window.__ready === true",
      }),
    ).toBe(
      'if (location.href === "about:blank") { false } else { window.__ready === true\n}',
    );
    expect(readyExpression({ kind: "selector", selector: "#app" })).toBe(
      'if (location.href === "about:blank") { false } else { document.querySelector("#app") !== null\n}',
    );
  });

  it("navigate가 커밋된 문서에서는 selector 조건 결과를 그대로 반영한다", () => {
    expect(
      evaluate(
        readyExpression({ kind: "selector", selector: "body" }),
        navigated,
        matchingDocument,
      ),
    ).toBe(true);
    expect(
      evaluate(
        readyExpression({ kind: "selector", selector: "#app" }),
        navigated,
        {
          readyState: "complete",
          querySelector: () => null,
        },
      ),
    ).toBe(false);
  });

  it("about:blank 문서에서는 selector 조건이 참이어도 false로 평가된다", () => {
    expect(
      evaluate(
        readyExpression({ kind: "selector", selector: "body" }),
        blank,
        matchingDocument,
      ),
    ).toBe(false);
  });

  /**
   * `ReadyCondition.expression`은 공개 입력이고, gate가 생기기 전에는
   * `Runtime.evaluate`에 그대로 전달되어 program semantics로 실행됐다. 단일 식뿐
   * 아니라 세미콜론으로 끝나는 식, 여러 statement, 줄 주석으로 끝나는 식도 모두
   * 유효한 입력이므로 gate가 그 계약을 좁히면 안 된다.
   */
  const programForms: readonly {
    readonly label: string;
    readonly expression: string;
  }[] = [
    { label: "단일 식", expression: "window.__ready === true" },
    { label: "세미콜론으로 끝나는 식", expression: "window.__ready === true;" },
    {
      label: "var 선언이 있는 여러 statement",
      expression: "var ok = window.__ready; ok === true",
    },
    {
      label: "줄 주석으로 끝나는 식",
      expression: "window.__ready === true // 준비 확인",
    },
  ];

  it.each(programForms)(
    "$label도 커밋된 문서에서 원래 program semantics대로 평가된다",
    ({ expression }) => {
      const compiled = readyExpression({ kind: "expression", expression });
      expect(
        evaluate(compiled, navigated, matchingDocument, { __ready: true }),
      ).toBe(true);
      expect(
        evaluate(compiled, navigated, matchingDocument, { __ready: false }),
      ).toBe(false);
    },
  );

  it.each(programForms)(
    "$label도 about:blank에서는 평가되지 않고 false가 된다",
    ({ expression }) => {
      expect(
        evaluate(
          readyExpression({ kind: "expression", expression }),
          blank,
          matchingDocument,
          { __ready: true },
        ),
      ).toBe(false);
    },
  );
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

describe("navigateErrorText", () => {
  it("errorText가 비어 있지 않은 문자열이면 정리된 값을 돌려준다", () => {
    expect(
      navigateErrorText({
        frameId: "FRAME1",
        loaderId: "LOADER1",
        errorText: " net::ERR_CONNECTION_REFUSED ",
      }),
    ).toBe("net::ERR_CONNECTION_REFUSED");
  });

  it("errorText가 없는 정상 navigate 응답은 undefined다", () => {
    expect(
      navigateErrorText({ frameId: "FRAME1", loaderId: "LOADER1" }),
    ).toBeUndefined();
  });

  it("형식이 잘못되거나 비어 있는 errorText는 예외 없이 undefined로 취급한다", () => {
    expect(navigateErrorText({ errorText: "" })).toBeUndefined();
    expect(navigateErrorText({ errorText: "   " })).toBeUndefined();
    expect(navigateErrorText({ errorText: 42 })).toBeUndefined();
    expect(navigateErrorText(null)).toBeUndefined();
    expect(navigateErrorText(undefined)).toBeUndefined();
    expect(navigateErrorText("not an object")).toBeUndefined();
    expect(navigateErrorText([])).toBeUndefined();
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
