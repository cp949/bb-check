export const normalizeSignalText = (value: unknown): string => {
  if (typeof value !== "string")
    throw new TypeError("signal text must be a string");
  const normalized = value.replace(/\r\n?/gu, "\n").trim();
  if (normalized === "") throw new TypeError("signal text must not be empty");
  return normalized;
};

/**
 * `script-parse` 신호 텍스트와 known-unsupported 선언이 공유하는 canonical
 * 표기. 수집 쪽은 위치를 신뢰할 수 없을 때 `"?"`를 넣는다 — 선언 쪽은 항상
 * 정수이므로 그런 신호는 어떤 선언과도 일치하지 않는다.
 */
export const scriptParsePatternText = (
  sourcePath: string,
  lineNumber: number | "?",
  columnNumber: number | "?",
): string =>
  `path=${sourcePath}; line=${String(lineNumber)}; column=${String(columnNumber)}`;
