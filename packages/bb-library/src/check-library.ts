// Task 4~7이 만든 baseline 파생, dist 진입점 수집, 문법/런타임/의존성
// scanner, source map 귀속을 한 번의 라이브러리 검사로 엮는 orchestration.
// 이 파일 자신은 어떤 판정 로직도 새로 만들지 않는다 — 각 scanner 호출과
// 결과 결합, 오류 격리, source map 조회(파일 I/O)만 담당한다.

import { readFile } from "node:fs/promises";
import { dirname, posix, relative, resolve, sep } from "node:path";
import browserslistToEsbuild from "browserslist-to-esbuild";
import {
  sortFindings,
  type BrowserBaseline,
  type CheckResult,
  type Finding,
  type FindingAxis,
  type LibraryAllowance,
} from "@cp949/bb-core";
import { loadLibraryBaseline } from "./baseline.js";
import { resolveDistEntries } from "./dist-entries.js";
import { findFirstSyntaxDivergence } from "./syntax-gate.js";
import { createOriginLookup } from "./source-origin.js";
import { createCompatScanner } from "./compat-scanner.js";
import { createDependencyClosureScanner } from "./dependency-closure.js";

export interface CheckLibraryOptions {
  readonly projectDir: string;
  readonly allow?: readonly LibraryAllowance[];
}

/**
 * 한 파일의 위치를 원본 소스로 되짚는 함수. source-origin.ts의 OriginLookupSuccess#originOf와
 * 동일한 shape이며, source map이 없거나 조회할 수 없는 경우 이 함수 자체가 undefined다.
 */
type OriginOf = (line: number, column?: number) => string | undefined;

/**
 * baseline.ts가 @mdn/browser-compat-data 조회를 위해 browserslist 원본
 * 에이전트 이름을 BCD `browsers` 이름으로 바꾼 것(예: and_chr ->
 * chrome_android)의 역방향 표. browserslist-to-esbuild는 내부적으로
 * browserslist()를 다시 호출하므로 BCD 이름이 아니라 browserslist 원본
 * 이름만 인식한다 — baseline.ts의 BCD_BROWSER_NAME_ALIASES와 정확히
 * 대응하는 6개 항목을 여기서 되돌린다. baseline.ts는 이 표를 export하지
 * 않으므로(비공개 구현 세부사항) 복사해 유지한다.
 */
const BROWSERSLIST_AGENT_NAME_BY_BCD_NAME: Readonly<Record<string, string>> = {
  chrome_android: "and_chr",
  firefox_android: "and_ff",
  safari_ios: "ios_saf",
  samsunginternet_android: "samsung",
  opera_android: "op_mob",
  webview_android: "android",
};

/**
 * BrowserBaseline(브라우저 이름 -> 최소 버전)을 esbuild가 이해하는
 * syntaxTarget 배열로 바꾼다.
 *
 * browserslist-to-esbuild(2.1.1)는 자체적으로 browserslist()를 호출해
 * config를 재해석하므로, 이미 해석이 끝난 정확한 버전 하나를 그대로
 * 넘기면(예: "ios_saf 14.0") caniuse-lite가 그 정확한 버전을 별도
 * entry로 갖고 있지 않을 때 "Unknown version"으로 던질 수 있다(실측
 * 확인됨: "op_mob 60", "android 90" 등). 대신 `>=` 범위 질의로 넘기면
 * caniuse-lite에 있는 모든 상위 버전이 매칭되고, browserslist-to-esbuild의
 * reduce 로직이 그중 가장 오래된 버전을 택한다(실측 확인됨) — 그러면서도
 * baseline이 이미 표현하는 "이 버전부터는 확실히 지원" 의미는 그대로
 * 보존된다.
 */
const toSyntaxTarget = (baseline: BrowserBaseline): string[] => {
  const queries = Object.entries(baseline).map(([name, version]) => {
    const browserslistName = BROWSERSLIST_AGENT_NAME_BY_BCD_NAME[name] ?? name;
    return `${browserslistName} >= ${version}`;
  });
  return browserslistToEsbuild(queries);
};

