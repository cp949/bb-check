// BCD 색인(compat-bcd.ts)과 scope 분석(compat-scope.ts)을 엮어, 배포
// JavaScript가 baseline이 지원하지 않는 런타임 API를 쓰는 곳을 찾는다.
//
// 문법(트랜스파일로 해소되는 것)은 syntax-gate.ts가 담당한다. 이 모듈은
// 트랜스파일로 절대 해소되지 않는 런타임 API 존재 여부만 다룬다.
//
// 판정은 확신 순으로 세 단계다.
//
//   tier 1(확정): 전역 식별자, 그리고 그 전역의 멤버. compat-scope.ts의
//     scope 분석이 수신자가 진짜 전역임을 증명하므로 오탐이 없다.
//   tier 2(모호): 수신자의 정적 타입을 증명할 수 없는 인스턴스 멤버 접근.
//     "그 receiver가 무엇일 수도 있다(could be)"는 신호이며, allowed 예외가
//     유일한 해소 수단이다.
//   tier 3(특수): 생성자·메서드의 옵션 객체 안에 숨은 서브피처
//     (new Error(m, { cause }), addEventListener(t, f, { signal }) 등).
//
// 셋 다 finding을 만든다 — 확신의 차이는 CompatFinding.tier로만 남는다.

import { parse } from "acorn";
import type {
  AnyNode,
  CallExpression,
  Identifier,
  MemberExpression,
  Program,
} from "acorn";
import type { BrowserBaseline, LibraryAllowance } from "@cp949/bb-core";
import {
  buildCompatIndex,
  ERROR_CAUSE_CONSTRUCTORS,
  type CompatCandidate,
  type CompatIndex,
  type CompatIssue,
} from "./compat-bcd.js";
import { collectGlobalReferences } from "./compat-scope.js";

/** globalThis/window/self는 어떤 깊이로 반복돼도 "같은 전역 객체"를 가리키는 것으로 본다. */
const GLOBAL_OBJECT_ALIASES = new Set(["globalThis", "window", "self"]);

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

/**
 * node를 pre-order로 방문한다. visitNode는 매 노드마다 한 번 불리며,
 * 무엇을 하든(claim, report, 조기 return) 자식 순회 여부에는 영향을
 * 주지 않는다 — 자식은 이 함수가 항상 마저 방문한다. tier 판정 로직이
 * "이 노드는 처리 끝"과 "이 서브트리는 그만 본다"를 착각하지 않도록
 * 순회 제어와 판정 로직을 분리한다.
 */
function walkTree(
  node: AnyNode | null | undefined,
  parent: AnyNode | null,
  visitNode: (node: AnyNode, parent: AnyNode | null) => void,
): void {
  if (node === null || node === undefined) return;
  visitNode(node, parent);
  for (const child of childNodesOf(node)) walkTree(child, node, visitNode);
}

/** MemberExpression의 프로퍼티 이름을 읽는다. computed는 문자열 리터럴일 때만 판정한다. */
const memberPropertyName = (node: MemberExpression): string | undefined => {
  if (!node.computed) {
    return node.property.type === "Identifier" ? node.property.name : undefined;
  }
  return node.property.type === "Literal" &&
    typeof node.property.value === "string"
    ? node.property.value
    : undefined;
};

/** node가 지정한 key를 가진 object literal인지 본다(옵션 서브피처 탐지용). */
const hasObjectKey = (node: AnyNode | undefined, keyName: string): boolean => {
  if (node === undefined || node.type !== "ObjectExpression") return false;
  return node.properties.some((property) => {
    if (property.type !== "Property") return false; // spread는 내용을 모르므로 판정하지 않는다.
    if (property.computed) {
      return property.key.type === "Literal" && property.key.value === keyName;
    }
    if (property.key.type === "Identifier")
      return property.key.name === keyName;
    return property.key.type === "Literal" && property.key.value === keyName;
  });
};

