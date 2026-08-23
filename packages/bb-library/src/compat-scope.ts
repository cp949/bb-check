// acorn AST에서 "가려지지 않은 전역 참조"만 골라낸다.
//
// acorn은 파싱만 하고 스코프 정보를 붙여주지 않는다(Identifier 노드에
// 바인딩 정보가 없다). runtime API 판정(compat-scanner.ts)의 Tier 1은
// "이 식별자가 실제로 전역을 가리킨다"는 증명 위에서만 성립하므로, 이
// 모듈이 스코프 체인을 직접 세워 그 증명을 만든다 — 증명하지 못하면
// Tier 1이 아니라 더 낮은 확신의 판정(Tier 2)으로 내려가야 한다.

import type {
  AnyNode,
  ArrayPattern,
  AssignmentPattern,
  CatchClause,
  ClassDeclaration,
  ClassExpression,
  FunctionDeclaration,
  Identifier,
  ImportDeclaration,
  ObjectPattern,
  Pattern,
  Program,
  RestElement,
  Statement,
  StaticBlock,
  SwitchStatement,
  VariableDeclaration,
} from "acorn";

/** 자기 스코프(함수 스코프)를 여는 노드 타입. */
const FUNCTION_NODE_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

/** block 스코프를 여는 노드 타입(함수 스코프는 별도로 다룬다). */
const BLOCK_SCOPE_NODE_TYPES = new Set([
  "BlockStatement",
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "SwitchStatement",
  "StaticBlock",
  "ClassBody",
]);

/** 위치·순회 메타데이터일 뿐 자식 노드가 아닌 key. */
const NON_CHILD_KEYS = new Set(["start", "end", "loc", "range"]);

interface Scope {
  readonly parent: Scope | null;
  /** var/함수 선언이 끌어올려지는(hoist) 경계인지. */
  readonly isHoistBoundary: boolean;
  readonly names: Set<string>;
}

const createScope = (
  parent: Scope | null,
  isHoistBoundary: boolean,
): Scope => ({
  parent,
  isHoistBoundary,
  names: new Set(),
});

/** name을 scope에 선언한다. hoistToBoundary면 가장 가까운 hoist 경계까지 올라간다(var, 함수 선언). */
const declareName = (
  scope: Scope,
  name: string,
  hoistToBoundary: boolean,
): void => {
  let target = scope;
  if (hoistToBoundary) {
    while (!target.isHoistBoundary && target.parent !== null) {
      target = target.parent;
    }
  }
  target.names.add(name);
};

/** scope 체인을 바깥으로 거슬러 올라가며 name이 어딘가에 선언됐는지 본다. */
const isDeclared = (scope: Scope, name: string): boolean => {
  for (
    let current: Scope | null = scope;
    current !== null;
    current = current.parent
  ) {
    if (current.names.has(name)) return true;
  }
  return false;
};

/** node가 object/노드 형태인지 좁혀준다. */
const isNode = (value: unknown): value is AnyNode =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { type?: unknown }).type === "string";

/** 임의 노드의 자식 노드를 전부 훑는다(순회용, 타입별 분기 없이 리플렉션으로). */
const childNodesOf = (node: AnyNode): AnyNode[] => {
  const children: AnyNode[] = [];
  for (const key of Object.keys(node)) {
    if (NON_CHILD_KEYS.has(key)) continue;
    const value = (node as unknown as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isNode(item)) children.push(item);
      }
      continue;
    }
    if (isNode(value)) children.push(value);
  }
  return children;
};

/**
 * 바인딩 패턴(매개변수, 구조분해 등)에서 선언되는 이름을 전부 모은다.
 * 기본값/구조분해/rest를 재귀적으로 따라간다.
 */
const collectPatternNames = (
  pattern: Pattern | null | undefined,
  into: string[],
): void => {
  if (pattern === null || pattern === undefined) return;
  switch (pattern.type) {
    case "Identifier":
      into.push(pattern.name);
      return;
    case "ObjectPattern":
      for (const property of (pattern as ObjectPattern).properties) {
        if (property.type === "RestElement") {
          collectPatternNames(property.argument, into);
        } else {
          collectPatternNames(property.value, into);
        }
      }
      return;
    case "ArrayPattern":
      for (const element of (pattern as ArrayPattern).elements) {
        collectPatternNames(element, into);
      }
      return;
    case "AssignmentPattern":
      collectPatternNames((pattern as AssignmentPattern).left, into);
      return;
    case "RestElement":
      collectPatternNames((pattern as RestElement).argument, into);
      return;
    default:
      // MemberExpression 패턴(대입 대상)은 새 바인딩을 선언하지 않는다.
      return;
  }
};

/** export wrapper 바로 안의 선언을 돌려준다(없으면 node 그대로). */
const unwrapExportDeclaration = (node: AnyNode): AnyNode => {
  if (
    (node.type === "ExportNamedDeclaration" ||
      node.type === "ExportDefaultDeclaration") &&
    "declaration" in node &&
    node.declaration !== null &&
    node.declaration !== undefined
  ) {
    return node.declaration as AnyNode;
  }
  return node;
};

