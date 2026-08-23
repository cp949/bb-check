// CheckResult를 안정된 한국어 텍스트 보고서로 렌더링한다. 이 파일은
// 판정하지 않는다 — findings/incomplete/ok는 이미 checkLibrary가 결정해
// 넘겨준 값을 그대로 문자열로 옮길 뿐이며, findings 순서도 checkLibrary가
// sortFindings로 이미 정렬해 돌려주므로 여기서 다시 정렬하지 않는다.

import type { CheckResult, Finding } from "@cp949/bb-core";

/** baseline을 "chrome 90, firefox 88" 형태의 한 줄 요약으로 만든다. */
const summarizeBaseline = (baseline: CheckResult["baseline"]): string =>
  Object.entries(baseline)
    .map(([browser, version]) => `${browser} ${version}`)
    .join(", ");

/** 판정 요약 줄("판정: ...")의 본문을 만든다. */
const summarizeVerdict = (result: CheckResult): string => {
  if (result.ok) return "통과";

  const parts: string[] = [];
  if (result.findings.length > 0)
    parts.push(`위반 ${result.findings.length}건`);
  if (result.incomplete) parts.push("일부 대상 미검사로 결과 불완전");
  return parts.length > 0 ? parts.join(", ") : "실패";
};

/** finding 하나를 "[axis] file:line name — detail (원본: ...)" 한 줄로 렌더링한다. */
const renderFinding = (finding: Finding): string => {
  const line = finding.line === null ? "-" : String(finding.line);
  const origin =
    finding.originalFile === undefined
      ? ""
      : ` (원본: ${finding.originalFile})`;
  return `[${finding.axis}] ${finding.file}:${line} ${finding.name} — ${finding.detail}${origin}`;
};

/**
 * library check 결과를 사람이 읽는 한국어 보고서 문자열로 렌더링한다.
 * 항상 단일 개행으로 끝난다. stack trace나 오류 원인은 다루지 않는다 —
 * 그건 cli/main.ts가 BbError를 stderr에 보고할 때의 몫이다.
 */
export function renderLibraryReport(result: CheckResult): string {
  const lines = [
    "bb-check library 검사 결과",
    `기준선: ${summarizeBaseline(result.baseline)}`,
    "",
    `판정: ${summarizeVerdict(result)}`,
  ];

  if (result.findings.length > 0) {
    lines.push("");
    for (const finding of result.findings) {
      lines.push(renderFinding(finding));
    }
  }

  return lines.join("\n") + "\n";
}
