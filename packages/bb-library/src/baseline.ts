// 대상 프로젝트의 package.json#browserslist로부터 브라우저별 최소 버전
// 기준선(BrowserBaseline)을 파생한다. 정본은 package.json#browserslist
// 하나뿐이며(design §8), 이 파일이 그 값을 읽고 해석하는 유일한 경로다.
//
// browserslist(...)는 항상 명시적 queries + env: "production" option으로만
// 호출한다 — queries를 우리가 직접 package.json에서 뽑아 넘기므로
// browserslist가 BROWSERSLIST 환경변수나 설정 파일을 자동 탐색하는 경로
// 자체를 타지 않는다. 그럼에도 BROWSERSLIST/BROWSERSLIST_ENV 환경변수가
// 판정을 조용히 재정의할 수 있는 경우가 남아 있어(아래 참고) 호출 전에
// 명시적으로 거절한다.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import browserslist from "browserslist";
import { BbError } from "@cp949/bb-core";
import type { BrowserBaseline } from "@cp949/bb-core";

/**
 * 판정을 조용히 재정의할 수 있는 browserslist 환경변수. 하나라도 설정되어
 * 있으면 config 오류로 거절한다.
 *
 * NODE_ENV가 이 목록에 없는 것은 누락이 아니라 검증을 거친 의도적 결정이다
 * (아래 test/baseline.test.ts의 "NODE_ENV가 달라도 결과가 바뀌지 않는다"
 * 테스트가 이 결정을 실제로 검증한다). 이유:
 *
 * NODE_ENV는 여기 포함하지 않는다: browserslist@4.28.8의 node.js:pickEnv는
 * `typeof opts.env === "string"`이면 그 값을 BROWSERSLIST_ENV/NODE_ENV보다
 * 우선한다(node_modules/browserslist/node.js 확인). 이 파일은 항상
 * `env: "production"`을 명시로 넘기므로 NODE_ENV는 구조적으로 결과에 영향을
 * 줄 수 없다 — "설정돼 있어도 판정이 바뀌지 않는" 상태이지 "설정돼 있으면
 * 판정을 재정의하는" BROWSERSLIST/BROWSERSLIST_ENV와는 성격이 다르다.
 * 반대로 NODE_ENV까지 거절 대상에 넣으면 NODE_ENV=test로 실행되는
 * 테스트 러너(vitest 포함)와 NODE_ENV=production으로 실행되는 대부분의
 * 실제 CI 자체가 이 도구를 쓸 수 없게 되는 심각한 사용성 결함이 된다.
 *
 * BROWSERSLIST는 다르다: browserslist@4.28.8의 node.js:loadConfig는
 * `process.env.BROWSERSLIST`가 있으면 opts.path와 무관하게 무조건 그 값을
 * 쓴다. 다만 우리는 queries를 직접 넘겨 loadConfig 자체를 우회하므로 이
 * 값이 실제로 결과에 섞여 들어오지는 않는다 — 그래도 "환경변수가 설정된
 * 채로 실행하면 조용히 다른 결과가 나올 수 있는 위험한 실행 환경"이라는
 * 신호이므로 개발자 스스로 브라우저 목록을 명시했을 가능성이 높은
 * BROWSERSLIST_ENV와 함께 방어적으로 거절한다.
 */
const FORBIDDEN_ENV_VARS = ["BROWSERSLIST", "BROWSERSLIST_ENV"] as const;

const configInvalid = (message: string, cause?: unknown): never => {
  throw new BbError(
    "BB_CONFIG_INVALID",
    `[BB_CONFIG_INVALID] ${message}`,
    cause === undefined ? undefined : { cause },
  );
};

const assertNoForbiddenEnvOverride = (): void => {
  for (const name of FORBIDDEN_ENV_VARS) {
    const value = process.env[name];
    if (value !== undefined && value !== "") {
      throw configInvalid(
        `환경변수 ${name}가 설정되어 있어 browserslist 판정을 조용히 재정의할 ` +
          `수 있습니다. 이 환경변수 없이 다시 실행하세요.`,
      );
    }
  }
};

