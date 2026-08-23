import type { Finding, FindingAxis } from "./types.js";

/** 정렬 시 사용하는 axis 순서. 인덱스가 작을수록 앞에 온다. */
const AXIS_ORDER: readonly FindingAxis[] = [
  "syntax",
  "runtime-js",
  "dependency",
  "css",
];

const axisRank = (axis: FindingAxis): number => AXIS_ORDER.indexOf(axis);

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

    const fileDiff = a.file.localeCompare(b.file);
    if (fileDiff !== 0) return fileDiff;

    const lineDiff = compareLine(a.line, b.line);
    if (lineDiff !== 0) return lineDiff;

    return a.name.localeCompare(b.name);
  });
