// bb-check.config.mjs를 탐색하고 동적 import한 뒤 normalizeConfig로
// 검증·동결한다. 보안 검증(sparse array, getter, 상속 property 거절)과
// 조밀 복사는 config 파일 위치를 아는 이 loader가 아니라 core의
// normalizeConfig가 전담한다 — 이 파일은 "어느 파일을 찾아 어떻게
// import하는가"와 "--dir이 config의 projectDir을 어떻게 재정의하는가"만
// 책임진다.

import { stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  normalizeConfig,
  BbError,
  type NormalizedBbCheckConfig,
} from "@cp949/bb-core";

const CONFIG_FILE_NAME = "bb-check.config.mjs";

export interface LoadConfigOptions {
  /** config 자동 탐색과 --config/--dir 상대 경로 해석의 기준이 되는 cwd. */
  readonly cwd: string;
  /** --config 값. 있으면 자동 탐색을 생략하고 이 경로만 사용한다. */
  readonly config?: string;
  /** --dir 값. 있으면 config의 library.projectDir보다 우선한다. */
  readonly dir?: string;
}

/** path가 실제 존재하는 파일인지 확인한다. 디렉터리나 없는 경로는 false. */
const isExistingFile = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
};

const notFound = (detail: string): never => {
  throw new BbError("BB_CONFIG_NOT_FOUND", `[BB_CONFIG_NOT_FOUND] ${detail}`);
};

/**
 * cwd에서 시작해 상위 디렉터리로 올라가며 bb-check.config.mjs를 찾는다.
 * package.json이 있는 디렉터리까지만 검색한다(그 디렉터리 자신은 포함하되
 * 더 위로는 올라가지 않는다) — 모노레포 등에서 상위의 무관한 config를
 * 잘못 줍는 것을 막는다.
 */
const findConfigFile = async (cwd: string): Promise<string | undefined> => {
  let dir = resolve(cwd);
  while (true) {
    const candidate = join(dir, CONFIG_FILE_NAME);
    if (await isExistingFile(candidate)) return candidate;

    const isPackageBoundary = await isExistingFile(join(dir, "package.json"));
    if (isPackageBoundary) return undefined;

    const parent = dirname(dir);
    if (parent === dir) return undefined; // 파일시스템 루트: 더 올라갈 곳이 없다.
    dir = parent;
  }
};

/**
 * config 파일을 찾아 동적 import하고 default export를 돌려준다.
 * cache-busting query string은 붙이지 않는다 — CLI는 프로세스당 한 번만
 * config를 읽으므로 캐시 무효화가 필요 없고, 붙이면 동일 URL을 여러 번
 * import하는 다른 소비자(예: 테스트)의 캐시 재사용을 방해할 뿐이다.
 */
const importConfigDefault = async (configFile: string): Promise<unknown> => {
  const moduleUrl = pathToFileURL(configFile).href;
  let mod: unknown;
  try {
    mod = await import(moduleUrl);
  } catch (cause) {
    throw new BbError(
      "BB_CONFIG_INVALID",
      `[BB_CONFIG_INVALID] ${configFile}: config 파일을 불러올 수 없습니다.`,
      { cause },
    );
  }
  return (mod as { default?: unknown }).default;
};

/**
 * config 파일을 찾아 로드하고 검증된 NormalizedBbCheckConfig를 반환한다.
 *
 * `--config`가 있으면 그 경로만(자동 탐색 없이) 사용한다. 없으면 cwd부터
 * 가장 가까운 package.json 디렉터리까지만 `bb-check.config.mjs`를 찾는다.
 * `--dir`이 있으면 config의 `library.projectDir`보다 우선하며, 두 값 모두
 * config 파일이 위치한 디렉터리를 기준으로 절대 경로로 정규화한다(cwd
 * 기준이 아니다).
 *
 * @throws {BbError} BB_CONFIG_NOT_FOUND — config 파일을 찾지 못함.
 * @throws {BbError} BB_CONFIG_INVALID — config 파일을 불러오지 못했거나
 *   default export가 normalizeConfig의 계약을 만족하지 않음.
 */
export async function loadConfig(
  options: LoadConfigOptions,
): Promise<NormalizedBbCheckConfig> {
  // path.resolve는 두 번째 인자가 이미 절대 경로면 첫 번째 인자(cwd)를
  // 무시하고 그 절대 경로를 그대로 쓰므로, 절대/상대 분기를 따로 두지 않는다.
  const configFile = options.config
    ? resolve(options.cwd, options.config)
    : await findConfigFile(options.cwd);

  if (configFile === undefined) {
    throw notFound(
      `${options.cwd}에서 가장 가까운 package 경계까지 ${CONFIG_FILE_NAME}를 찾지 못했습니다.`,
    );
  }
  if (!(await isExistingFile(configFile))) {
    throw notFound(`${configFile} 파일이 없습니다.`);
  }

  const configDir = dirname(configFile);
  const raw = await importConfigDefault(configFile);
  const normalized = normalizeConfig(raw, configDir);

  if (options.dir === undefined) return normalized;

  const projectDir = resolve(configDir, options.dir);
  return Object.freeze({
    library: Object.freeze({
      projectDir,
      // allow는 normalizeConfig가 이미 검증·동결한 배열/항목이다.
      // --dir은 대상 위치만 재정의하므로 그대로 재사용한다.
      allow: normalized.library.allow,
    }),
  });
}
