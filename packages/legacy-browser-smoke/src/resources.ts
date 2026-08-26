import type { DeadlineSignal } from "./cdp.js";
import type { PageSession } from "./page-session.js";
import { normalizeSignalText } from "./signal.js";

export type { PageSession } from "./page-session.js";

export interface StylesheetSource {
  readonly href: string | null;
  readonly text: string | null;
}

export interface PageSignal {
  readonly kind:
    | "console" | "page-error" | "request-failed" | "http-error"
    | "script-parse" | "script-pending" | "path-mismatch";
  readonly text: string;
}

export interface PageResources {
  readonly scripts: readonly string[];
  readonly stylesheets: readonly StylesheetSource[];
  readonly failedRequests: readonly PageSignal[];
  readonly pendingScripts: readonly PageSignal[];
}

export interface PageResourceCollector {
  finish(): Promise<PageResources>;
  dispose(): void;
  waitForScriptSettle(deadline: DeadlineSignal): Promise<void>;
}

interface RequestDetails {
  readonly type: string;
  readonly path: string;
}

/** `Network.requestWillBeSent`가 `type`을 생략했을 때 쓰는 CDP ResourceType 값. */
const unknownResourceType = "Other";

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const ownValue = (record: object, key: string): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (
    descriptor === undefined ||
    !descriptor.enumerable ||
    !("value" in descriptor)
  ) {
    throw new TypeError("invalid page resource snapshot");
  }
  return descriptor.value;
};

const eventValue = (record: object, key: string): unknown => {
  try {
    return ownValue(record, key);
  } catch {
    return undefined;
  }
};

const denseValues = (value: unknown): readonly unknown[] => {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    Reflect.ownKeys(value).length !== value.length + 1
  ) {
    throw new TypeError("invalid page resource snapshot");
  }
  const values: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      throw new TypeError("invalid page resource snapshot");
    }
    values.push(descriptor.value);
  }
  return values;
};

const nonEmptyText = (value: unknown): string | undefined => {
  try {
    return normalizeSignalText(value);
  } catch {
    return undefined;
  }
};

const optionalSignalText = (value: unknown): string | undefined =>
  value === undefined ? "" : nonEmptyText(value);

const pathnameFrom = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return url.pathname;
    }
    if (url.protocol === "blob:" || url.protocol === "filesystem:") {
      return pathnameFrom(url.pathname) ?? url.protocol;
    }
    return url.protocol;
  } catch {
    return undefined;
  }
};

const isAbsoluteUrl = (value: string): boolean => {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
};

const freezeResources = (
  scripts: readonly string[],
  stylesheets: readonly StylesheetSource[],
  failedRequests: readonly PageSignal[],
  pendingScripts: readonly PageSignal[],
): PageResources =>
  Object.freeze({
    scripts: Object.freeze([...scripts]),
    stylesheets: Object.freeze(
      stylesheets.map((stylesheet) => Object.freeze({ ...stylesheet })),
    ),
    failedRequests: Object.freeze(
      failedRequests.map((signal) => Object.freeze({ ...signal })),
    ),
    pendingScripts: Object.freeze(
      pendingScripts.map((signal) => Object.freeze({ ...signal })),
    ),
  });

