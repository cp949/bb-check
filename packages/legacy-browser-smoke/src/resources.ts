import type { PageSession } from "./page-session.js";
import { normalizeSignalText } from "./signal.js";

export type { PageSession } from "./page-session.js";

export interface StylesheetSource {
  readonly href: string | null;
  readonly text: string | null;
}

export interface PageSignal {
  readonly kind: "console" | "page-error" | "request-failed" | "http-error";
  readonly text: string;
}

export interface PageResources {
  readonly scripts: readonly string[];
  readonly stylesheets: readonly StylesheetSource[];
  readonly failedRequests: readonly PageSignal[];
}

export interface PageResourceCollector {
  finish(): Promise<PageResources>;
  dispose(): void;
}

interface RequestDetails {
  readonly type: string;
  readonly path: string;
}

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
): PageResources =>
  Object.freeze({
    scripts: Object.freeze([...scripts]),
    stylesheets: Object.freeze(
      stylesheets.map((stylesheet) => Object.freeze({ ...stylesheet })),
    ),
    failedRequests: Object.freeze(
      failedRequests.map((signal) => Object.freeze({ ...signal })),
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
// CDP round-trip 자체가 실패하거나(커맨드 reject) evaluation-exception 모양
// (예: {result:{type:"object",subtype:"error"},exceptionDetails:{...}})처럼
// 껍데기 자체가 기대와 다르면 여기서 던진다 — 이는 페이지 콘텐츠 검증이 아니라
// CDP가 snapshot을 아예 내주지 못한 경우이므로 finish()에서 degrade 대상이 된다.
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
  return freezeResources(scripts, stylesheets, []);
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
  };

  const trackRequest = (params: object): void => {
    const requestId = nonEmptyText(eventValue(params, "requestId"));
    const type = nonEmptyText(eventValue(params, "type"));
    const request = eventValue(params, "request");
    const path = isRecord(request)
      ? pathnameFrom(eventValue(request, "url"))
      : undefined;
    if (requestId === undefined || type === undefined || path === undefined)
      return;
    requests.set(requestId, { type, path });
  };

  const trackLoadingFailure = (params: object): void => {
    const requestId = nonEmptyText(eventValue(params, "requestId"));
    if (requestId === undefined) return;
    const request = requests.get(requestId);
    if (request === undefined) return;
    const errorText = nonEmptyText(eventValue(params, "errorText"));
    const blockedReason = optionalSignalText(
      eventValue(params, "blockedReason"),
    );
    const canceled = eventValue(params, "canceled");
    if (
      errorText === undefined ||
      blockedReason === undefined ||
      typeof canceled !== "boolean"
    ) {
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
    const request = requests.get(requestId);
    const response = eventValue(params, "response");
    if (request === undefined || !isRecord(response)) return;
    const status = eventValue(response, "status");
    if (
      typeof status !== "number" ||
      !Number.isInteger(status) ||
      status < 400 ||
      status > 599
    ) {
      return;
    }
    requests.delete(requestId);
    failedRequests.push({
      kind: "http-error",
      text: `status=${status}; type=${request.type}; path=${request.path}`,
    });
  };

  const trackLoadingFinished = (params: object): void => {
    const requestId = nonEmptyText(eventValue(params, "requestId"));
    if (requestId !== undefined) requests.delete(requestId);
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

  let finished: Promise<PageResources> | undefined;
  const finish = (): Promise<PageResources> => {
    if (finished !== undefined) return finished;
    const completion = deferred<PageResources>();
    finished = completion.promise;
    detach();
    void Promise.resolve()
      .then(async () => {
        let snapshot: Readonly<Record<string, unknown>>;
        try {
          const evaluated = await session.command("Runtime.evaluate", {
            expression: snapshotExpression,
            returnByValue: true,
          });
          snapshot = unwrapSnapshotContainer(evaluated);
        } catch {
          // scripts/stylesheets는 어떤 소비자도 읽지 않는 부가 데이터다(smoke.ts는
          // failedRequests만 사용한다). CDP round-trip이 실패하거나 예기치 못한
          // 모양으로 돌아오는 것은 페이지 콘텐츠 문제가 아니라 CDP 쪽 사정이므로,
          // 눈에 보이지 않는 이 데이터 하나 때문에 이미 수집한 failedRequests까지
          // 버리고 전체 페이지 run을 abort시키면 안 된다 — 빈 목록으로 degrade한다.
          return freezeResources([], [], failedRequests);
        }
        const resources = readResourcesFromSnapshot(snapshot);
        return freezeResources(
          resources.scripts,
          resources.stylesheets,
          failedRequests,
        );
      })
      .then(completion.resolve, completion.reject);
    return finished;
  };

  return {
    finish,
    dispose,
  };
};