const readPackageJson = async (
  projectDir: string,
): Promise<Record<string, unknown>> => {
  const file = join(projectDir, "package.json");
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (cause) {
    throw new BbError(
      "BB_INPUT_NOT_FOUND",
      `[BB_INPUT_NOT_FOUND] ${file}을(를) 찾을 수 없습니다.`,
      { cause },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw configInvalid(`${file}이(가) 올바른 JSON이 아닙니다.`, cause);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw configInvalid(`${file}은(는) object여야 합니다.`);
  }
  return parsed as Record<string, unknown>;
};

/** browserslist가 이해하는 query 형태(비어있지 않은 문자열 배열)인지 확인한다. */
const isQueryList = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every((item) => typeof item === "string" && item.length > 0);

/**
 * package.json#browserslist 필드에서 production 환경에 쓸 query를 뽑는다.
 * 문자열, 문자열 배열, env 이름으로 나뉜 object(예: {production: [...]}) 세
 * 형태를 모두 지원한다. 필드가 없거나 형태를 해석할 수 없으면
 * BB_CONFIG_INVALID.
 */
const extractBrowserslistQueries = (
  pkg: Record<string, unknown>,
  projectDir: string,
): string | string[] => {
  if (!Object.hasOwn(pkg, "browserslist")) {
    throw configInvalid(
      `${projectDir}의 package.json에 browserslist 필드가 없습니다.`,
    );
  }

  const raw = pkg.browserslist;
  if (typeof raw === "string" && raw.length > 0) return raw;
  if (isQueryList(raw)) return raw;

  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    const envs = raw as Record<string, unknown>;
    const section = Object.hasOwn(envs, "production")
      ? envs.production
      : envs.defaults;
    if (isQueryList(section)) return section;
  }

  throw configInvalid(
    `${projectDir}의 package.json#browserslist 형태를 해석할 수 없습니다.`,
  );
};

interface ParsedVersion {
  readonly major: number;
  readonly minor: number;
  /** "-"로 이어진 범위(예: "16.0-16.1")의 하한. 최종 baseline 값으로 쓴다. */
  readonly raw: string;
}

/** "16.0-16.1" 같은 결합 버전은 하한을, 숫자로 시작하지 않는 버전(Safari TP 등)은 undefined를 돌려준다. */
const parseVersion = (version: string): ParsedVersion | undefined => {
  const lowerBound = version.split("-")[0] ?? version;
  const match = /^(\d+)(?:\.(\d+))?/.exec(lowerBound);
  if (!match?.[1]) return undefined;
  const major = Number(match[1]);
  const minor = match[2] === undefined ? 0 : Number(match[2]);
  return { major, minor, raw: lowerBound };
};

const isOlder = (a: ParsedVersion, b: ParsedVersion): boolean =>
  a.major !== b.major ? a.major < b.major : a.minor < b.minor;

/**
 * browserslist(caniuse-lite) 에이전트 이름 → @mdn/browser-compat-data
 * `browsers` 키 변환표.
 *
 * compat-bcd.ts의 buildCompatIndex는 BrowserBaseline의 키를 BCD의
 * browsers 키로 그대로 조회한다(`Object.hasOwn(support, browser)`).
 * 데스크톱 에이전트(chrome/edge/firefox/ie/opera/safari)는 이미 두 쪽
 * 이름이 같지만, 모바일 에이전트 중 다수는 이름 규칙이 갈린다 — 이 표를
 * 거치지 않으면 그 브라우저의 모든 API 체크가 BCD 조회 실패로 조용히
 * 건너뛰어진다(오탐이 아니라 미탐: 실제로 검사해야 할 브라우저가 검사
 * 대상에서 조용히 빠진다).
 *
 * 이 저장소에 설치된 실물 browserslist/caniuse-lite와
 * @mdn/browser-compat-data를 직접 조회해 확인한 전체 목록:
 *   - caniuse-lite 전체 agents(19개): and_chr, and_ff, and_qq, and_uc,
 *     android, baidu, bb, chrome, edge, firefox, ie, ie_mob, ios_saf,
 *     kaios, op_mini, op_mob, opera, safari, samsung
 *   - @mdn/browser-compat-data의 browsers 키(17개): bun, chrome,
 *     chrome_android, deno, edge, firefox, firefox_android, ie, nodejs,
 *     oculus, opera, opera_android, safari, safari_ios,
 *     samsunginternet_android, webview_android, webview_ios
 *
 * 대조 결과:
 *   - chrome/edge/firefox/ie/opera/safari: 이미 이름이 같다 — 이 표에
 *     넣지 않고 원래 이름 그대로 통과시킨다.
 *   - and_chr→chrome_android, and_ff→firefox_android, ios_saf→safari_ios,
 *     samsung→samsunginternet_android, op_mob→opera_android: 같은
 *     브라우저를 가리키지만 이름만 다르다 — 아래 표에서 변환한다.
 *   - android→webview_android: browserslist 자신의
 *     node_modules/browserslist/index.js:bbmTransform()이 BCD 기반
 *     `supports` 질의에 쓰는 1차 매핑 표에 `webview_android: 'android'`로
 *     명시한다(추측이 아니라 browserslist 소스 코드에서 직접 확인).
 *     caniuse-lite 데이터도 이를 뒷받침한다 — index.js는
 *     ANDROID_EVERGREEN_FIRST('37') 이후의 "android" 버전을 chrome
 *     버전에서 파생시켜 채운다(최신 Android WebView와 Chrome for Android가
 *     같은 Chromium 빌드를 공유하기 때문에 일관성이 있다). 아래 표에서
 *     변환한다.
 *   - and_qq, and_uc, baidu, bb, ie_mob, kaios, op_mini: BCD의
 *     browsers에 대응 키가 전혀 없다 — 이 표에 넣지 않는다. 원래 이름을
 *     baseline에 남겨 buildCompatIndex/checkLibrary가 runtime-js 판정 불가
 *     finding과 incomplete로 보고하게 한다.
 */