/** 절대 경로를 projectDir 기준 POSIX 상대 경로로 바꾼다(보고용 file 값). */
const toReportPath = (root: string, absolutePath: string): string =>
  relative(root, absolutePath).split(sep).join("/");

const buildFinding = (
  axis: FindingAxis,
  file: string,
  line: number | null,
  name: string,
  detail: string,
  originalFile?: string,
): Finding =>
  originalFile === undefined
    ? { axis, file, line, name, detail }
    : { axis, file, line, name, detail, originalFile };

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** //# sourceMappingURL=... 주석에서 URL 값만 뽑는다. 여러 개면 마지막 것을 쓴다. */
const SOURCE_MAPPING_URL_PATTERN = /\/\/[#@]\s*sourceMappingURL=(\S+)/g;
const lastSourceMappingUrl = (source: string): string | undefined => {
  let found: string | undefined;
  for (const match of source.matchAll(SOURCE_MAPPING_URL_PATTERN)) {
    found = match[1];
  }
  return found;
};

/** data: URL의 payload를 mapText로 해석한다. base64가 아니면 percent-encoding으로 본다. */
const decodeDataUrl = (url: string): string | undefined => {
  const commaIndex = url.indexOf(",");
  if (commaIndex === -1) return undefined;
  const meta = url.slice("data:".length, commaIndex);
  const payload = url.slice(commaIndex + 1);
  if (meta.includes(";base64")) {
    return Buffer.from(payload, "base64").toString("utf8");
  }
  try {
    return decodeURIComponent(payload);
  } catch {
    return payload;
  }
};

interface OriginResolution {
  /** source map을 못 찾았거나(주석 없음, 외부 파일 없음) 필요 없으면 undefined. */
  readonly originOf: OriginOf | undefined;
  /** source map은 찾았지만 해석할 수 없었던 경우의 finding(BB_TARGET_PARSE). */
  readonly parseFailureFinding: Finding | undefined;
}

/**
 * dist 파일의 sourceMappingURL 주석을 찾아 원본 위치 조회 함수를 만든다.
 * inline data URL은 여기서 직접 base64/percent-decoding하고, 상대 경로는
 * 같은 디렉터리 기준으로 디스크에서 읽는다 — source-origin.ts는 파일 I/O를
 * 하지 않으므로(설계상 의도) 이 orchestration이 그 책임을 진다.
 * 외부 map 파일이 없는 것은 오류가 아니라 조용히 건너뛴다.
 */
async function resolveOriginLookup(
  entryPath: string,
  relFile: string,
  source: string,
): Promise<OriginResolution> {
  const url = lastSourceMappingUrl(source);
  if (url === undefined)
    return { originOf: undefined, parseFailureFinding: undefined };

  let mapText: string;
  if (url.startsWith("data:")) {
    const decoded = decodeDataUrl(url);
    if (decoded === undefined)
      return { originOf: undefined, parseFailureFinding: undefined };
    mapText = decoded;
  } else {
    const mapPath = resolve(dirname(entryPath), url);
    try {
      mapText = await readFile(mapPath, "utf8");
    } catch {
      // 외부 map 파일이 없거나 읽을 수 없음: 조용히 건너뛴다(에러 아님).
      return { originOf: undefined, parseFailureFinding: undefined };
    }
  }

  const mapDir = posix.dirname(relFile);
  const lookup = createOriginLookup(mapText, { mapDir });
  if (lookup.kind === "parse-failure") {
    return {
      originOf: undefined,
      parseFailureFinding: buildFinding(
        "syntax",
        relFile,
        null,
        "BB_TARGET_PARSE",
        `source map을 해석할 수 없습니다: ${lookup.message}`,
      ),
    };
  }
  return { originOf: lookup.originOf, parseFailureFinding: undefined };
}

/**
 * 대상 라이브러리의 배포 JavaScript 전체를 baseline과 대조해 검사한다.
 *
 * package.json#browserslist에서 기준선을 파생하고, package.json#exports에서
 * 실제 배포 진입점을 모은 뒤, 각 진입점마다 문법(syntax) / 런타임 API
 * (runtime-js) / dependency closure(dependency) 세 축을 모두 검사한다.
 * source map이 있으면(외부 파일 또는 inline data URL) 위치를 원본 소스로
 * 되짚는다.
 *
 * 개별 파일의 읽기·파싱 실패는 그 파일의 나머지 검사와 다른 파일 전체를
 * 막지 않는다 — `BB_TARGET_PARSE`(또는 읽기 실패의 경우 `BB_TARGET_READ`)
 * finding으로 남기고 `incomplete: true`로 표시한 뒤 계속한다. baseline이
 * esbuild가 표현할 수 있는 문법 target으로 전혀 변환되지 않는 브라우저
 * 조합이면(예: 모바일 전용 브라우저만으로 구성된 baseline) 문법 축 전체를
 * 건너뛰고 `BB_SYNTAX_TARGET_UNAVAILABLE` finding과 `incomplete: true`로
 * 표시한다 — runtime-js/dependency는 이 경우에도 정상 진행한다.
 *
 * @param options.projectDir package.json이 있는 대상 프로젝트 디렉터리(절대 경로 권장).
 * @param options.allow 이 검사에서 면제할 런타임 API 사용 목록. 호출 중 이
 *   배열이나 그 원소를 변경해도 이미 시작된 검사 결과에는 영향을 주지 않는다.
 * @throws {BbError} BB_INPUT_NOT_FOUND / BB_CONFIG_INVALID / BB_BASELINE_EMPTY —
 *   baseline 파생, dist 진입점 수집, dependency manifest 적재 중 하나라도
 *   실패하면(대상 프로젝트 자체가 검사 불가능하다는 뜻이므로 개별 파일
 *   오류와 달리 전체 호출이 실패한다).
 */
export async function checkLibrary(
  options: CheckLibraryOptions,
): Promise<CheckResult> {
  const { projectDir } = options;
  const root = resolve(projectDir);
  // 방어적 복사: 호출자가 검사 도중 allow 배열이나 원소를 변경해도 이미
  // 시작된 실행에는 영향이 없어야 한다.
  const allow: LibraryAllowance[] = (options.allow ?? []).map((entry) => ({
    ...entry,
  }));

  const baseline = await loadLibraryBaseline(projectDir);
  const entries = await resolveDistEntries(projectDir);
  const dependencyScanner = await createDependencyClosureScanner(projectDir);
  const compatScanner = createCompatScanner({ baseline, allowed: allow });
  const syntaxTarget = toSyntaxTarget(baseline);

  const findings: Finding[] = [];
  let incomplete = false;

  // esbuild가 표현할 수 있는 target이 하나도 없는 baseline이 있다(예:
  // ChromeAndroid/FirefoxAndroid/OperaMobile/Samsung처럼 esbuild의
  // SUPPORTED_ESBUILD_TARGETS(chrome/edge/firefox/ios/node/safari/
  // opera/ie)에 매핑되지 않는 모바일 브라우저만으로 구성된 조합 — 실측
  // 확인됨). esbuild의 target: []은 target: "esnext"와 동일하게 동작해
  // 어떤 문법도 다시 쓰지 않으므로, syntaxTarget이 비어 있는데도 그냥
  // 진행하면 findFirstSyntaxDivergence가 모든 파일에서 "발산 없음"을
  // 돌려줘 문법 축이 조용히 "위반 없음"으로 보인다 — 실제로는 검사
  // 자체를 못 한 것이다. design §9("실패 대상을 결과에 반드시 포함해
  // 불완전한 검사가 성공으로 보이지 않게 한다")를 어기므로, 이 경우
  // 문법 축 전체를 건너뛰고 그 사실을 finding으로 남긴 뒤 incomplete로
  // 표시한다. runtime-js/dependency는 esbuild target과 무관하므로 계속
  // 정상 진행한다.
  const syntaxTargetUnavailable = syntaxTarget.length === 0;
  if (syntaxTargetUnavailable) {
    const baselineSummary = Object.entries(baseline)
      .map(([browser, version]) => `${browser} ${version}`)
      .join(", ");
    findings.push(
      buildFinding(
        "syntax",
        "*",
        null,
        "BB_SYNTAX_TARGET_UNAVAILABLE",
        `이 baseline(${baselineSummary})이 선택한 브라우저 조합에는 esbuild가 ` +
          `표현할 수 있는 문법 target이 없어(esbuild는 chrome/edge/firefox/ios/` +
          `node/safari/opera/ie만 target으로 지원) 문법(syntax) 검사를 건너뛰었` +
          `습니다. runtime-js/dependency 검사는 정상적으로 수행되었습니다.`,
      ),
    );
    incomplete = true;
  }

  for (const entryPath of entries) {
    const relFile = toReportPath(root, entryPath);

    let source: string;
    try {
      source = await readFile(entryPath, "utf8");
    } catch (cause) {
      findings.push(
        buildFinding(
          "syntax",
          relFile,
          null,
          "BB_TARGET_READ",
          `${relFile}을(를) 읽을 수 없습니다: ${errorMessage(cause)}`,
        ),
      );
      incomplete = true;
      continue;
    }

    const { originOf, parseFailureFinding } = await resolveOriginLookup(
      entryPath,
      relFile,
      source,
    );
    if (parseFailureFinding !== undefined) {
      findings.push(parseFailureFinding);
      incomplete = true;
    }

    // --- syntax ---
    if (!syntaxTargetUnavailable) {
      const syntaxResult = await findFirstSyntaxDivergence(
        source,
        syntaxTarget,
      );
      if (syntaxResult.kind === "parse-failure") {
        findings.push(
          buildFinding(
            "syntax",
            relFile,
            syntaxResult.line,
            "BB_TARGET_PARSE",
            syntaxResult.message,
          ),
        );
        incomplete = true;
      } else if (syntaxResult.kind === "divergence") {
        const origin = originOf?.(syntaxResult.line, syntaxResult.column);
        findings.push(
          buildFinding(
            "syntax",
            relFile,
            syntaxResult.line,
            "syntax-divergence",
            `baseline이 지원하지 않는 문법입니다(column ${syntaxResult.column}, target: ${syntaxTarget.join(", ")}).`,
            origin,
          ),
        );
      }
    }

    // --- runtime-js ---
    try {
      const compatFindings = compatScanner(source, relFile);
      for (const finding of compatFindings) {
        const origin =
          finding.line === null ? undefined : originOf?.(finding.line);
        findings.push(
          buildFinding(
            "runtime-js",
            finding.file,
            finding.line,
            finding.name,
            finding.detail,
            origin,
          ),
        );
      }
    } catch (cause) {
      findings.push(
        buildFinding(
          "runtime-js",
          relFile,
          null,
          "BB_TARGET_PARSE",
          errorMessage(cause),
        ),
      );
      incomplete = true;
    }

    // --- dependency ---
    try {
      const dependencyFindings = dependencyScanner.scan(source, relFile);
      for (const finding of dependencyFindings) {
        const origin = originOf?.(finding.line);
        findings.push(
          buildFinding(
            "dependency",
            finding.file,
            finding.line,
            finding.name,
            finding.detail,
            origin,
          ),
        );
      }
    } catch (cause) {
      findings.push(
        buildFinding(
          "dependency",
          relFile,
          null,
          "BB_TARGET_PARSE",
          errorMessage(cause),
        ),
      );
      incomplete = true;
    }
  }

  // 사용되지 않은 allowance: 이번 실행의 어떤 scan() 호출에서도 매칭이
  // 한 번도 없었던 항목이다. Map을 순회한다 — 중복된 allow 항목(같은
  // file/name 조합)은 createCompatScanner 내부에서 이미 하나의 key로
  // 모이므로, 여기서도 자연히 한 번만 보고된다.
  for (const [key, count] of compatScanner.allowanceMatchCounts) {
    if (count > 0) continue;
    const separatorIndex = key.indexOf("\0");
    const file = key.slice(0, separatorIndex);
    const name = key.slice(separatorIndex + 1);
    findings.push(
      buildFinding(
        "runtime-js",
        file,
        null,
        "unused-allowance",
        `허용 목록 항목이 한 번도 매칭되지 않았습니다(file: ${file}, name: ${name}).`,
      ),
    );
  }

  const sorted = sortFindings(findings);
  return {
    baseline,
    findings: sorted,
    incomplete,
    ok: sorted.length === 0 && !incomplete,
  };
}