const deferred = <Value>(): {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value | PromiseLike<Value>) => void;
  readonly reject: (reason?: unknown) => void;
} => {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

// Runtime.evaluate 응답 껍데기를 벗겨 snapshot record를 꺼낸다.
// 응답은 도착했지만 evaluation-exception 모양
// (예: {result:{type:"object",subtype:"error"},exceptionDetails:{...}})처럼
// 껍데기 자체가 기대와 다르면 여기서 던진다 — 이는 페이지 콘텐츠 검증이 아니라
// CDP가 snapshot을 아예 내주지 못한 경우이므로 finish()에서 degrade 대상이 된다.
// 반대로 command가 reject하는 경우(연결 종료, timeout, abort)는 degrade하지 않고
// 그대로 전파된다 — 그 상황에서는 이 page의 판정 자체를 신뢰할 수 없다.
const unwrapSnapshotContainer = (
  value: unknown,
): Readonly<Record<string, unknown>> => {
  if (!isRecord(value)) {
    throw new TypeError("invalid Runtime.evaluate result");
  }
  const result = ownValue(value, "result");
  if (!isRecord(result) || ownValue(result, "type") !== "object") {
    throw new TypeError("invalid Runtime.evaluate result");
  }
  const snapshot = ownValue(result, "value");
  if (!isRecord(snapshot)) {
    throw new TypeError("invalid page resource snapshot");
  }
  return snapshot;
};

// 껍데기를 벗긴 snapshot record에서 실제 script/stylesheet 값을 읽고 검증한다.
// 여기서 던지는 오류(상대 URL, 접근 불가능한 accessor 등)는 페이지가 내려준
// 콘텐츠 자체에 대한 fail-closed 검증이므로 finish()에서 degrade하지 않고
// 그대로 전파한다.
const readResourcesFromSnapshot = (
  snapshot: Readonly<Record<string, unknown>>,
): PageResources => {
  const rawScripts = denseValues(ownValue(snapshot, "scripts"));
  const rawStylesheets = denseValues(ownValue(snapshot, "stylesheets"));

  const scripts: string[] = [];
  const scriptValues = new Set<string>();
  for (const script of rawScripts) {
    if (
      typeof script !== "string" ||
      script === "" ||
      !isAbsoluteUrl(script) ||
      scriptValues.has(script)
    ) {
      if (
        typeof script !== "string" ||
        script === "" ||
        !isAbsoluteUrl(script)
      ) {
        throw new TypeError("invalid script resource");
      }
      continue;
    }
    scriptValues.add(script);
    scripts.push(script);
  }

  const stylesheets: StylesheetSource[] = [];
  const hrefValues = new Set<string>();
  const textValues = new Set<string>();
  for (const stylesheet of rawStylesheets) {
    if (!isRecord(stylesheet))
      throw new TypeError("invalid stylesheet resource");
    const href = ownValue(stylesheet, "href");
    const text = ownValue(stylesheet, "text");
    if (
      typeof href === "string" &&
      href !== "" &&
      isAbsoluteUrl(href) &&
      text === null
    ) {
      if (!hrefValues.has(href)) {
        hrefValues.add(href);
        stylesheets.push({ href, text: null });
      }
      continue;
    }
    if (href === null && typeof text === "string" && text !== "") {
      if (!textValues.has(text)) {
        textValues.add(text);
        stylesheets.push({ href: null, text });
      }
      continue;
    }
    throw new TypeError("invalid stylesheet resource");
  }
  return freezeResources(scripts, stylesheets, [], []);
};

const snapshotExpression =
  "(function(){var scripts=[],stylesheets=[],nodes=document.querySelectorAll('script[src],link[rel][href],style'),i,node,rel,text,rules,j,css,href;for(i=0;i<nodes.length;i+=1){node=nodes[i];if(node.tagName==='SCRIPT'){if(node.src){scripts.push(node.src)}continue}if(node.tagName==='LINK'){rel=(node.rel||'').toLowerCase().split(/\\s+/);if(rel.indexOf('stylesheet')!==-1&&node.href){stylesheets.push({href:node.href,text:null})}}else if(node.tagName==='STYLE'){text=node.textContent;if(text){stylesheets.push({href:null,text:text})}}try{rules=node.sheet&&node.sheet.cssRules;if(rules){css=[];for(j=0;j<rules.length;j+=1){if(rules[j].cssText){css.push(rules[j].cssText)}}if(css.length){stylesheets.push({href:null,text:css.join('\\n')})}}}catch(error){}}return{scripts:scripts,stylesheets:stylesheets}})()";

const ignoreMalformedEvent =
  (listener: (params: object) => void): ((params: object) => void) =>
  (params) => {
    try {
      listener(params);
    } catch {
      // CDP event payloads are untrusted and must not break session dispatch.
    }
  };

export const beginPageResourceCollection = async (
  session: PageSession,
): Promise<PageResourceCollector> => {
  const requests = new Map<string, RequestDetails>();
  const failedRequests: PageSignal[] = [];
  const scriptRequests = new Map<
    string,
    { readonly path: string; terminal: boolean }
  >();
  const settleWaiters = new Set<() => void>();

  const hasPendingScript = (): boolean => {
    for (const request of scriptRequests.values()) {
      if (!request.terminal) return true;
    }
    return false;
  };

  const releaseSettleWaiters = (): void => {
    for (const waiter of [...settleWaiters]) waiter();
    settleWaiters.clear();
  };

  /** Script requestId의 terminal lifecycle을 성공/실패 어느 쪽이든 확정한다. */
  const markScriptTerminal = (requestId: string | undefined): void => {
    if (requestId === undefined) return;
    const request = scriptRequests.get(requestId);
    if (request === undefined || request.terminal) return;
    request.terminal = true;
    if (!hasPendingScript()) releaseSettleWaiters();
  };

  let accepting = true;
  let detached = false;
  const unsubscribe: (() => void)[] = [];
  const detach = (): void => {
    accepting = false;
    if (detached) return;
    detached = true;
    for (const stop of unsubscribe) {
      try {
        stop();
      } catch {
        // Cleanup is best-effort and must preserve the primary lifecycle error.
      }
    }
    releaseSettleWaiters();
  };

  const trackRequest = (params: object): void => {
    const requestId = nonEmptyText(eventValue(params, "requestId"));
    // `type`은 protocol schema에서 optional이다. 없다고 request 추적을 포기하면
    // 이후의 loadingFailed/responseReceived가 전부 조용히 버려지므로,
    // CDP ResourceType의 fallback 값인 "Other"로 대신 기록한다.
    const type =
      nonEmptyText(eventValue(params, "type")) ?? unknownResourceType;
    const request = eventValue(params, "request");
    const path = isRecord(request)
      ? pathnameFrom(eventValue(request, "url"))
      : undefined;
    if (requestId === undefined || path === undefined) return;
    requests.set(requestId, { type, path });
    if (type === "Script") {
      scriptRequests.set(requestId, { path, terminal: false });
    }
  };

  const trackLoadingFailure = (params: object): void => {
    const requestId = nonEmptyText(eventValue(params, "requestId"));
    if (requestId === undefined) return;
    markScriptTerminal(requestId);
    const request = requests.get(requestId);
    if (request === undefined) return;
    const errorText = nonEmptyText(eventValue(params, "errorText"));
    const blockedReason = optionalSignalText(
      eventValue(params, "blockedReason"),
    );
    // `canceled`도 optional이므로 sibling인 blockedReason과 동일하게 다룬다:
    // 값이 없거나 boolean이 아니면 "취소 아님"으로 보고, 신호 자체를 버리지 않는다.
    const canceled = eventValue(params, "canceled") === true;
    if (errorText === undefined || blockedReason === undefined) {
      return;
    }
    requests.delete(requestId);
    failedRequests.push({
      kind: "request-failed",
      text: `type=${request.type}; path=${request.path}; error=${errorText}; blocked=${blockedReason}; canceled=${String(canceled)}`,
    });
  };

  const trackHttpFailure = (params: object): void => {
    const requestId = nonEmptyText(eventValue(params, "requestId"));
    if (requestId === undefined) return;
    const response = eventValue(params, "response");
    if (!isRecord(response)) return;
    const status = eventValue(response, "status");
    if (
      typeof status !== "number" ||
      !Number.isInteger(status) ||
      status < 400 ||
      status > 599
    ) {
      return;
    }
    markScriptTerminal(requestId);
    const request = requests.get(requestId);
    if (request === undefined) return;
    requests.delete(requestId);
    failedRequests.push({
      kind: "http-error",
      text: `status=${status}; type=${request.type}; path=${request.path}`,
    });
  };

  const trackLoadingFinished = (params: object): void => {
    const requestId = nonEmptyText(eventValue(params, "requestId"));
    if (requestId === undefined) return;
    markScriptTerminal(requestId);
    requests.delete(requestId);
  };

  const subscribe = (
    method: string,
    listener: (params: object) => void,
  ): void => {
    unsubscribe.push(
      session.on(method, (params) => {
        if (!accepting) return;
        ignoreMalformedEvent(listener)(params);
      }),
    );
  };

  try {
    subscribe("Network.requestWillBeSent", trackRequest);
    subscribe("Network.loadingFailed", trackLoadingFailure);
    subscribe("Network.responseReceived", trackHttpFailure);
    subscribe("Network.loadingFinished", trackLoadingFinished);
  } catch (error) {
    detach();
    throw error;
  }

  try {
    await session.command("Network.enable");
  } catch (error) {
    detach();
    throw error;
  }

  const dispose = (): void => {
    detach();
  };

  const waitForScriptSettle = (deadline: DeadlineSignal): Promise<void> =>
    new Promise((resolve) => {
      if (!accepting || !hasPendingScript() || deadline.expired()) {
        resolve();
        return;
      }
      let cancelExpire = (): void => {};
      const waiter = (): void => {
        cancelExpire();
        resolve();
      };
      settleWaiters.add(waiter);
      cancelExpire = deadline.onExpire(() => {
        settleWaiters.delete(waiter);
        resolve();
      });
    });

  let finished: Promise<PageResources> | undefined;
  const finish = (): Promise<PageResources> => {
    if (finished !== undefined) return finished;
    const completion = deferred<PageResources>();
    finished = completion.promise;
    const pendingScripts: PageSignal[] = [];
    for (const request of scriptRequests.values()) {
      if (!request.terminal) {
        pendingScripts.push({
          kind: "script-pending",
          text: `path=${request.path}`,
        });
      }
    }
    detach();
    void Promise.resolve()
      .then(async () => {
        // command 자체의 실패(LBS_COMMAND_TIMEOUT, LBS_ABORTED, 연결 종료 등)는
        // 이 page를 계속 판정할 수 있다는 전제 자체가 깨졌다는 뜻이므로 degrade
        // 대상이 아니다. try 밖에 두어 호출자에게 그대로 전파한다.
        const evaluated = await session.command("Runtime.evaluate", {
          expression: snapshotExpression,
          returnByValue: true,
        });
        let snapshot: Readonly<Record<string, unknown>>;
        try {
          snapshot = unwrapSnapshotContainer(evaluated);
        } catch {
          // scripts/stylesheets는 어떤 소비자도 읽지 않는 부가 데이터다(smoke.ts는
          // failedRequests만 사용한다). 응답이 왔지만 snapshot 껍데기가 기대와
          // 다른 것(evaluation exception 모양 등)은 페이지 콘텐츠 문제가 아니라
          // CDP 쪽 사정이므로, 눈에 보이지 않는 이 데이터 하나 때문에 이미 수집한
          // failedRequests까지 버리면 안 된다 — 빈 목록으로 degrade한다.
          return freezeResources([], [], failedRequests, pendingScripts);
        }
        const resources = readResourcesFromSnapshot(snapshot);
        return freezeResources(
          resources.scripts,
          resources.stylesheets,
          failedRequests,
          pendingScripts,
        );
      })
      .then(completion.resolve, completion.reject);
    return finished;
  };

  return {
    finish,
    dispose,
    waitForScriptSettle,
  };
};
