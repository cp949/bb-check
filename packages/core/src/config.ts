// bb-check 설정(config) 검증과 깊은 동결.
// 사용자가 작성한 bb-check.config.mjs 등에서 로드된 신뢰할 수 없는 값을 받아
// 검증된, 깊게 동결된, 방어적으로 복사된 내부 config(NormalizedBbCheckConfig)를
// 만든다. 이 모듈이 소비자 config 파일이 건네줄 수 있는 모든 것에 대한
// 보안/견고성 경계다.

import { resolve } from "node:path";
import { BbError } from "./errors.js";
import type { NormalizedBbCheckConfig } from "./types.js";
import type { LibraryAllowance } from "./types.js";

/**
 * BB_CONFIG_INVALID 오류를 던진다. 반환 타입이 never이므로 호출 이후
 * 코드에서 TypeScript가 실패 분기를 제외하고 값을 좁힐 수 있다.
 */
const invalid = (path: string, reason: string): never => {
  throw new BbError(
    "BB_CONFIG_INVALID",
    `[BB_CONFIG_INVALID] ${path}: ${reason}`,
  );
};

/**
 * 배열이 아닌 실제 plain object인지 확인한다. Object prototype 또는 null
 * prototype만 허용하며, property를 읽지 않고 prototype만 확인하므로 hostile
 * getter를 실행하지 않는다.
 */
const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/**
 * own property를 세 가지로 분류해 읽는다: 전혀 없음(absent), own이지만
 * accessor(getter/setter)임(accessor), own data property임(value).
 * accessor는 절대 호출하지 않는다 — `Object.getOwnPropertyDescriptor`가
 * 돌려준 descriptor에 `value` key가 있는지만으로 판단하며, getter를 실행해
 * 결과를 관찰하지 않는다. object의 문자열 key와 배열의 숫자 index 모두에
 * 사용한다.
 *
 * "absent"와 "accessor"를 구분하는 이유: 필수 필드는 둘 다 거절해야 하지만
 * (`readOwnDataProperty` 참고), optional 필드(`library.allow`)는 "정말
 * 없으면" 기본값으로 대체해도 되지만 "own이지만 accessor라 읽을 수 없으면"
 * 형태가 잘못된 입력이므로 거절해야 한다. 이 둘을 뭉뚱그리면 accessor로
 * 정의된 `allow`가 조용히 빈 배열로 취급되는 결함이 생긴다.
 */
const readOwnProperty = (
  obj: object,
  key: PropertyKey,
):
  | { kind: "absent" }
  | { kind: "accessor" }
  | { kind: "value"; value: unknown } => {
  const descriptor = Object.getOwnPropertyDescriptor(obj, key);
  if (descriptor === undefined) return { kind: "absent" };
  if (!("value" in descriptor)) return { kind: "accessor" };
  return { kind: "value", value: descriptor.value };
};

/**
 * own data property만 읽는다. getter/setter accessor는 절대 호출하지 않고,
 * 상속된 property나 존재하지 않는 property와 마찬가지로 present:false로
 * 취급한다(필수 필드는 absent와 accessor를 동일하게 거절하면 되므로 이
 * 단순화가 안전하다). object의 문자열 key와 배열의 숫자 index 모두에
 * 사용한다.
 */
const readOwnDataProperty = (
  obj: object,
  key: PropertyKey,
): { present: boolean; value: unknown } => {
  const read = readOwnProperty(obj, key);
  if (read.kind !== "value") return { present: false, value: undefined };
  return { present: true, value: read.value };
};

/**
 * own non-empty string property를 읽는다. 없거나 문자열이 아니면 거절한다.
 * 공백만으로 이루어진 문자열(예: `"   "`)도 빈 문자열과 동일하게
 * 거절한다 — trim 후 길이만 검사하며 반환값 자체는 trim하지 않는다(원본
 * 문자열을 그대로 돌려준다). 이 검사를 통과하지 못한 값은 여기서 항상
 * BB_CONFIG_INVALID로 걸러지므로, 이후 단계(예: compat-scanner의 allow
 * 매칭)가 공백뿐인 file/name/reason을 볼 일이 없다.
 */
const readOwnNonEmptyString = (
  obj: object,
  key: string,
  path: string,
): string => {
  const { present, value } = readOwnDataProperty(obj, key);
  if (!present) throw invalid(path, "own 속성이 없습니다");
  if (typeof value !== "string") throw invalid(path, "문자열이어야 합니다");
  if (value.length === 0) throw invalid(path, "빈 문자열일 수 없습니다");
  if (value.trim().length === 0)
    throw invalid(path, "공백만으로 이루어진 문자열일 수 없습니다");
  return value;
};

