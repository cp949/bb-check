// 대상 프로젝트의 package.json#exports를 순회해 실제로 배포되는
// JavaScript(.js/.mjs/.cjs) 진입점의 절대 경로를 모은다. string, array,
// condition object(예: {import, require}), subpath object(예: {".": ...,
// "./sub": ...}) 형태를 모두 지원한다.

import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { BbError } from "@cp949/bb-core";

const JS_EXTENSIONS = [".js", ".mjs", ".cjs"];

const isJsFile = (path: string): boolean =>
  JS_EXTENSIONS.some((ext) => path.endsWith(ext));

/** value가 own key를 가진 순수 object인지 확인한다(배열·문자열·null 제외). */
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * exports 값(string | array | object)을 재귀적으로 순회하며 leaf 문자열을
 * 전부 모은다. condition 이름(import/require/default 등)과 subpath 이름
 * ("./" 접두 key)은 구분하지 않고 값을 동일하게 순회한다 — 둘 다 leaf가
 * 결국 상대 경로 문자열이라는 점은 같다. "types" key는 타입 선언 전용이라
 * 순회하지 않는다(값이 .js/.mjs/.cjs가 아니므로 결과적으로는 아래
 * 확장자 필터링만으로도 제외되지만, 의도를 코드에서 명확히 하기 위해
 * 명시적으로도 건너뛴다).
 */
const collectLeaves = (value: unknown, acc: string[]): void => {
  if (typeof value === "string") {
    acc.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectLeaves(item, acc);
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, sub] of Object.entries(value)) {
      if (key === "types") continue;
      collectLeaves(sub, acc);
    }
  }
};

/** candidate가 root 디렉터리 내부(자기 자신 포함)로 정규화되는지 확인한다. */
const isWithinRoot = (root: string, candidate: string): boolean =>
  candidate === root || candidate.startsWith(root + sep);

const isRealFile = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
};

export type InvalidDistTargetReason = "absolute" | "outside-root" | "missing";

export interface InvalidDistTarget {
  readonly target: string;
  readonly reason: InvalidDistTargetReason;
}

export interface DistEntryResolution {
  readonly entries: readonly string[];
  readonly invalidTargets: readonly InvalidDistTarget[];
}

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
    throw new BbError(
      "BB_CONFIG_INVALID",
      `[BB_CONFIG_INVALID] ${file}이(가) 올바른 JSON이 아닙니다.`,
      { cause },
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new BbError(
      "BB_CONFIG_INVALID",
      `[BB_CONFIG_INVALID] ${file}은(는) object여야 합니다.`,
    );
  }
  return parsed as Record<string, unknown>;
};

/**
 * 대상 프로젝트의 package.json#exports를 순회해 실제로 존재하는 배포
 * JavaScript(.js/.mjs/.cjs) 진입점의 절대 경로와 판정할 수 없는
 * JavaScript target을 각각 정렬·중복 제거해 반환한다.
 *
 * JS가 아닌 산출물(types 선언, CSS, JSON, source map 등)은 제외하지만,
 * 절대 경로·package root 탈출·missing JS target은 invalidTargets에 보존한다.
 *
 * JavaScript leaf 자체가 하나도 없으면 BB_INPUT_NOT_FOUND. JavaScript
 * leaf가 있지만 전부 판정 불가면 빈 entries와 invalidTargets를 반환한다.
 *
 * @param projectDir package.json이 있는 대상 프로젝트 디렉터리(절대 경로 권장).
 * @throws {BbError} BB_INPUT_NOT_FOUND — package.json을 찾을 수 없거나,
 *   package.json#exports에 JavaScript leaf 자체가 하나도 없음.
 * @throws {BbError} BB_CONFIG_INVALID — package.json이 JSON이 아니거나 object가 아님.
 */
export async function resolveDistEntries(
  projectDir: string,
): Promise<DistEntryResolution> {
  const pkg = await readPackageJson(projectDir);
  const root = resolve(projectDir);

  const leaves: string[] = [];
  if (Object.hasOwn(pkg, "exports")) {
    collectLeaves(pkg.exports, leaves);
  }

  const resolved = new Set<string>();
  const invalidTargets = new Map<string, InvalidDistTarget>();
  const addInvalidTarget = (
    target: string,
    reason: InvalidDistTargetReason,
  ): void => {
    invalidTargets.set(`${target}\0${reason}`, { target, reason });
  };

  for (const leaf of leaves) {
    if (!isJsFile(leaf)) continue;
    if (isAbsolute(leaf)) {
      addInvalidTarget(leaf, "absolute");
      continue;
    }

    const candidate = resolve(root, leaf);
    if (!isWithinRoot(root, candidate)) {
      addInvalidTarget(leaf, "outside-root");
      continue;
    }
    if (!(await isRealFile(candidate))) {
      addInvalidTarget(leaf, "missing");
      continue;
    }

    resolved.add(candidate);
  }

  if (resolved.size === 0 && invalidTargets.size === 0) {
    throw new BbError(
      "BB_INPUT_NOT_FOUND",
      `[BB_INPUT_NOT_FOUND] ${projectDir}의 package.json#exports에서 실제 ` +
        `JavaScript 진입점을 찾지 못했습니다.`,
    );
  }

  return {
    entries: [...resolved].sort(),
    invalidTargets: [...invalidTargets.values()].sort((a, b) => {
      if (a.target !== b.target) return a.target < b.target ? -1 : 1;
      return a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0;
    }),
  };
}
