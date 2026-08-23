import type { Finding, FindingAxis } from "./types.js";

/** 정렬 시 사용하는 axis 순서. 인덱스가 작을수록 앞에 온다. */
const AXIS_ORDER: readonly FindingAxis[] = [
  "syntax",
  "runtime-js",
  "dependency",
  "css",
];

const axisRank = (axis: FindingAxis): number => AXIS_ORDER.indexOf(axis);

/**
 * 문자열을 코드포인트 순으로 비교한다. `String.prototype.localeCompare`는
 * 로케일/ICU 빌드에 따라 결과가 갈려 출력이 환경마다 흔들릴 수 있어 쓰지
 * 않는다 — 이 비교자가 그 대신 쓰는 유일한 정답이다(sortFindings,
 * compat-scanner, dependency-closure가 모두 이 함수를 공유한다).
 */
export const compareCodePoint = (a: string, b: string): number => {
  if (a === b) return 0;
  return a < b ? -1 : 1;
};

/** line을 오름차순으로 비교하되 null은 숫자 line보다 뒤에 둔다. */
const compareLine = (a: number | null, b: number | null): number => {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
};

/**
 * finding 배열을 axis, file, line, name 순서로 정렬한 새 배열을 반환한다.
 * 입력 배열과 그 요소는 변경하지 않는다.
 */
export const sortFindings = (findings: readonly Finding[]): Finding[] =>
  [...findings].sort((a, b) => {
    const axisDiff = axisRank(a.axis) - axisRank(b.axis);
    if (axisDiff !== 0) return axisDiff;

    const fileDiff = compareCodePoint(a.file, b.file);
    if (fileDiff !== 0) return fileDiff;

    const lineDiff = compareLine(a.line, b.line);
    if (lineDiff !== 0) return lineDiff;

    return compareCodePoint(a.name, b.name);
  });