/**
 * own dense array property를 읽는다. property가 전혀 없거나(또는 own이지만
 * 명시적으로 undefined면) allow는 optional 필드이므로 빈 배열로 취급한다.
 * 반면 property가 own이지만 accessor(getter)로 정의된 경우는 "값이 없는
 * 것"이 아니라 "형태가 잘못된 입력"이므로 거절한다 — 필수 필드에서
 * accessor를 거절하는 것과 동일한 취급이다. getter는 이 판단 과정에서
 * 절대 호출하지 않는다.
 *
 * sparse 배열(own index가 없는 인덱스가 있는 배열)과 getter로 정의된
 * 항목은 거절한다. 각 index를 `Object.hasOwn`으로 확인한 뒤 값은
 * `Object.getOwnPropertyDescriptor`의 data property로만 읽으므로,
 * bracket 접근(`value[i]`)을 전혀 쓰지 않아 hostile getter를 절대
 * 실행하지 않는다.
 */
const readOwnDenseArray = (
  obj: object,
  key: string,
  path: string,
): unknown[] => {
  const field = readOwnProperty(obj, key);
  if (field.kind === "absent") return [];
  if (field.kind === "accessor") {
    throw invalid(path, "접근자(getter) 필드는 허용되지 않습니다");
  }

  const { value } = field;
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalid(path, "배열이어야 합니다");

  const items: unknown[] = [];
  for (let i = 0; i < value.length; i++) {
    if (!Object.hasOwn(value, i)) {
      throw invalid(`${path}[${i}]`, "own 인덱스가 없는 sparse 배열입니다");
    }
    const element = readOwnDataProperty(value, i);
    if (!element.present) {
      throw invalid(`${path}[${i}]`, "접근자(getter) 항목은 허용되지 않습니다");
    }
    items.push(element.value);
  }
  return items;
};

/** allow 배열의 단일 항목을 검증해 새 동결 객체(LibraryAllowance)로 만든다. */
const normalizeAllowance = (item: unknown, path: string): LibraryAllowance => {
  if (!isPlainObject(item)) throw invalid(path, "object여야 합니다");

  const file = readOwnNonEmptyString(item, "file", `${path}.file`);
  const name = readOwnNonEmptyString(item, "name", `${path}.name`);
  const reason = readOwnNonEmptyString(item, "reason", `${path}.reason`);

  return Object.freeze({ file, name, reason });
};

/**
 * 신뢰할 수 없는 외부 config 값을 검증하고, 깊게 동결된 새 내부 config로
 * 변환한다. 입력을 절대 mutate하지 않으며, 반환값은 입력과 완전히 분리된
 * 새 객체 그래프다(root, library, allow 배열, 각 allowance 항목 모두).
 *
 * 검증 순서:
 * 1. root와 library가 plain object인지 확인한다.
 * 2. library.projectDir이 own non-empty string인지 확인한다.
 * 3. library.allow가 dense array인지 확인한다.
 * 4. 각 allowance의 file/name/reason이 own non-empty string인지 확인한다.
 * 5. `file + "\0" + name` 중복을 거절한다.
 * 6. configDir 기준 절대 projectDir을 만든다.
 * 7. 새 객체만 생성하고 배열·항목·root를 깊게 동결한다.
 *
 * @param input 사용자 config 파일에서 로드된 검증되지 않은 값.
 * @param configDir config 파일이 위치한 디렉터리. projectDir 상대 경로의 기준이 된다.
 */
export function normalizeConfig(
  input: unknown,
  configDir: string,
): NormalizedBbCheckConfig {
  if (!isPlainObject(input))
    throw invalid("config", "config는 object여야 합니다");

  const libraryField = readOwnDataProperty(input, "library");
  if (!libraryField.present) throw invalid("library", "own 속성이 없습니다");

  const library = libraryField.value;
  if (!isPlainObject(library)) throw invalid("library", "object여야 합니다");

  const projectDirRaw = readOwnNonEmptyString(
    library,
    "projectDir",
    "library.projectDir",
  );
  const allowRaw = readOwnDenseArray(library, "allow", "library.allow");

  const seen = new Set<string>();
  const allow = allowRaw.map((item, index) => {
    const itemPath = `library.allow[${index}]`;
    const allowance = normalizeAllowance(item, itemPath);

    const key = allowance.file + "\0" + allowance.name;
    if (seen.has(key)) {
      throw invalid(
        itemPath,
        `중복된 allow 항목입니다 (file=${allowance.file}, name=${allowance.name})`,
      );
    }
    seen.add(key);

    return allowance;
  });

  const projectDir = resolve(configDir, projectDirRaw);

  return Object.freeze({
    library: Object.freeze({
      projectDir,
      allow: Object.freeze(allow),
    }),
  });
}