interface ReceiverDescription {
  /** 색인 조회에 쓸 이름(전역 객체 접두를 벗긴 실제 receiver 이름). */
  readonly ownerName: string;
  /** finding 이름에 쓸, 소스에 실제로 쓰인 표기 그대로. */
  readonly sourceText: string;
  /** tier 1로 확정되면 함께 claim 처리할 노드 목록(자기 자신 포함, 바깥에서 안쪽 순). */
  readonly claim: readonly AnyNode[];
}

/**
 * MemberExpression의 object 쪽을 재귀적으로 해석한다.
 *
 * 단순 식별자(예: `AbortSignal`)가 scope 분석이 증명한 전역 참조면
 * 그 자체가 receiver다. globalThis/window/self 접두는 몇 단계든 벗겨서
 * 실제 receiver까지 파고든다(`globalThis.globalThis.Object` 같은 반복도
 * 깊이 제한 없이 처리된다). 그 외(계산된 접근, 증명 안 된 식별자 등)는
 * receiver를 알 수 없으므로 undefined.
 */
function describeReceiver(
  expr: AnyNode,
  globalRefs: ReadonlySet<Identifier>,
): ReceiverDescription | undefined {
  if (expr.type === "Identifier") {
    if (!globalRefs.has(expr)) return undefined;
    return { ownerName: expr.name, sourceText: expr.name, claim: [expr] };
  }
  if (expr.type === "MemberExpression") {
    const property = memberPropertyName(expr);
    if (property === undefined) return undefined;
    const outer = describeReceiver(expr.object, globalRefs);
    if (outer === undefined || !GLOBAL_OBJECT_ALIASES.has(outer.ownerName))
      return undefined;
    return {
      ownerName: property,
      sourceText: `${outer.sourceText}.${property}`,
      claim: [expr, ...outer.claim],
    };
  }
  return undefined;
}

const describeIssue = (issue: CompatIssue): string => {
  switch (issue.reason) {
    case "not-yet-added":
      return `${issue.browser} ${issue.baselineVersion}에서 아직 지원되지 않습니다(${issue.requiredVersion}부터 지원).`;
    case "removed":
      return `${issue.browser} ${issue.baselineVersion} 시점에는 이미 제거된 API입니다.`;
    case "never-added":
      return `${issue.browser} ${issue.baselineVersion}에서 지원되지 않습니다(추가된 적 없음).`;
  }
};

const formatDetail = (candidate: CompatCandidate): string =>
  candidate.issues.map(describeIssue).join(" ");

/** finding 확신 등급. 1이 가장 확실하고(전역 증명됨), 3이 가장 특수하다(옵션 서브피처). */
export type CompatFindingTier = 1 | 2 | 3;

export interface CompatFinding {
  readonly file: string;
  /** acorn이 위치 정보를 못 준 경우(이론상 발생하지 않지만 방어적으로) null. */
  readonly line: number | null;
  readonly name: string;
  readonly detail: string;
  readonly tier: CompatFindingTier;
}

export interface CompatScannerOptions {
  readonly baseline: BrowserBaseline;
  readonly allowed?: readonly LibraryAllowance[];
}

export interface CompatScanner {
  (source: string, file: string): readonly CompatFinding[];
  /**
   * allowed 항목별 실제 매칭 횟수. key는 `${file}\0${name}`(정확히 그
   * allowed 항목의 file/name 원본 값 기준 — file이 "*"면 키에도 "*"가
   * 그대로 들어간다). 0이면 지금까지 어떤 scan() 호출에서도 해당
   * allowance가 실제로 finding을 면제한 적이 없다는 뜻이며, 상위(Task 8의
   * orchestration)가 "미사용 allowance"로 보고할 수 있다.
   */
  readonly allowanceMatchCounts: ReadonlyMap<string, number>;
}

const allowanceKey = (file: string, name: string): string => `${file}\0${name}`;

/**
 * baseline과 allowed 예외에 맞춰 runtime API 스캐너를 만든다.
 *
 * @throws {Error} allowed 항목의 file/name/reason 중 하나라도 비어 있으면.
 *   (packages/core의 normalizeConfig가 config 경로에서는 이미 같은 규칙을
 *   강제하지만, 이 함수는 config를 거치지 않고 직접 호출될 수도 있으므로
 *   스스로도 방어한다.)
 */