/**
 * body(스코프 진입 시점의 statement 목록)를 미리 훑어 그 스코프에
 * 등록돼야 할 이름을 선등록한다.
 *
 * 함수 선언·var·import는 코드상 참조보다 뒤에 나와도 이미 바인딩돼
 * 있다. let/const/class도 초기화 전에는 TDZ지만 "그 이름이 이
 * 스코프에 속한다"는 사실 자체는 선언 위치와 무관하게 성립한다 — 이걸
 * 미리 등록하지 않으면 선언보다 앞선 참조를 잘못 전역으로 판정한다.
 */
const hoistDeclarations = (body: readonly AnyNode[], scope: Scope): void => {
  for (const statement of body) {
    const declaration = unwrapExportDeclaration(statement);

    if (declaration.type === "FunctionDeclaration") {
      const fn = declaration as FunctionDeclaration;
      if (fn.id !== null) declareName(scope, fn.id.name, false);
      continue;
    }
    if (declaration.type === "VariableDeclaration") {
      const decl = declaration as VariableDeclaration;
      if (decl.kind !== "var") {
        for (const declarator of decl.declarations) {
          const names: string[] = [];
          collectPatternNames(declarator.id, names);
          for (const name of names) declareName(scope, name, false);
        }
      }
      continue;
    }
    if (declaration.type === "ClassDeclaration") {
      const cls = declaration as ClassDeclaration;
      if (cls.id !== null) declareName(scope, cls.id.name, false);
      continue;
    }
    if (statement.type === "ImportDeclaration") {
      for (const specifier of (statement as ImportDeclaration).specifiers) {
        declareName(scope, specifier.local.name, false);
      }
    }
  }

  // var는 중첩 block 안에 있어도 이 hoist 경계까지 끌어올려진다. 단,
  // 중첩된 함수·static block 내부의 var는 그 자신의 경계에 속하므로
  // 여기서 더 들어가지 않는다.
  const pending: AnyNode[] = [...body];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined) continue;
    if (FUNCTION_NODE_TYPES.has(node.type) || node.type === "StaticBlock")
      continue;

    if (
      node.type === "VariableDeclaration" &&
      (node as VariableDeclaration).kind === "var"
    ) {
      for (const declarator of (node as VariableDeclaration).declarations) {
        const names: string[] = [];
        collectPatternNames(declarator.id, names);
        for (const name of names) declareName(scope, name, true);
      }
    }

    pending.push(...childNodesOf(node));
  }
};

/**
 * 이 Identifier 노드가 "값 참조 자리"가 아니라 "이름 자리"인지 본다.
 * 이름 자리는 전역 여부를 따질 대상이 아니다(예: `obj.foo`의 `foo`,
 * `{ foo: 1 }`의 key, label, `import.meta`의 meta/property 등).
 */
const isNamePosition = (parent: AnyNode | null, node: Identifier): boolean => {
  if (parent === null) return false;

  if (parent.type === "MemberExpression") {
    return parent.property === node && !parent.computed;
  }
  if (parent.type === "Property") {
    // 축약 표기 `{ foo }`는 acorn이 key와 value를 위치만 같은 별개
    // Identifier 객체로 만든다(`key === value`가 아니다). key 쪽만
    // 이름 자리로 걸러내면 value 쪽은 정상적으로 값 참조로 남는다.
    return parent.key === node && !parent.computed;
  }
  if (
    parent.type === "PropertyDefinition" ||
    parent.type === "MethodDefinition"
  ) {
    return parent.key === node && !parent.computed;
  }
  if (
    parent.type === "LabeledStatement" ||
    parent.type === "BreakStatement" ||
    parent.type === "ContinueStatement"
  ) {
    return (parent as { label?: Identifier | null }).label === node;
  }
  if (parent.type === "ExportSpecifier") {
    // acorn은 파싱 시점에 export specifier의 local이 실제 바인딩을
    // 가리키도록 강제한다. 항상 이름 자리로 봐도 안전하다.
    return true;
  }
  if (parent.type === "MetaProperty") {
    // new.target, import.meta의 meta/property는 고정 키워드 자리다.
    return true;
  }
  if (parent.type === "ExportAllDeclaration") {
    return (parent as { exported?: Identifier | null }).exported === node;
  }
  return false;
};

/**
 * AST를 훑어 "가려지지 않은 전역 식별자 참조"인 Identifier 노드를
 * 모은다.
 *
 * @param ast acorn이 만든 Program 노드(sourceType은 무관하게 동작한다).
 * @returns 전역 참조로 해석되는 Identifier 노드 집합. 같은 이름이 여러
 *   위치에서 쓰이면 각 사용 위치마다 별개 항목으로 들어간다.
 */
