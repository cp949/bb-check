import { describe, expect, it } from "vitest";
import { startDeadline, type TimerAdapter } from "../src/cdp.js";
import { LegacyBrowserSmokeError } from "../src/errors.js";
import {
  beginPageResourceCollection,
  type PageSession,
} from "../src/resources.js";

interface PendingTimer {
  readonly id: number;
  readonly delayMs: number;
  readonly callback: () => void;
}

/** 실제 timer 없이 예약/취소를 관찰하고 원하는 시점에 발화시키는 test double. */
class FakeTimers implements TimerAdapter {
  private nextId = 0;
  private readonly timers = new Map<number, PendingTimer>();

  schedule(callback: () => void, delayMs: number): () => void {
    const id = (this.nextId += 1);
    this.timers.set(id, { id, delayMs, callback });
    return (): void => {
      this.timers.delete(id);
    };
  }

  get pendingCount(): number {
    return this.timers.size;
  }

  fire(delayMs: number): number {
    const due = [...this.timers.values()].filter(
      (timer) => timer.delayMs === delayMs,
    );
    for (const timer of due) {
      this.timers.delete(timer.id);
      timer.callback();
    }
    return due.length;
  }
}

type Listener = (params: object) => void;

interface PlannedRawSession {
  command<T>(method: string, params?: object): Promise<T>;
  on(method: string, listener: (params: object) => void): () => void;
}

const plannedSession = {} as PlannedRawSession;
const pageSession: PageSession = plannedSession;
void pageSession;

class SessionDouble implements PageSession {
  readonly commands: {
    readonly method: string;
    readonly params?: object | undefined;
  }[] = [];

  private readonly listeners = new Map<string, Set<Listener>>();

  async command<T>(method: string, params?: object): Promise<T> {
    this.commands.push({ method, params });
    return undefined as T;
  }

  on(method: string, listener: Listener): () => void {
    const listeners = this.listeners.get(method) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(method, listeners);
    return () => listeners.delete(listener);
  }

  listenerCount(): number {
    let count = 0;
    for (const listeners of this.listeners.values()) count += listeners.size;
    return count;
  }

  emit(method: string, params: object): void {
    for (const listener of this.listeners.get(method) ?? []) listener(params);
  }
}

