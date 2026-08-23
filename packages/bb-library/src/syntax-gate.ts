// 배포 JavaScript가 baseline browser target이 지원하지 않는 문법을 쓰는
// 첫 위치를 esbuild 이중 변환으로 찾는다. 같은 source를 target: "esnext"
// (사실상 무변형 기준)와 baseline의 실제 syntaxTarget으로 각각 transform해
// 두 출력을 비교한다 — 그래도 다르면 baseline transform이 실제로 문법을
// 다시 썼다는 뜻이고, 그 지점이 baseline이 지원하지 않는 문법이 시작되는
// 위치다.
//
// esbuild가 입력 자체를 파싱하지 못하면(문법 오류) typed failure를
// "반환"한다(throw하지 않음) — 상위 orchestration(Task 8)이 여러 파일을
// 순회하며 실패한 파일 하나 때문에 전체를 중단하지 않고 BB_TARGET_PARSE
// finding으로 모을 수 있어야 하기 때문이다. "문법 발산 없음"과
// "parse 실패"는 kind로 구분되는 서로 다른 shape이라 상위에서 헷갈리지
// 않고 분기할 수 있다.

import { transform } from "esbuild";
import type { Loader, TransformFailure } from "esbuild";

const LOADER: Loader = "js";

/** esbuild transform()이 rejection으로 던지는 TransformFailure인지 확인한다. */
const isTransformFailure = (value: unknown): value is TransformFailure =>
  typeof value === "object" &&
  value !== null &&
  Array.isArray((value as { errors?: unknown }).errors);

/**
 * transform() 출력에서 sourceMappingURL 주석을 제거한다. 이 모듈이 실제로
 * 요청하는 sourcemap 옵션(외부 map 또는 없음)에서는 애초에 이 주석이
 * code에 섞이지 않지만, 옵션이 바뀌어도 두 출력의 비교가 sourcemap
 * 존재 여부 같은 의미 없는 차이로 어긋나지 않도록 방어적으로 제거한다.
 */