export function collectGlobalReferences(ast: Program): ReadonlySet<Identifier> {
  const globalRefs = new Set<Identifier>();
  const moduleScope = createScope(null, true);
  hoistDeclarations(ast.body, moduleScope);

  const visitPatternDefaults = (
    pattern: Pattern | null | undefined,
    scope: Scope,
  ): void => {
    if (pattern === null || pattern === undefined) return;
    switch (pattern.type) {
      case "AssignmentPattern":
        visit(pattern.right, pattern, scope);
        visitPatternDefaults(pattern.left, scope);
        return;
      case "ObjectPattern":
        for (const property of pattern.properties) {
          if (property.type === "RestElement") {
            visitPatternDefaults(property.argument, scope);
            continue;
          }
          if (property.computed) visit(property.key, property, scope);
          visitPatternDefaults(property.value, scope);
        }
        return;
      case "ArrayPattern":
        for (const element of pattern.elements)
          visitPatternDefaults(element, scope);
        return;
      case "RestElement":
        visitPatternDefaults(pattern.argument, scope);
        return;
      default:
    }
  };

  function visit(
    node: AnyNode | null | undefined,
    parent: AnyNode | null,
    scope: Scope,
  ): void {
    if (node === null || node === undefined) return;

    switch (node.type) {
      case "ImportDeclaration":
        for (const specifier of node.specifiers)
          declareName(scope, specifier.local.name, false);
        return;
      case "VariableDeclaration": {
        for (const declarator of node.declarations) {
          const names: string[] = [];
          collectPatternNames(declarator.id, names);
          for (const name of names) {
            // var는 hoistDeclarations가 이미 등록했다. let/const만 여기서 등록한다.
            declareName(scope, name, node.kind === "var");
          }
          if (declarator.init !== null && declarator.init !== undefined) {
            visit(declarator.init, declarator, scope);
          }
          visitPatternDefaults(declarator.id, scope);
        }
        return;
      }
      case "ClassDeclaration":
        if (node.id !== null) declareName(scope, node.id.name, false);
        break;
      case "Identifier":
        if (isNamePosition(parent, node)) return;
        if (!isDeclared(scope, node.name)) globalRefs.add(node);
        return;
      default:
    }

    if (FUNCTION_NODE_TYPES.has(node.type)) {
      const fn = node as {
        id?: Identifier | null;
        params: Pattern[];
        body: AnyNode;
        type: string;
      };
      const functionScope = createScope(scope, true);

      // 함수 표현식의 이름은 자기 스코프 안에서만 보인다.
      if (
        fn.type === "FunctionExpression" &&
        fn.id !== null &&
        fn.id !== undefined
      ) {
        declareName(functionScope, fn.id.name, false);
      }

      for (const param of fn.params) {
        const names: string[] = [];
        collectPatternNames(param, names);
        for (const name of names) declareName(functionScope, name, false);
      }
      for (const param of fn.params) visitPatternDefaults(param, functionScope);

      if (fn.body.type === "BlockStatement") {
        const blockBody = (fn.body as { body: Statement[] }).body;
        hoistDeclarations(blockBody, functionScope);
        for (const statement of blockBody)
          visit(statement, fn.body, functionScope);
        return;
      }
      visit(fn.body, node, functionScope);
      return;
    }

    if (node.type === "ClassExpression") {
      // 클래스 표현식의 이름도 함수 표현식과 같은 규칙(자기 스코프
      // 안에서만 보임)이다. 이 분기가 없으면 id가 일반 재귀를 타고
      // Identifier 케이스로 떨어져 전역 참조로 잘못 잡힌다.
      const cls = node as ClassExpression;
      const classScope = createScope(scope, false);
      if (cls.id !== null && cls.id !== undefined)
        declareName(classScope, cls.id.name, false);
      for (const child of childNodesOf(node)) visit(child, node, classScope);
      return;
    }

    if (node.type === "CatchClause") {
      const clause = node as CatchClause;
      const catchScope = createScope(scope, false);
      if (clause.param !== null && clause.param !== undefined) {
        const names: string[] = [];
        collectPatternNames(clause.param, names);
        for (const name of names) declareName(catchScope, name, false);
      }
      hoistDeclarations(clause.body.body, catchScope);
      for (const statement of clause.body.body)
        visit(statement, clause.body, catchScope);
      return;
    }

    if (BLOCK_SCOPE_NODE_TYPES.has(node.type)) {
      // static block의 var는 바깥 함수가 아니라 static block 자체가 경계다.
      const blockScope = createScope(scope, node.type === "StaticBlock");

      if (node.type === "BlockStatement" || node.type === "StaticBlock") {
        hoistDeclarations((node as StaticBlock).body, blockScope);
      } else if (node.type === "SwitchStatement") {
        hoistDeclarations(
          (node as SwitchStatement).cases.flatMap(
            (switchCase) => switchCase.consequent,
          ),
          blockScope,
        );
      }
      // ForStatement/ForInStatement/ForOfStatement는 별도 선등록이
      // 필요 없다 — init/left가 자식 노드로 body보다 먼저 방문되므로
      // (acorn이 필드를 그 순서로 만든다) VariableDeclaration의 일반
      // 재귀 처리(위 case "VariableDeclaration")가 test/body를 보기
      // 전에 이미 루프 변수를 이 blockScope에 등록해 둔다.

      for (const child of childNodesOf(node)) visit(child, node, blockScope);
      return;
    }

    for (const child of childNodesOf(node)) visit(child, node, scope);
  }

  for (const statement of ast.body) {
    visit(statement, ast, moduleScope);
  }

  return globalRefs;
}
