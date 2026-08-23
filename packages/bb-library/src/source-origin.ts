// 배포 JavaScript의 생성 위치를 source map을 통해 원본 파일로 되짚는다.
//
// 이 모듈은 "이미 확보된 source map JSON 텍스트"만 다루는 순수 함수다.
// 외부 .map 파일을 디스크에서 읽는 일과, JS 소스에 박힌 inline data URL
// source map을 찾아 해석하는 일(=이 모듈을 fetch처럼 쓰지 않고 입력 JS
// 자체에서 직접 해석해야 하는 일)은 대상 dist 파일의 경로/내용을 쥔 상위
// orchestration(Task 8)의 책임이다. 이 모듈은 디스크에 접근하지 않는다.

import { posix } from "node:path";

export interface OriginLookupOptions {
  /**
   * source map의 sources 항목을 이 디렉터리 기준으로 정규화한다. 실제로
   * 존재하는 디렉터리일 필요는 없다(문자열 결합만 한다).
   */
  readonly mapDir: string;
}

export interface OriginLookupSuccess {
  readonly kind: "ok";
  /**
   * 생성된 JS의 1-based line과(선택적으로) 0-based column을 원본 소스 파일
   * 경로로 바꾼다. 해당 위치에 대응하는 매핑이 없으면 undefined.
   */
  readonly originOf: (line: number, column?: number) => string | undefined;
}

/**
 * mapText가 malformed일 때의 typed failure. "성공"과는 kind로 구분되는
 * 다른 shape이라 상위가 이 결과를 `BB_TARGET_PARSE`로 조용히 흘리지 않고
 * 안전하게 분기할 수 있다.
 */
export interface OriginLookupFailure {
  readonly kind: "parse-failure";
  readonly message: string;
  readonly cause?: unknown;
}

export type OriginLookupResult = OriginLookupSuccess | OriginLookupFailure;

const toPosixPath = (value: string): string => value.replace(/\\/g, "/");

/** POSIX 절대 경로("/...")나 Windows drive 절대 경로("C:/...")인지 확인한다. */
const ABSOLUTE_PATH_PATTERN = /^(\/|[A-Za-z]:\/)/;
const ABSOLUTE_URL_PATTERN = /^[A-Za-z][A-Za-z\d+.-]*:\/\//;

/** POSIX 정규화가 UNC 경로의 선행 double slash를 축약하지 못하게 한다. */
const normalizePosixPath = (value: string): string => {
  const normalized = posix.normalize(value);
  return value.startsWith("//") && !normalized.startsWith("//")
    ? `/${normalized}`
    : normalized;
};

/**
 * ECMA-426 DecodeSourceMapSources의 sourceUrlPrefix를 sourceRoot에서
 * 만든다. sourceRoot가 이미 "/"로 끝나면 그대로 쓰고, 아니면 "/"만
 * 덧붙인다 — sourceRoot를 파일 경로로 보고 마지막 segment를 잘라내는
 * 것이 아니다(그러면 sourceRoot 전체가 디렉터리 이름 취급되어 유실된다).
 */
const sourceUrlPrefix = (sourceRoot: string): string => {
  const posixRoot = toPosixPath(sourceRoot);
  return posixRoot.endsWith("/") ? posixRoot : `${posixRoot}/`;
};

/**
 * source map의 sources 항목 하나를 mapDir 기준으로 정규화한다. 이미
 * 절대 경로면 그대로 둔다. mapDir 밖으로 벗어나는 상대 경로("../..")도
 * 거부하지 않고 그대로 보존한다 — 이 값은 필터링용이 아니라 사람이 읽을
 * 보고용 경로 문자열이다.
 */