describe("beginPageResourceCollection", () => {
  it("Network.enable 전에 모든 network listener를 동기 설치한다", async () => {
    const session = new SessionDouble();
    session.command = async <T>(
      method: string,
      params?: object,
    ): Promise<T> => {
      session.commands.push({ method, params });
      expect(method).toBe("Network.enable");
      expect(session.listenerCount()).toBe(4);
      return undefined as T;
    };

    const collector = await beginPageResourceCollection(session);

    expect(session.commands).toEqual([
      { method: "Network.enable", params: undefined },
    ]);
    collector.dispose();
  });

  it("Network.enable 실패 시 설치했던 모든 listener를 해제하고 원래 오류를 보존한다", async () => {
    const session = new SessionDouble();
    const failure = new Error("enable failed");
    session.command = async (): Promise<never> => Promise.reject(failure);

    await expect(beginPageResourceCollection(session)).rejects.toBe(failure);
    expect(session.listenerCount()).toBe(0);
  });

  it("partial listener 등록 실패는 이미 등록한 listener를 모두 detach하고 등록 오류를 보존한다", async () => {
    const session = new SessionDouble();
    const registrationFailure = new Error("response listener failed");
    const detached: string[] = [];
    session.on = ((method: string): (() => void) => {
      if (method === "Network.responseReceived") throw registrationFailure;
      return () => {
        detached.push(method);
        if (method === "Network.requestWillBeSent") {
          throw new Error("detach must not replace registration error");
        }
      };
    }) as SessionDouble["on"];

    await expect(beginPageResourceCollection(session)).rejects.toBe(
      registrationFailure,
    );
    expect(detached).toEqual([
      "Network.requestWillBeSent",
      "Network.loadingFailed",
    ]);
    expect(session.commands).toEqual([]);
  });

  it("Network.enable primary error는 throwing cleanup보다 우선하고 모든 detach를 시도한다", async () => {
    const session = new SessionDouble();
    const failure = new Error("enable failed");
    let detachCount = 0;
    session.on = (() => () => {
      detachCount += 1;
      throw new Error("cleanup failed");
    }) as SessionDouble["on"];
    session.command = async (): Promise<never> => Promise.reject(failure);

    await expect(beginPageResourceCollection(session)).rejects.toBe(failure);
    expect(detachCount).toBe(4);
  });

  it("finish는 listener를 먼저 해제하고 최초 결과 promise와 동결 snapshot을 재사용한다", async () => {
    const session = new SessionDouble();
    session.command = async <T>(
      method: string,
      params?: object,
    ): Promise<T> => {
      session.commands.push({ method, params });
      if (method === "Runtime.evaluate") {
        expect(session.listenerCount()).toBe(0);
        session.emit("Network.loadingFailed", {
          requestId: "late",
          errorText: "late event",
        });
        return {
          result: {
            type: "object",
            value: { scripts: [], stylesheets: [] },
          },
        } as T;
      }
      return undefined as T;
    };

    const collector = await beginPageResourceCollection(session);
    session.emit("Network.requestWillBeSent", {
      requestId: "first",
      type: "Script",
      request: { url: "https://example.test/app.js?token=secret" },
    });
    session.emit("Network.loadingFailed", {
      requestId: "first",
      errorText: "net::ERR_FAILED",
      blockedReason: "inspector",
      canceled: false,
    });

    const first = collector.finish();
    const second = collector.finish();
    expect(second).toBe(first);
    const result = await first;

    expect(result).toEqual({
      scripts: [],
      stylesheets: [],
      failedRequests: [
        {
          kind: "request-failed",
          text: "type=Script; path=/app.js; error=net::ERR_FAILED; blocked=inspector; canceled=false",
        },
      ],
      pendingScripts: [],
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.scripts)).toBe(true);
    expect(Object.isFrozen(result.stylesheets)).toBe(true);
    expect(Object.isFrozen(result.failedRequests)).toBe(true);
    expect(Object.isFrozen(result.failedRequests[0])).toBe(true);
    expect(session.commands.map((command) => command.method)).toEqual([
      "Network.enable",
      "Runtime.evaluate",
    ]);
  });

  it("finish 반환 전에 listener를 동기 detach하고 reentrant 호출에도 같은 promise를 반환한다", async () => {
    const session = new SessionDouble();
    session.command = async <T>(method: string): Promise<T> => {
      if (method === "Runtime.evaluate") {
        return {
          result: { type: "object", value: { scripts: [], stylesheets: [] } },
        } as T;
      }
      return undefined as T;
    };
    const collector = await beginPageResourceCollection(session);

    const pending = collector.finish();
    session.emit("Network.requestWillBeSent", {
      requestId: "late",
      type: "Script",
      request: { url: "https://example.test/late" },
    });
    session.emit("Network.loadingFailed", {
      requestId: "late",
      errorText: "late signal",
      canceled: false,
    });

    expect(collector.finish()).toBe(pending);
    expect((await pending).failedRequests).toEqual([]);
  });

  it("CDP가 상대 resource 값을 돌려주면 fail-closed로 거부한다", async () => {
    const session = new SessionDouble();
    session.command = async <T>(method: string): Promise<T> => {
      if (method === "Runtime.evaluate") {
        return {
          result: {
            type: "object",
            value: {
              scripts: ["relative.js"],
              stylesheets: [{ href: "styles/site.css", text: null }],
            },
          },
        } as T;
      }
      return undefined as T;
    };

    const collector = await beginPageResourceCollection(session);

    await expect(collector.finish()).rejects.toBeInstanceOf(TypeError);
  });

  it("CDP snapshot accessor를 실행하지 않고 TypeError로 거부한다", async () => {
    const session = new SessionDouble();
    const snapshot = { stylesheets: [] as unknown[] } as {
      scripts?: unknown;
      stylesheets: unknown[];
    };
    Object.defineProperty(snapshot, "scripts", {
      enumerable: true,
      get: () => {
        throw new Error("snapshot getter must not run");
      },
    });
    session.command = async <T>(method: string): Promise<T> => {
      if (method === "Runtime.evaluate") {
        return {
          result: { type: "object", value: snapshot },
        } as T;
      }
      return undefined as T;
    };

    const collector = await beginPageResourceCollection(session);

    await expect(collector.finish()).rejects.toBeInstanceOf(TypeError);
  });

  it("malformed network accessor는 listener 밖으로 예외를 내보내지 않는다", async () => {
    const session = new SessionDouble();
    const malformed = {} as Record<string, unknown>;
    Object.defineProperty(malformed, "requestId", {
      enumerable: true,
      get: () => {
        throw new Error("network getter must not escape");
      },
    });
    const collector = await beginPageResourceCollection(session);

    expect(() =>
      session.emit("Network.loadingFailed", malformed),
    ).not.toThrow();
    collector.dispose();
  });

  it("stylesheet와 script를 값으로만 첫 DOM 후보 순서대로 dedupe한다", async () => {
    const session = new SessionDouble();
    const firstLink = { href: "https://example.test/main.css", text: null };
    const duplicateLink = {
      href: "https://example.test/main.css",
      text: null,
    };
    const firstInline = { href: null, text: "body { color: red; }" };
    const duplicateInline = {
      href: null,
      text: "body { color: red; }",
    };
    const cssomOnly = { href: null, text: ".speedy { display: block; }" };
    session.command = async <T>(method: string): Promise<T> => {
      session.commands.push({ method });
      if (method === "Runtime.evaluate") {
        return {
          result: {
            type: "object",
            value: {
              scripts: [
                "https://example.test/a.js",
                "https://example.test/a.js",
                "https://example.test/b.js",
              ],
              stylesheets: [
                firstLink,
                duplicateLink,
                firstInline,
                duplicateInline,
                cssomOnly,
              ],
            },
          },
        } as T;
      }
      return undefined as T;
    };

    const result = await (await beginPageResourceCollection(session)).finish();
    firstLink.href = "https://mutated.test/main.css";
    firstInline.text = "mutated";

    expect(result).toEqual({
      scripts: ["https://example.test/a.js", "https://example.test/b.js"],
      stylesheets: [
        { href: "https://example.test/main.css", text: null },
        { href: null, text: "body { color: red; }" },
        { href: null, text: ".speedy { display: block; }" },
      ],
      failedRequests: [],
      pendingScripts: [],
    });
    expect(Object.isFrozen(result.stylesheets[0])).toBe(true);
  });

  it("HTTP와 loading failure를 query·credential 없이 각각 발생 횟수대로 보존한다", async () => {
    const session = new SessionDouble();
    session.command = async <T>(method: string): Promise<T> => {
      session.commands.push({ method });
      if (method === "Runtime.evaluate") {
        return {
          result: {
            type: "object",
            value: { scripts: [], stylesheets: [] },
          },
        } as T;
      }
      return undefined as T;
    };
    const collector = await beginPageResourceCollection(session);
    const request = (requestId: string, type: string): void => {
      session.emit("Network.requestWillBeSent", {
        requestId,
        type,
        request: {
          url: "https://user:secret@example.test/assets/app.js?token=secret#fragment",
        },
      });
    };
    request("failed-1", "Script");
    request("failed-2", "Script");
    request("http-404", "Stylesheet");
    request("http-500", "Stylesheet");
    session.emit("Network.loadingFailed", {
      requestId: "failed-1",
      errorText: "net::ERR_FAILED",
      blockedReason: " \r\ninspector\r ",
      canceled: false,
    });
    session.emit("Network.loadingFailed", {
      requestId: "failed-2",
      errorText: "net::ERR_FAILED",
      canceled: false,
    });
    session.emit("Network.responseReceived", {
      requestId: "http-404",
      response: { status: 404 },
    });
    session.emit("Network.responseReceived", {
      requestId: "http-500",
      response: { status: 500 },
    });

    const result = await collector.finish();

    expect(result.failedRequests).toEqual([
      {
        kind: "request-failed",
        text: "type=Script; path=/assets/app.js; error=net::ERR_FAILED; blocked=inspector; canceled=false",
      },
      {
        kind: "request-failed",
        text: "type=Script; path=/assets/app.js; error=net::ERR_FAILED; blocked=; canceled=false",
      },
      {
        kind: "http-error",
        text: "status=404; type=Stylesheet; path=/assets/app.js",
      },
      {
        kind: "http-error",
        text: "status=500; type=Stylesheet; path=/assets/app.js",
      },
    ]);
    expect(JSON.stringify(result.failedRequests)).not.toContain("secret");
    expect(JSON.stringify(result.failedRequests)).not.toContain("fragment");
  });

  it("type이 없는 requestWillBeSent도 추적해 실패 signal을 남긴다", async () => {
    const session = new SessionDouble();
    session.command = async <T>(method: string): Promise<T> => {
      if (method === "Runtime.evaluate") {
        return {
          result: { type: "object", value: { scripts: [], stylesheets: [] } },
        } as T;
      }
      return undefined as T;
    };
    const collector = await beginPageResourceCollection(session);
    // type은 protocol schema에서 optional이다 — 없다고 request 추적 자체를
    // 포기하면 이후의 모든 실패 신호가 조용히 사라진다.
    session.emit("Network.requestWillBeSent", {
      requestId: "no-type",
      request: { url: "https://example.test/app.js" },
    });
    session.emit("Network.loadingFailed", {
      requestId: "no-type",
      errorText: "net::ERR_FAILED",
      canceled: false,
    });

    expect((await collector.finish()).failedRequests).toEqual([
      {
        kind: "request-failed",
        text: "type=Other; path=/app.js; error=net::ERR_FAILED; blocked=; canceled=false",
      },
    ]);
  });

  it("canceled가 없는 loadingFailed도 canceled=false로 signal을 남긴다", async () => {
    const session = new SessionDouble();
    session.command = async <T>(method: string): Promise<T> => {
      if (method === "Runtime.evaluate") {
        return {
          result: { type: "object", value: { scripts: [], stylesheets: [] } },
        } as T;
      }
      return undefined as T;
    };
    const collector = await beginPageResourceCollection(session);
    session.emit("Network.requestWillBeSent", {
      requestId: "no-canceled",
      type: "Script",
      request: { url: "https://example.test/app.js" },
    });
    // canceled도 optional이므로 sibling인 blockedReason과 동일하게 관대하게 다룬다.
    session.emit("Network.loadingFailed", {
      requestId: "no-canceled",
      errorText: "net::ERR_FAILED",
    });

    expect((await collector.finish()).failedRequests).toEqual([
      {
        kind: "request-failed",
        text: "type=Script; path=/app.js; error=net::ERR_FAILED; blocked=; canceled=false",
      },
    ]);
  });

  it("type이 없는 request의 HTTP 오류도 placeholder type으로 보존한다", async () => {
    const session = new SessionDouble();
    session.command = async <T>(method: string): Promise<T> => {
      if (method === "Runtime.evaluate") {
        return {
          result: { type: "object", value: { scripts: [], stylesheets: [] } },
        } as T;
      }
      return undefined as T;
    };
    const collector = await beginPageResourceCollection(session);
    session.emit("Network.requestWillBeSent", {
      requestId: "http-404",
      request: { url: "https://example.test/gone" },
    });
    session.emit("Network.responseReceived", {
      requestId: "http-404",
      response: { status: 404 },
    });

    expect((await collector.finish()).failedRequests).toEqual([
      { kind: "http-error", text: "status=404; type=Other; path=/gone" },
    ]);
  });

  it("2xx/3xx response request는 loadingFinished에서만 정리되어 이후 stale terminal을 무시한다", async () => {
    const session = new SessionDouble();
    session.command = async <T>(method: string): Promise<T> => {
      if (method === "Runtime.evaluate") {
        return {
          result: { type: "object", value: { scripts: [], stylesheets: [] } },
        } as T;
      }
      return undefined as T;
    };
    const collector = await beginPageResourceCollection(session);
    for (const [requestId, status] of [
      ["ok", 200],
      ["redirect", 302],
    ] as const) {
      session.emit("Network.requestWillBeSent", {
        requestId,
        type: "Document",
        request: { url: "https://example.test/finished" },
      });
      session.emit("Network.responseReceived", {
        requestId,
        response: { status },
      });
      session.emit("Network.loadingFinished", { requestId });
      session.emit("Network.loadingFailed", {
        requestId,
        errorText: "stale terminal",
        canceled: false,
      });
    }

    expect((await collector.finish()).failedRequests).toEqual([]);
  });

  it("동일한 두 terminal failure occurrence와 event 사후 변경을 분리해 보존한다", async () => {
    const session = new SessionDouble();
    session.command = async <T>(method: string): Promise<T> => {
      if (method === "Runtime.evaluate") {
        return {
          result: { type: "object", value: { scripts: [], stylesheets: [] } },
        } as T;
      }
      return undefined as T;
    };
    const collector = await beginPageResourceCollection(session);
    for (const requestId of ["one", "two"]) {
      const request = {
        requestId,
        type: "Script",
        request: { url: "https://example.test/duplicated?secret=1" },
      };
      const failure = {
        requestId,
        errorText: "net::ERR_FAILED",
        blockedReason: "inspector",
        canceled: false,
      };
      session.emit("Network.requestWillBeSent", request);
      session.emit("Network.loadingFailed", failure);
      request.type = "Mutated";
      request.request.url = "https://mutated.test/leak";
      failure.errorText = "mutated";
    }

    const result = await collector.finish();
    expect(result.failedRequests).toEqual([
      {
        kind: "request-failed",
        text: "type=Script; path=/duplicated; error=net::ERR_FAILED; blocked=inspector; canceled=false",
      },
      {
        kind: "request-failed",
        text: "type=Script; path=/duplicated; error=net::ERR_FAILED; blocked=inspector; canceled=false",
      },
    ]);
  });

  it("dispose를 두 번 호출해도 command 없이 한번만 listener를 detach한다", async () => {
    const session = new SessionDouble();
    const collector = await beginPageResourceCollection(session);

    collector.dispose();
    collector.dispose();

    expect(session.listenerCount()).toBe(0);
    expect(session.commands.map((command) => command.method)).toEqual([
      "Network.enable",
    ]);
  });

  it("blob/filesystem nested URL과 data payload에서도 credential·query·fragment를 signal에 남기지 않는다", async () => {
    const session = new SessionDouble();
    session.command = async <T>(method: string): Promise<T> => {
      if (method === "Runtime.evaluate") {
        return {
          result: { type: "object", value: { scripts: [], stylesheets: [] } },
        } as T;
      }
      return undefined as T;
    };
    const collector = await beginPageResourceCollection(session);
    const urls = [
      "blob:https://user:secret@example.test/inner/path?token=secret#hash",
      "filesystem:https://user:secret@example.test/temporary/inner/path?token=secret#hash",
      "data:text/plain,secret?token=secret#hash",
    ];
    for (let index = 0; index < urls.length; index += 1) {
      const requestId = `request-${index}`;
      session.emit("Network.requestWillBeSent", {
        requestId,
        type: "Script",
        request: { url: urls[index] },
      });
      session.emit("Network.loadingFailed", {
        requestId,
        errorText: "net::ERR_FAILED",
        canceled: false,
      });
    }

    const result = await collector.finish();
    const text = JSON.stringify(result.failedRequests);

    expect(result.failedRequests.map((signal) => signal.text)).toEqual([
      "type=Script; path=/inner/path; error=net::ERR_FAILED; blocked=; canceled=false",
      "type=Script; path=/temporary/inner/path; error=net::ERR_FAILED; blocked=; canceled=false",
      "type=Script; path=data:; error=net::ERR_FAILED; blocked=; canceled=false",
    ]);
    expect(text).not.toContain("secret");
    expect(text).not.toContain("token");
    expect(text).not.toContain("hash");
  });

  it("연결이 끊긴 채로 Runtime.evaluate가 실패하면 degrade하지 않고 오류를 전파한다", async () => {
    const session = new SessionDouble();
    // cdp.ts는 연결 종료를 일반 Error로 알린다. 이 오류를 degrade로 삼키면
    // browser가 죽은 뒤의 page가 신호 0건 → pass로 보고된다.
    const failure = new Error("CDP connection closed (code=1006)");
    session.command = async (method: string): Promise<never> => {
      session.commands.push({ method });
      if (method === "Runtime.evaluate") return Promise.reject(failure);
      return undefined as never;
    };
    const collector = await beginPageResourceCollection(session);
    session.emit("Network.requestWillBeSent", {
      requestId: "first",
      type: "Script",
      request: { url: "https://example.test/app.js" },
    });
    session.emit("Network.loadingFailed", {
      requestId: "first",
      errorText: "net::ERR_FAILED",
      canceled: false,
    });

    await expect(collector.finish()).rejects.toBe(failure);

    expect(session.listenerCount()).toBe(0);
    collector.dispose();
    expect(session.commands.map((command) => command.method)).toEqual([
      "Network.enable",
      "Runtime.evaluate",
    ]);
  });

  it("Runtime.evaluate가 LBS_COMMAND_TIMEOUT으로 실패해도 degrade하지 않는다", async () => {
    const session = new SessionDouble();
    const failure = new LegacyBrowserSmokeError(
      "LBS_COMMAND_TIMEOUT",
      "CDP command Runtime.evaluate timed out after 30000ms",
    );
    session.command = async (method: string): Promise<never> => {
      session.commands.push({ method });
      if (method === "Runtime.evaluate") return Promise.reject(failure);
      return undefined as never;
    };
    const collector = await beginPageResourceCollection(session);

    await expect(collector.finish()).rejects.toBe(failure);

    expect(session.listenerCount()).toBe(0);
    collector.dispose();
    expect(session.commands.map((command) => command.method)).toEqual([
      "Network.enable",
      "Runtime.evaluate",
    ]);
  });

  it("evaluation-exception 모양의 CDP 응답도 listener를 해제한 채 빈 목록으로 degrade한다", async () => {
    const session = new SessionDouble();
    session.command = async <T>(method: string): Promise<T> => {
      session.commands.push({ method });
      if (method === "Runtime.evaluate") {
        return {
          result: { type: "object", subtype: "error" },
          exceptionDetails: { text: "Uncaught (in promise)" },
        } as T;
      }
      return undefined as T;
    };
    const collector = await beginPageResourceCollection(session);
    session.emit("Network.requestWillBeSent", {
      requestId: "first",
      type: "Script",
      request: { url: "https://example.test/app.js" },
    });
    session.emit("Network.loadingFailed", {
      requestId: "first",
      errorText: "net::ERR_FAILED",
      canceled: false,
    });

    const result = await collector.finish();

    expect(result).toEqual({
      scripts: [],
      stylesheets: [],
      failedRequests: [
        {
          kind: "request-failed",
          text: "type=Script; path=/app.js; error=net::ERR_FAILED; blocked=; canceled=false",
        },
      ],
      pendingScripts: [],
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.scripts)).toBe(true);
    expect(Object.isFrozen(result.stylesheets)).toBe(true);
    expect(session.listenerCount()).toBe(0);
    collector.dispose();
    expect(session.commands.map((command) => command.method)).toEqual([
      "Network.enable",
      "Runtime.evaluate",
    ]);
  });

  it("Chromium 75 호환 DOM expression은 stylesheet text와 CSSOM을 값으로 합친다", async () => {
    const inaccessible = { tagName: "STYLE", textContent: "ignored" } as {
      tagName: string;
      textContent: string;
      sheet?: unknown;
    };
    Object.defineProperty(inaccessible, "sheet", {
      get: () => {
        throw new Error("SecurityError");
      },
    });
    const documentDouble = {
      querySelectorAll: () => [
        { tagName: "SCRIPT", src: "https://example.test/a.js" },
        { tagName: "SCRIPT", src: "https://example.test/a.js" },
        { tagName: "SCRIPT", src: "https://example.test/b.js" },
        {
          tagName: "LINK",
          rel: "preload stylesheet",
          href: "https://example.test/main.css",
        },
        {
          tagName: "STYLE",
          textContent: "body { color: red; }",
          sheet: { cssRules: [{ cssText: "body { color: red; }" }] },
        },
        {
          tagName: "STYLE",
          textContent: "",
          sheet: { cssRules: [{ cssText: ".speedy { display: block; }" }] },
        },
        inaccessible,
      ],
    };
    const session = new SessionDouble();
    session.command = async <T>(
      method: string,
      params?: object,
    ): Promise<T> => {
      session.commands.push({ method, params });
      if (method === "Runtime.evaluate") {
        const evaluate = params as {
          expression: string;
          returnByValue: boolean;
        };
        expect(evaluate.returnByValue).toBe(true);
        const value = Function(
          "document",
          `"use strict"; return (${evaluate.expression});`,
        )(documentDouble);
        return { result: { type: "object", value } } as T;
      }
      return undefined as T;
    };

    const result = await (await beginPageResourceCollection(session)).finish();

    expect(result).toEqual({
      scripts: ["https://example.test/a.js", "https://example.test/b.js"],
      stylesheets: [
        { href: "https://example.test/main.css", text: null },
        { href: null, text: "body { color: red; }" },
        { href: null, text: ".speedy { display: block; }" },
        { href: null, text: "ignored" },
      ],
      failedRequests: [],
      pendingScripts: [],
    });
  });
});

