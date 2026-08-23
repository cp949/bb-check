// 배포 JavaScript가 import/require하는 각 specifier를 package manifest
// 기준으로 분류하고, consumer의 설치/런타임에서 깨질 수 있는 것을 finding
// 으로 보고한다.
//
// Node 내장 모듈, 로컬 파일 경로(상대 경로·절대 경로·UNC), 패키지 자기
// 참조(exports 기반 self-reference), peerDependency는 전부 허용이다
// (finding 없음). 반대로 다음은 finding이다:
//
//   - optionalDependencies에만 선언된 패키지: optional-dependency-leak.
//     설치가 보장되지 않는 외부 참조다.
//   - dependencies에 선언된 패키지: dependency-leak. "선언은 했다"가
//     아니라 "번들 안에 있어야 할 게 외부 참조로 남았다"가 이 도구가
//     보는 문제다 — 배포 JavaScript는 브라우저가 직접 로드하므로,
//     정식으로 선언된 의존성이라도 번들링되지 않은 채 bare specifier로
//     남아 있으면 브라우저에서 그대로 깨진다.
//   - 어떤 dependency 필드에도 없는 패키지: undeclared-runtime. 위 두
//     경우보다 더 근본적인 문제(설치 시점부터 존재를 보장할 수 없음)다.
//   - 정적으로 특정할 수 없는 specifier(변수, 계산된 표현식): 하드
//     위반이 아니라 정보성 finding인 computed-specifier. 사람이 직접
//     확인해야 한다는 신호일 뿐, 위 세 kind와 같은 확신으로 보고하지
//     않는다.
//
// 정적 import/export...from, literal dynamic import(), CJS require()를
// acorn AST로 찾는다. require()는 `require`라는 이름의 식별자 호출만
// 인식한다 — UMD 팩토리 함수의 매개변수로 가려진 require(예:
// `function(require, exports, module) {...}`)는 별도로 걸러내지 않는다
// (이 스캐너가 상대하는 배포 산출물은 이미 하나의 module/script이지
// UMD wrapper가 아니라고 가정한다).

import { readFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { join, posix, win32 } from "node:path";
import { parse } from "acorn";
import type { AnyNode, Program } from "acorn";
import { BbError, compareCodePoint } from "@cp949/bb-core";

/** 하드 위반 세 종류. computed-specifier는 정보성이라 따로 구분한다. */
type LeakKind =
  "dependency-leak" | "optional-dependency-leak" | "undeclared-runtime";

export type DependencyFindingKind = LeakKind | "computed-specifier";

export interface DependencyFinding {
  readonly file: string;
  /** 1-based line 번호. acorn node.start 기준으로 이 모듈이 직접 계산하므로 항상 존재한다. */
  readonly line: number;
  /** 원본 specifier 문자열. computed-specifier는 소스 상의 원문 표현식 텍스트다. */
  readonly name: string;
  readonly kind: DependencyFindingKind;
  readonly detail: string;
}

export interface DependencyClosureScanner {
  scan(source: string, file: string): readonly DependencyFinding[];
}

// ---- package manifest 적재 ------------------------------------------------

interface ManifestInfo {
  readonly selfName: string | undefined;
  readonly hasExports: boolean;
  readonly dependencies: ReadonlySet<string>;
  readonly peerDependencies: ReadonlySet<string>;
  readonly optionalDependencies: ReadonlySet<string>;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** package.json의 dependency 계열 필드에서 패키지 이름(key)만 모은다. */
const dependencyKeys = (
  pkg: Record<string, unknown>,
  field: string,
): Set<string> => {
  const value = pkg[field];
  return isPlainObject(value) ? new Set(Object.keys(value)) : new Set();
};

async function loadManifest(projectDir: string): Promise<ManifestInfo> {
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
  if (!isPlainObject(parsed)) {
    throw new BbError(
      "BB_CONFIG_INVALID",
      `[BB_CONFIG_INVALID] ${file}은(는) object여야 합니다.`,
    );
  }

  return {
    selfName: typeof parsed.name === "string" ? parsed.name : undefined,
    // self-reference는 Node.js 해석 규칙상 exports 필드가 있어야 성립한다.
    hasExports: Object.hasOwn(parsed, "exports"),
    dependencies: dependencyKeys(parsed, "dependencies"),
    peerDependencies: dependencyKeys(parsed, "peerDependencies"),
    optionalDependencies: dependencyKeys(parsed, "optionalDependencies"),
  };
}

// ---- specifier 분류 --------------------------------------------------------

/** "./x", "../x", ".\\x", "..\\x" 같은 상대 경로 접두. */
const RELATIVE_PREFIX_PATTERN = /^\.\.?[\\/]/;

/**
 * Windows 드라이브 문자 접두("C:..."). 절대 경로(C:\chunk.cjs)든
 * drive-relative(C:chunk.cjs, 백슬래시 없음)든 전부 로컬 경로로 본다.
 * 어떤 npm 패키지 이름도 콜론을 포함할 수 없다(예약된 "node:" 접두만
 * 예외이고, "node:"는 네 글자라 이 한 글자+콜론 패턴과 겹치지 않는다) —
 * 그래서 이 패턴은 실제 패키지 이름을 로컬 경로로 오인하지 않는다.
 */
const WINDOWS_DRIVE_PATTERN = /^[A-Za-z]:/;

/**
 * specifier가 로컬 파일 경로(상대 경로, POSIX/Windows 절대 경로, UNC)인지
 * 판정한다. 호스트 OS의 기본 path 모듈에 기대지 않고 posix/win32 양쪽을
 * 명시적으로 검사한다 — 이 스캐너를 어느 플랫폼에서 실행해도(Linux CI가
 * Windows 전용 dist 산출물을 검사하는 경우 등) 같은 결과를 내야 한다.
 */
const isLocalPathSpecifier = (specifier: string): boolean =>
  RELATIVE_PREFIX_PATTERN.test(specifier) ||
  posix.isAbsolute(specifier) ||
  win32.isAbsolute(specifier) ||
  WINDOWS_DRIVE_PATTERN.test(specifier);

/**
 * bare specifier에서 패키지 이름만 뽑는다.
 * "@scope/name/sub/path" -> "@scope/name", "name/sub/path" -> "name".
 */
const extractPackageName = (specifier: string): string => {
  const segments = specifier.split("/");
  if (specifier.startsWith("@") && segments.length >= 2) {
    return `${segments[0]}/${segments[1]}`;
  }
  return segments[0] ?? specifier;
};

/**
 * specifier를 분류 우선순위대로 판정한다.
 *
 *   1. builtin / local path / self-reference / peerDependency -> 허용(undefined)
 *   2. optionalDependencies에만 있음 -> optional-dependency-leak
 *   3. dependencies에 있음 -> dependency-leak
 *   4. 어디에도 없음 -> undeclared-runtime
 *
 * computed(정적으로 알 수 없는) specifier는 이 함수에 들어오지 않는다 —
 * 호출자가 AST 단계에서 literal 여부를 먼저 가른다.
 */
function classifySpecifier(
  specifier: string,
  manifest: ManifestInfo,
): LeakKind | undefined {
  if (isBuiltin(specifier)) return undefined;
  if (isLocalPathSpecifier(specifier)) return undefined;

  const packageName = extractPackageName(specifier);

  if (
    manifest.hasExports &&
    manifest.selfName !== undefined &&
    packageName === manifest.selfName
  ) {
    return undefined;
  }
  if (manifest.peerDependencies.has(packageName)) return undefined;
  if (manifest.optionalDependencies.has(packageName))
    return "optional-dependency-leak";
  if (manifest.dependencies.has(packageName)) return "dependency-leak";
  return "undeclared-runtime";
}

const describeLeak = (kind: LeakKind, specifier: string): string => {
  switch (kind) {
    case "dependency-leak":
      return (
        `"${specifier}"는(은) dependencies에 선언되어 있지만 번들에 ` +
        `외부 참조로 남아 있습니다. 배포 산출물에는 번들링되어야 합니다.`
      );
    case "optional-dependency-leak":
      return (
        `"${specifier}"는(은) optionalDependencies에만 선언되어 있어 ` +
        `설치를 보장할 수 없는 외부 참조입니다.`
      );
    case "undeclared-runtime":
      return (
        `"${specifier}"는(은) package.json의 어떤 dependency 필드에도 ` +
        `선언되어 있지 않은 외부 참조입니다.`
      );
  }
};

// ---- line 번호 계산 --------------------------------------------------------

/**
 * CRLF, 단독 LF, 단독 CR, U+2028(line separator), U+2029(paragraph
 * separator)를 모두 line terminator로 인정한다. ECMAScript 명세의
 * LineTerminatorSequence 정의와 일치한다 — acorn의 loc 계산에 기대지
 * 않고 이 모듈이 직접 같은 규칙으로 line 번호를 매긴다.
 */
const LINE_TERMINATOR_PATTERN = /\r\n|[\n\r\u2028\u2029]/g;

/** source의 각 line이 시작하는 문자 offset(0-based) 목록. 첫 원소는 항상 0이다. */
const computeLineStarts = (source: string): number[] => {
  const starts = [0];
  for (const match of source.matchAll(LINE_TERMINATOR_PATTERN)) {
    starts.push(match.index + match[0].length);
  }
  return starts;
};

/** charOffset(0-based)이 속한 1-based line 번호를 이분 탐색으로 찾는다. */
const lineNumberFor = (
  lineStarts: readonly number[],
  charOffset: number,
): number => {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if ((lineStarts[mid] ?? 0) <= charOffset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
};

// ---- AST 순회 --------------------------------------------------------------

/** 위치·순회 메타데이터일 뿐 자식 노드가 아닌 key. */
const NON_CHILD_KEYS = new Set(["start", "end", "loc", "range"]);

const isNode = (value: unknown): value is AnyNode =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { type?: unknown }).type === "string";

/** 임의 노드의 자식 노드를 리플렉션으로 훑는다. */
const childNodesOf = (node: AnyNode): AnyNode[] => {
  const children: AnyNode[] = [];
  for (const key of Object.keys(node)) {
    if (NON_CHILD_KEYS.has(key)) continue;
    const value = (node as unknown as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) children.push(item);
      continue;
    }
    if (isNode(value)) children.push(value);
  }
  return children;
};

/** node를 pre-order로 방문한다. 동적 import()/require()는 어디에든 중첩될 수 있어 전체 트리를 훑는다. */
function walkTree(
  node: AnyNode | null | undefined,
  visit: (node: AnyNode) => void,
): void {
  if (node === null || node === undefined) return;
  visit(node);
  for (const child of childNodesOf(node)) walkTree(child, visit);
}

/** literal string이면 그 값을, 아니면 undefined를 돌려준다. */
const literalStringValue = (node: AnyNode): string | undefined =>
  node.type === "Literal" && typeof node.value === "string"
    ? node.value
    : undefined;

// ---- scanner 조립 ----------------------------------------------------------

/**
 * projectDir의 package.json을 읽어 dependency closure scanner를 만든다.
 *
 * @param projectDir package.json이 있는 대상 프로젝트 디렉터리(절대 경로 권장).
 * @throws {BbError} BB_INPUT_NOT_FOUND — package.json을 찾을 수 없음.
 * @throws {BbError} BB_CONFIG_INVALID — package.json이 JSON이 아니거나 object가 아님.
 */
export async function createDependencyClosureScanner(
  projectDir: string,
): Promise<DependencyClosureScanner> {
  const manifest = await loadManifest(projectDir);

  const scan = (source: string, file: string): readonly DependencyFinding[] => {
    let ast: Program;
    try {
      ast = parse(source, {
        ecmaVersion: "latest",
        sourceType: "module",
      }) as Program;
    } catch (cause) {
      throw new Error(
        `${file}을(를) 파싱할 수 없습니다: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
    }

    const lineStarts = computeLineStarts(source);
    const results: DependencyFinding[] = [];

    const recordLiteral = (node: AnyNode, specifier: string): void => {
      const kind = classifySpecifier(specifier, manifest);
      if (kind === undefined) return;
      results.push({
        file,
        line: lineNumberFor(lineStarts, node.start),
        name: specifier,
        kind,
        detail: describeLeak(kind, specifier),
      });
    };

    const recordComputed = (node: AnyNode): void => {
      const snippet = source.slice(node.start, node.end);
      results.push({
        file,
        line: lineNumberFor(lineStarts, node.start),
        name: snippet,
        kind: "computed-specifier",
        detail: `동적으로 계산된 specifier라 정적으로 분류할 수 없습니다: ${snippet}`,
      });
    };

    walkTree(ast, (node) => {
      switch (node.type) {
        case "ImportDeclaration":
        case "ExportNamedDeclaration":
        case "ExportAllDeclaration": {
          const sourceNode = node.source;
          if (sourceNode === null || sourceNode === undefined) return;
          const value = literalStringValue(sourceNode);
          // 문법상 이 위치는 항상 string literal이라 non-literal 분기는
          // 실질적으로 발생하지 않는다(그래도 방어적으로 무시한다).
          if (value !== undefined) recordLiteral(sourceNode, value);
          return;
        }
        case "ImportExpression": {
          const argument = node.source;
          const value = literalStringValue(argument);
          if (value !== undefined) recordLiteral(argument, value);
          else recordComputed(argument);
          return;
        }
        case "CallExpression": {
          if (
            node.callee.type !== "Identifier" ||
            node.callee.name !== "require"
          ) {
            return;
          }
          const argument = node.arguments[0];
          if (argument === undefined) return; // require() 인자 없음: 방어적으로 무시
          const value = literalStringValue(argument);
          if (value !== undefined) recordLiteral(argument, value);
          else recordComputed(argument);
          return;
        }
        default:
          return;
      }
    });

    // 줄 번호 오름차순, 같은 줄이면 이름의 코드포인트 순. localeCompare는
    // 로케일에 따라 결과가 갈려 출력이 환경마다 흔들릴 수 있어 쓰지 않는다
    // (compareCodePoint는 @cp949/bb-core가 sortFindings와 공유하는 비교자다).
    results.sort((a, b) => {
      const lineDiff = a.line - b.line;
      if (lineDiff !== 0) return lineDiff;
      return compareCodePoint(a.name, b.name);
    });

    return results;
  };

  return { scan };
}