const stripSourceMappingComment = (code: string): string =>
  code.replace(/\n?\/\/[#@]\s*sourceMappingURL=[^\n]*/g, "");

/** 두 문자열이 처음으로 달라지는 index. 완전히 같으면 undefined. */
const firstDivergingIndex = (a: string, b: string): number | undefined => {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    if (a[i] !== b[i]) return i;
  }
  return a.length === b.length ? undefined : length;
};

/** code 문자열에서 index가 몇 번째 line(0-based)의 몇 번째 column(0-based)인지 센다. */
const positionOf = (
  code: string,
  index: number,
): { readonly line: number; readonly column: number } => {
  let line = 0;
  let lineStart = 0;
  for (let i = 0; i < index; i += 1) {
    if (code.charCodeAt(i) === 10 /* \n */) {
      line += 1;
      lineStart = i + 1;
    }
  }
  return { line, column: index - lineStart };
};

const BASE64_VLQ_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** 콤마로 구분된 mapping segment 하나에서 연속된 VLQ 정수들을 모두 읽는다. */
const decodeVlqFields = (segment: string): number[] => {
  const fields: number[] = [];
  let shift = 0;
  let value = 0;
  for (const char of segment) {
    const digit = BASE64_VLQ_CHARS.indexOf(char);
    if (digit === -1) {
      throw new Error(`잘못된 source map VLQ 문자입니다: ${char}`);
    }
    value += (digit & 31) << shift;
    if (digit & 32) {
      shift += 5;
      continue;
    }
    fields.push(value & 1 ? -(value >> 1) : value >> 1);
    shift = 0;
    value = 0;
  }
  return fields;
};

interface MappedSegment {
  readonly generatedColumn: number;
  readonly originalLine: number;
  readonly originalColumn: number;
}

/**
 * source map의 mappings 필드를 생성 line별 segment 배열로 decode한다.
 * 이 모듈은 esbuild가 방금 생성한, 단일 source만 갖는 map만 다루므로
 * source index 자체는 추적하지 않는다(원본이 하나뿐이라 항상 0).
 *
 * generatedColumn만 매 생성 line마다 0으로 리셋되고, originalLine/
 * originalColumn은 mappings 전체에 걸쳐 누적되는 delta다(source map v3
 * 스펙). 두 값을 line 콜백 안에서 선언하면 매 line마다 0으로 잘못
 * 리셋되어 두 번째 생성 line부터 원본 위치가 어긋난다.
 */
const decodeMappings = (mappings: string): MappedSegment[][] => {
  let originalLine = 0;
  let originalColumn = 0;
  return mappings.split(";").map((lineText) => {
    let generatedColumn = 0;
    const segments: MappedSegment[] = [];
    if (lineText.length === 0) return segments;
    for (const segmentText of lineText.split(",")) {
      if (segmentText.length === 0) continue;
      const fields = decodeVlqFields(segmentText);
      generatedColumn += fields[0] ?? 0;
      if (fields.length < 4) continue; // 원본 위치 정보가 없는 segment
      originalLine += fields[2] ?? 0;
      originalColumn += fields[3] ?? 0;
      segments.push({ generatedColumn, originalLine, originalColumn });
    }
    return segments;
  });
};

/**
 * baseline transform이 만든 source map(mapJson)에서, 생성된 (line, column)
 * 위치에 대응하는 원본 source(=이 모듈에 전달된 source 인자) 안의 위치를
 * 찾는다. 매핑을 찾지 못하면 undefined.
 */
const locateInSource = (
  mapJson: string,
  generatedLine: number,
  generatedColumn: number,
): { readonly line: number; readonly column: number } | undefined => {
  const parsed = JSON.parse(mapJson) as { mappings?: unknown };
  if (typeof parsed.mappings !== "string") return undefined;

  const segments = decodeMappings(parsed.mappings)[generatedLine];
  if (!segments || segments.length === 0) return undefined;

  let chosen: MappedSegment | undefined;
  for (const segment of segments) {
    if (segment.generatedColumn > generatedColumn) break;
    chosen = segment;
  }
  chosen ??= segments[0];
  if (!chosen) return undefined;
  return { line: chosen.originalLine + 1, column: chosen.originalColumn };
};

/** 발산을 찾았을 때의 결과. line/column은 전달받은 source 인자 기준 1-based/0-based 위치다. */
export interface SyntaxDivergenceLocation {
  readonly kind: "divergence";
  readonly line: number;
  readonly column: number;
}

/** baseline target으로 transform해도 다시 써야 할 문법이 없었다는 결과. */
export interface SyntaxNoDivergence {
  readonly kind: "none";
}

/**
 * esbuild가 source 자체를 파싱하지 못했다는 typed failure. "발산 없음"과는
 * 다른 shape이라 상위에서 안전하게 구분할 수 있다.
 */
export interface SyntaxTargetParseFailure {
  readonly kind: "parse-failure";
  readonly message: string;
  readonly line: number | null;
  readonly cause: unknown;
}

export type SyntaxDivergenceResult =
  SyntaxDivergenceLocation | SyntaxNoDivergence | SyntaxTargetParseFailure;

/**
 * 같은 source를 target: "esnext"(무변형 기준)와 baseline의 실제
 * syntaxTarget으로 각각 transform해 비교하고, baseline transform이 실제로
 * 문법을 다시 쓴 첫 위치를 찾는다.
 *
 * @param source 검사할 배포 JavaScript 원문(파일 경로가 아니라 텍스트).
 * @param syntaxTarget esbuild가 이해하는 target(예: "chrome80",
 *   browserslist-to-esbuild가 돌려주는 ["chrome80", "safari14"] 같은 배열).
 */
export async function findFirstSyntaxDivergence(
  source: string,
  syntaxTarget: string | readonly string[],
): Promise<SyntaxDivergenceResult> {
  // Array.isArray는 `readonly string[] | string` union에서 배열 쪽을
  // 깔끔하게 좁혀주지 못한다(TS의 오래된 한계) — typeof로 직접 분기한다.
  const target: string | string[] =
    typeof syntaxTarget === "string" ? syntaxTarget : Array.from(syntaxTarget);

  let unconstrainedCode: string;
  try {
    unconstrainedCode = (
      await transform(source, { target: "esnext", loader: LOADER })
    ).code;
  } catch (cause) {
    if (!isTransformFailure(cause)) throw cause;
    const first = cause.errors[0];
    return {
      kind: "parse-failure",
      message: first?.text ?? cause.message,
      line: first?.location?.line ?? null,
      cause,
    };
  }

  let baselineCode: string;
  let baselineMap: string;
  try {
    const result = await transform(source, {
      target,
      loader: LOADER,
      sourcemap: "external",
    });
    baselineCode = result.code;
    baselineMap = result.map;
  } catch (cause) {
    if (!isTransformFailure(cause)) throw cause;
    // esnext로는 파싱됐지만 baseline target으로는 아예 표현할 수 없는
    // 경우다(예: 오래된 target에 대한 top-level await). 입력 자체의 파싱
    // 실패가 아니라 가장 극단적인 형태의 문법 발산이므로, esbuild가 알려준
    // 실패 위치를 그대로 발산 위치로 보고한다. 위치가 없는 실패는 "발산"의
    // 근거(위치)가 없으므로 parse-failure로 낮춰 보고한다 — esnext 분기와
    // 마찬가지로 이 함수는 esbuild가 원인인 실패에 대해 절대 throw하지
    // 않는다(상위 orchestration이 항상 typed 결과만 받도록 하는 불변식).
    const first = cause.errors[0];
    if (first?.location) {
      return {
        kind: "divergence",
        line: first.location.line,
        column: first.location.column,
      };
    }
    return {
      kind: "parse-failure",
      message: first?.text ?? cause.message,
      line: null,
      cause,
    };
  }

  const generatedCode = stripSourceMappingComment(unconstrainedCode);
  const constrainedCode = stripSourceMappingComment(baselineCode);
  if (generatedCode === constrainedCode) {
    return { kind: "none" };
  }

  const diffIndex = firstDivergingIndex(generatedCode, constrainedCode) ?? 0;
  const outputPosition = positionOf(constrainedCode, diffIndex);
  const originalPosition = locateInSource(
    baselineMap,
    outputPosition.line,
    outputPosition.column,
  );

  return {
    kind: "divergence",
    line: originalPosition?.line ?? outputPosition.line + 1,
    column: originalPosition?.column ?? outputPosition.column,
  };
}