const BCD_BROWSER_NAME_ALIASES: Readonly<Record<string, string>> = {
  and_chr: "chrome_android",
  and_ff: "firefox_android",
  ios_saf: "safari_ios",
  samsung: "samsunginternet_android",
  op_mob: "opera_android",
  android: "webview_android",
};

/**
 * browserslist 에이전트 이름을 알려진 경우에만 BCD 이름으로 바꾼다.
 * 대응 관계를 모르는 이름(데스크톱 에이전트, 또는 BCD에 대응 데이터가
 * 없는 에이전트)은 원래 이름 그대로 돌려준다.
 */
const toBcdBrowserName = (browserslistName: string): string =>
  BCD_BROWSER_NAME_ALIASES[browserslistName] ?? browserslistName;

/**
 * browserslist(...)가 돌려준 "이름 버전" 목록에서 브라우저별 최소
 * major/minor 버전을 뽑는다. 버전을 숫자로 해석할 수 없는 항목(예: Safari
 * Technology Preview의 "TP")은 최소값 비교 대상이 될 수 없으므로
 * 건너뛴다.
 *
 * 에이전트 이름은 minByBrowser에 쌓기 전에 toBcdBrowserName으로 BCD
 * 명명 규칙으로 변환한다 — 그래야 이론상 서로 다른 browserslist 이름이
 * 같은 BCD 키로 모이는 경우(현재 매핑표에서는 실제로 발생하지 않지만)에도
 * 아래 isOlder 비교가 자동으로 더 보수적인(오래된) 버전을 채택한다.
 */
const deriveMinimumVersions = (
  matched: readonly string[],
): Record<string, string> => {
  const minByBrowser = new Map<string, ParsedVersion>();
  for (const entry of matched) {
    const lastSpace = entry.lastIndexOf(" ");
    if (lastSpace === -1) continue;
    const name = toBcdBrowserName(entry.slice(0, lastSpace));
    const parsed = parseVersion(entry.slice(lastSpace + 1));
    if (!parsed) continue;

    const current = minByBrowser.get(name);
    if (!current || isOlder(parsed, current)) {
      minByBrowser.set(name, parsed);
    }
  }

  const result: Record<string, string> = {};
  for (const [name, version] of minByBrowser) {
    result[name] = version.raw;
  }
  return result;
};

/**
 * 대상 프로젝트의 package.json#browserslist로부터 브라우저별 최소 버전
 * 기준선을 만든다. 항상 production env로 해석하며, BROWSERSLIST /
 * BROWSERSLIST_ENV 환경변수가 설정되어 있으면 판정을 조용히 재정의하지
 * 않도록 즉시 거절한다.
 *
 * @param projectDir package.json이 있는 대상 프로젝트 디렉터리(절대 경로 권장).
 * @throws {BbError} BB_INPUT_NOT_FOUND — package.json을 찾을 수 없음.
 * @throws {BbError} BB_CONFIG_INVALID — package.json이 JSON이 아니거나,
 *   browserslist 필드가 없거나 해석할 수 없거나, 금지된 환경변수가 설정됨.
 * @throws {BbError} BB_BASELINE_EMPTY — 질의가 선택한 브라우저가 없음.
 */
export async function loadLibraryBaseline(
  projectDir: string,
): Promise<BrowserBaseline> {
  assertNoForbiddenEnvOverride();

  const pkg = await readPackageJson(projectDir);
  const queries = extractBrowserslistQueries(pkg, projectDir);

  let matched: string[];
  try {
    matched = browserslist(queries, { path: projectDir, env: "production" });
  } catch (cause) {
    throw configInvalid(
      `${projectDir}의 package.json#browserslist 질의를 해석할 수 없습니다.`,
      cause,
    );
  }

  const baseline = deriveMinimumVersions(matched);
  if (Object.keys(baseline).length === 0) {
    throw new BbError(
      "BB_BASELINE_EMPTY",
      `[BB_BASELINE_EMPTY] ${projectDir}의 browserslist 질의가 선택한 브라우저가 없습니다.`,
    );
  }

  return Object.freeze(baseline);
}