export function createCompatScanner(
  options: CompatScannerOptions,
): CompatScanner {
  const allowed = options.allowed ?? [];
  for (const entry of allowed) {
    if (
      entry.file.trim() === "" ||
      entry.name.trim() === "" ||
      entry.reason.trim() === ""
    ) {
      throw new Error(
        `allowed 항목의 file/name/reason은 비어 있지 않은 문자열이어야 합니다: ${JSON.stringify(entry)}`,
      );
    }
  }

  const index: CompatIndex = buildCompatIndex(options.baseline);

  const allowanceMatchCounts = new Map<string, number>();
  for (const entry of allowed)
    allowanceMatchCounts.set(allowanceKey(entry.file, entry.name), 0);

  /** name이 file에서 허용되는지 보고, 매칭된 모든 allowed 항목의 사용 횟수를 올린다. */
  const isAllowed = (file: string, name: string): boolean => {
    let matched = false;
    for (const entry of allowed) {
      if (entry.name !== name) continue;
      if (entry.file !== file && entry.file !== "*") continue;
      const key = allowanceKey(entry.file, entry.name);
      allowanceMatchCounts.set(key, (allowanceMatchCounts.get(key) ?? 0) + 1);
      matched = true;
    }
    return matched;
  };

  const scan = (source: string, file: string): readonly CompatFinding[] => {
    let ast: Program;
    try {
      ast = parse(source, {
        ecmaVersion: "latest",
        sourceType: "module",
        locations: true,
      }) as Program;
    } catch (cause) {
      throw new Error(
        `${file}을(를) 파싱할 수 없습니다: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
    }

    const globalRefs = collectGlobalReferences(ast);
    const claimed = new Set<AnyNode>();
    const results: CompatFinding[] = [];

    const buildFinding = (
      node: AnyNode,
      name: string,
      candidate: CompatCandidate,
      tier: CompatFindingTier,
    ): CompatFinding => ({
      file,
      line: node.loc?.start.line ?? null,
      name,
      detail: formatDetail(candidate),
      tier,
    });

    const listenerCalleeName = (node: CallExpression): string | undefined => {
      if (node.callee.type === "Identifier") return node.callee.name;
      if (node.callee.type === "MemberExpression")
        return memberPropertyName(node.callee);
      return undefined;
    };

    // pass 1: typeof 가드(면제) + tier 1의 "전역의 멤버" 형태 + tier 3.
    // 전위 순회이므로 typeof 가드는 항상 그 아래의 참조보다 먼저 방문돼
    // claimed에 반영된다.
    walkTree(ast, null, (node) => {
      if (node.type === "UnaryExpression" && node.operator === "typeof") {
        // typeof는 기능 탐지 관용구다 — 선언되지 않은 이름에 써도 던지지
        // 않으므로 어느 baseline에서도 안전하다. 이 분기 안의 사용은
        // 방어적 코드이지 위반이 아니다.
        claimed.add(node.argument);
        if (node.argument.type === "MemberExpression")
          claimed.add(node.argument.object);
        return;
      }

      if (node.type === "NewExpression" && node.callee.type === "Identifier") {
        const optionArgIndex = ERROR_CAUSE_CONSTRUCTORS.get(node.callee.name);
        if (
          optionArgIndex !== undefined &&
          globalRefs.has(node.callee) &&
          hasObjectKey(node.arguments[optionArgIndex], "cause")
        ) {
          // 생성자 자체가 이미 baseline 미만이면 그 tier 1 위반이 더
          // 근본적이다 — cause 옵션은 별도로 보고하지 않는다(pass 2가
          // 이 식별자를 그대로 tier 1로 잡는다. 여기서 claim하지 않는다).
          if (!index.globals.has(node.callee.name)) {
            const candidate = index.optionFeatures.get("Error.cause");
            if (candidate !== undefined && candidate.issues.length > 0) {
              const name = `new ${node.callee.name}(options.cause)`;
              if (!isAllowed(file, name))
                results.push(buildFinding(node, name, candidate, 3));
            }
          }
          return;
        }
      }

      if (node.type === "CallExpression") {
        // 수신자는 검증하지 않는다 — EventTarget을 구현하는 타입과
        // 번들러가 만드는 별칭을 전부 열거할 수 없고, worker 전역처럼
        // 수신자 없이 부르는 형태도 같은 서브피처이기 때문이다.
        if (
          listenerCalleeName(node) === "addEventListener" &&
          hasObjectKey(node.arguments[2], "signal")
        ) {
          const candidate = index.optionFeatures.get(
            "EventTarget.addEventListener.signal",
          );
          if (candidate !== undefined && candidate.issues.length > 0) {
            const name = "addEventListener(options.signal)";
            if (!isAllowed(file, name))
              results.push(buildFinding(node, name, candidate, 3));
          }
          claimed.add(node.callee);
          return;
        }
      }

      if (node.type === "MemberExpression") {
        if (claimed.has(node)) return;
        const property = memberPropertyName(node);
        if (property === undefined) return;

        const receiver = describeReceiver(node.object, globalRefs);
        if (receiver === undefined) return;

        // 전역 객체 접두(globalThis.structuredClone 등)는 전역 자체를
        // 부르는 것과 같다. 이 이름들은 statics가 아니라 globals에 있다.
        const prefixedGlobal = GLOBAL_OBJECT_ALIASES.has(receiver.ownerName)
          ? index.globals.get(property)
          : undefined;

        const owner =
          index.knownGlobalTypes.get(receiver.ownerName) ?? receiver.ownerName;
        const candidate =
          prefixedGlobal ?? index.staticMembers.get(`${owner}.${property}`);
        if (candidate === undefined) return;

        claimed.add(node);
        for (const claimedNode of receiver.claim) claimed.add(claimedNode);

        const name = `${receiver.sourceText}.${property}`;
        if (!isAllowed(file, name))
          results.push(buildFinding(node, name, candidate, 1));
      }
    });

    // pass 2: tier 1의 "맨몸 전역 식별자" 형태. pass 1이 멤버 접근으로
    // 이미 확정 보고한 receiver는 claimed로 건너뛴다(예: Temporal.Now.instant()
    // 에서 Temporal 자체를 다시 세지 않는다).
    for (const identifierNode of globalRefs) {
      if (claimed.has(identifierNode)) continue;
      const candidate = index.globals.get(identifierNode.name);
      if (candidate === undefined) continue;
      if (isAllowed(file, identifierNode.name)) continue;
      results.push(
        buildFinding(identifierNode, identifierNode.name, candidate, 1),
      );
    }

    // pass 3: tier 2. pass 1에서 claim되지 않은 MemberExpression만 본다.
    walkTree(ast, null, (node, parent) => {
      if (node.type !== "MemberExpression" || claimed.has(node)) return;
      const property = memberPropertyName(node);
      if (property === undefined) return;

      const candidate = index.instanceMembers.get(property);
      if (candidate === undefined) return;

      const isCallCallee =
        parent !== null &&
        parent.type === "CallExpression" &&
        parent.callee === node;
      const name = isCallCallee ? `.${property}()` : `.${property}`;
      if (isAllowed(file, name)) return;
      results.push(buildFinding(node, name, candidate, 2));
    });

    // 줄 번호 오름차순, 같은 줄이면 이름의 코드포인트 순. localeCompare는
    // 로케일에 따라 결과가 갈려 출력이 환경마다 흔들릴 수 있어 쓰지 않는다.
    results.sort((a, b) => {
      const lineDiff = (a.line ?? 0) - (b.line ?? 0);
      if (lineDiff !== 0) return lineDiff;
      if (a.name === b.name) return 0;
      return a.name < b.name ? -1 : 1;
    });

    return results;
  };

  return Object.assign(scan, { allowanceMatchCounts }) satisfies CompatScanner;
}