describe("waitForScriptSettle과 pendingScripts", () => {
  const scriptRequest = (requestId: string, path: string): object => ({
    requestId,
    type: "Script",
    request: { url: `http://127.0.0.1${path}` },
  });

  it("추적 중인 Script 요청이 없으면 즉시 resolve한다", async () => {
    const session = new SessionDouble();
    const timers = new FakeTimers();
    const collector = await beginPageResourceCollection(session);

    await collector.waitForScriptSettle(startDeadline(timers, 500));

    collector.dispose();
  });

  it("모든 Script 요청이 terminal이 되는 순간 resolve하고 pendingScripts는 비어 있다", async () => {
    const session = new SessionDouble();
    const timers = new FakeTimers();
    const collector = await beginPageResourceCollection(session);
    session.emit("Network.requestWillBeSent", scriptRequest("s1", "/a.js"));
    session.emit("Network.requestWillBeSent", scriptRequest("s2", "/b.js"));

    let settled = false;
    const waiting = collector
      .waitForScriptSettle(startDeadline(timers, 500))
      .then(() => {
        settled = true;
      });
    await Promise.resolve();
    expect(settled).toBe(false);

    session.emit("Network.loadingFinished", { requestId: "s1" });
    await Promise.resolve();
    expect(settled).toBe(false);

    session.emit("Network.loadingFailed", {
      requestId: "s2",
      errorText: "net::ERR_FAILED",
    });
    await waiting;

    const resources = await collector.finish();
    expect(resources.pendingScripts).toEqual([]);
  });

  it("status 400 이상 응답도 Script terminal로 취급하며 기존 http-error 신호는 유지된다", async () => {
    const session = new SessionDouble();
    const timers = new FakeTimers();
    const collector = await beginPageResourceCollection(session);
    session.emit("Network.requestWillBeSent", scriptRequest("s1", "/a.js"));
    session.emit("Network.responseReceived", {
      requestId: "s1",
      response: { status: 404 },
    });

    await collector.waitForScriptSettle(startDeadline(timers, 500));
    const resources = await collector.finish();

    expect(resources.pendingScripts).toEqual([]);
    expect(resources.failedRequests).toEqual([
      { kind: "http-error", text: "status=404; type=Script; path=/a.js" },
    ]);
  });

  it("deadline이 만료되면 resolve하고 미완료 Script는 finish에서 script-pending 신호가 된다", async () => {
    const session = new SessionDouble();
    const timers = new FakeTimers();
    const collector = await beginPageResourceCollection(session);
    session.emit("Network.requestWillBeSent", scriptRequest("s1", "/slow.js"));

    const deadline = startDeadline(timers, 500);
    const waiting = collector.waitForScriptSettle(deadline);
    timers.fire(500);
    await waiting;

    const resources = await collector.finish();
    expect(resources.pendingScripts).toEqual([
      { kind: "script-pending", text: "path=/slow.js" },
    ]);
  });

  it("Script가 아닌 요청은 settle 대기와 pendingScripts에 영향을 주지 않는다", async () => {
    const session = new SessionDouble();
    const timers = new FakeTimers();
    const collector = await beginPageResourceCollection(session);
    session.emit("Network.requestWillBeSent", {
      requestId: "img1",
      type: "Image",
      request: { url: "http://127.0.0.1/img.png" },
    });

    await collector.waitForScriptSettle(startDeadline(timers, 500));
    const resources = await collector.finish();

    expect(resources.pendingScripts).toEqual([]);
  });

  it("settle 대기 중 시작된 Script 요청도 완료될 때까지 함께 기다린다", async () => {
    const session = new SessionDouble();
    const timers = new FakeTimers();
    const collector = await beginPageResourceCollection(session);
    session.emit("Network.requestWillBeSent", scriptRequest("s1", "/a.js"));

    let settled = false;
    const waiting = collector
      .waitForScriptSettle(startDeadline(timers, 500))
      .then(() => {
        settled = true;
      });
    session.emit("Network.requestWillBeSent", scriptRequest("s2", "/late.js"));
    session.emit("Network.loadingFinished", { requestId: "s1" });
    await Promise.resolve();
    expect(settled).toBe(false);

    session.emit("Network.loadingFinished", { requestId: "s2" });
    await waiting;
    collector.dispose();
  });

  it("dispose는 대기 중인 settle waiter를 resolve해 영원히 매달리지 않게 한다", async () => {
    const session = new SessionDouble();
    const timers = new FakeTimers();
    const collector = await beginPageResourceCollection(session);
    session.emit("Network.requestWillBeSent", scriptRequest("s1", "/a.js"));

    const waiting = collector.waitForScriptSettle(startDeadline(timers, 500));
    collector.dispose();
    await waiting;
  });
});