const resolveSourcePath = (mapDir: string, sourcePath: string): string => {
  const posixSource = toPosixPath(sourcePath);
  if (ABSOLUTE_URL_PATTERN.test(posixSource)) {
    return new URL(posixSource).href;
  }
  if (ABSOLUTE_PATH_PATTERN.test(posixSource)) {
    return normalizePosixPath(posixSource);
  }
  const posixMapDir = toPosixPath(mapDir).replace(/\/+$/, "");
  return normalizePosixPath(`${posixMapDir}/${posixSource}`);
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
  readonly sourceIndex: number;
  readonly originalLine: number;
  readonly originalColumn: number;
}

/** source map의 mappings 필드를 생성 line별 segment 배열로 decode한다. */
const decodeMappings = (mappings: string): MappedSegment[][] => {
  let sourceIndex = 0;
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
      sourceIndex += fields[1] ?? 0;
      originalLine += fields[2] ?? 0;
      originalColumn += fields[3] ?? 0;
      segments.push({
        generatedColumn,
        sourceIndex,
        originalLine,
        originalColumn,
      });
    }
    return segments;
  });
};

const parseFailure = (
  message: string,
  cause?: unknown,
): OriginLookupFailure => ({ kind: "parse-failure", message, cause });

/**
 * source map JSON 텍스트로부터 생성 위치 -> 원본 파일 경로 조회 함수를
 * 만든다. mapText가 올바른 JSON이 아니거나 sources/mappings를 해석할 수
 * 없으면 typed parse-failure를 반환한다(예외를 던지지 않음) — 상위
 * orchestration이 이를 `BB_TARGET_PARSE`로 모아 결과를 불완전하게 만들 수
 * 있어야 하기 때문이다.
 *
 * @param mapText source map의 JSON 텍스트. 외부 .map 파일을 읽었든 inline
 *   data URL을 해석했든, 호출자가 이미 확보한 텍스트를 그대로 넘긴다.
 * @param options.mapDir sources 항목을 정규화할 기준 디렉터리.
 */
export function createOriginLookup(
  mapText: string,
  options: OriginLookupOptions,
): OriginLookupResult {
  let raw: unknown;
  try {
    raw = JSON.parse(mapText);
  } catch (cause) {
    return parseFailure("source map이 올바른 JSON이 아닙니다.", cause);
  }

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return parseFailure("source map은 object여야 합니다.");
  }
  const map = raw as Record<string, unknown>;

  if (
    !Array.isArray(map.sources) ||
    !map.sources.every((source) => typeof source === "string")
  ) {
    return parseFailure("source map#sources가 문자열 배열이 아닙니다.");
  }
  if (typeof map.mappings !== "string") {
    return parseFailure("source map#mappings가 문자열이 아닙니다.");
  }

  let sourceRoot: string | undefined;
  if (Object.hasOwn(map, "sourceRoot")) {
    if (typeof map.sourceRoot !== "string") {
      return parseFailure("source map#sourceRoot가 문자열이 아닙니다.");
    }
    sourceRoot = map.sourceRoot;
  }

  let sources: string[];
  try {
    sources = (map.sources as string[]).map((source) =>
      resolveSourcePath(
        options.mapDir,
        sourceRoot === undefined
          ? source
          : `${sourceUrlPrefix(sourceRoot)}${source}`,
      ),
    );
  } catch (cause) {
    return parseFailure("source map#sources를 해석할 수 없습니다.", cause);
  }

  let segmentsByLine: MappedSegment[][];
  try {
    segmentsByLine = decodeMappings(map.mappings);
  } catch (cause) {
    return parseFailure("source map#mappings를 해석할 수 없습니다.", cause);
  }

  const originOf = (line: number, column = 0): string | undefined => {
    const segments = segmentsByLine[line - 1];
    if (!segments || segments.length === 0) return undefined;

    let chosen: MappedSegment | undefined;
    for (const segment of segments) {
      if (segment.generatedColumn > column) break;
      chosen = segment;
    }
    chosen ??= segments[0];
    return chosen ? sources[chosen.sourceIndex] : undefined;
  };

  return { kind: "ok", originOf };
}
