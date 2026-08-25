import { createHash } from "node:crypto";
import type { BrowserBaseline } from "./baseline.js";
import type { NormalizedConfig } from "./config.js";
import {
  NEXT_WEBPACK_BASELINE_ERROR_CODES,
  NextWebpackBaselineError,
} from "./errors.js";
import { analyzeSyntax } from "./syntax.js";
import type { SyntaxDiagnostic } from "./syntax.js";
import { createVerdict } from "./verdict.js";

const PLUGIN_NAME = "NextWebpackBaselinePlugin";

export interface WebpackPluginInput {
  readonly config: NormalizedConfig;
  readonly baseline: BrowserBaseline;
}

export interface WebpackPluginOptions {
  readonly dev: boolean;
}

export interface WebpackPluginInstance {
  apply(compiler: { readonly hooks: object }): void;
}

interface CompilationHook {
  readonly tap: (
    name: string,
    callback: (compilation: unknown) => void,
  ) => unknown;
}

interface AfterSealHook {
  readonly tap: (name: string, callback: () => void) => unknown;
}

interface WebpackModule {
  readonly resource?: unknown;
  readonly type?: unknown;
  readonly modules?: unknown;
  readonly originalSource?: unknown;
}

interface WebpackChunkGraph {
  readonly getModuleChunks: (module: WebpackModule) => unknown;
}

interface WebpackEntrypoints {
  readonly get: (name: string) => unknown;
}

interface WebpackCompilation {
  readonly modules: Iterable<WebpackModule>;
  readonly chunkGraph: WebpackChunkGraph;
  readonly entrypoints: WebpackEntrypoints;
  readonly hooks: { readonly afterSeal: AfterSealHook };
  readonly errors: Error[];
}

interface PendingError {
  readonly sortKey: string;
  readonly error: NextWebpackBaselineError;
}

const isObject = (value: unknown): value is Record<PropertyKey, unknown> =>
  typeof value === "object" && value !== null;

const unsupportedWebpack = (message: string): never => {
  throw new NextWebpackBaselineError(
    NEXT_WEBPACK_BASELINE_ERROR_CODES.WEBPACK_UNSUPPORTED,
    message,
  );
};

const withinWebpackBoundary = <T>(message: string, operation: () => T): T => {
  try {
    return operation();
  } catch (cause) {
    if (cause instanceof NextWebpackBaselineError) throw cause;
    return unsupportedWebpack(message);
  }
};

const isIterable = (value: unknown): value is Iterable<unknown> => {
  if (!isObject(value)) return false;
  try {
    return typeof value[Symbol.iterator] === "function";
  } catch (cause) {
    if (cause instanceof NextWebpackBaselineError) throw cause;
    return false;
  }
};

const readCompilationHook = (compiler: unknown): CompilationHook => {
  if (!isObject(compiler)) {
    return unsupportedWebpack("compiler hooks를 사용할 수 없습니다.");
  }
  try {
    const hooks = compiler.hooks;
    if (!isObject(hooks)) {
      return unsupportedWebpack("compiler hooks를 사용할 수 없습니다.");
    }
    const hook = hooks.compilation;
    if (!isObject(hook) || typeof hook.tap !== "function") {
      return unsupportedWebpack(
        "public compilation hook을 사용할 수 없습니다.",
      );
    }
    return hook as unknown as CompilationHook;
  } catch (cause) {
    if (cause instanceof NextWebpackBaselineError) throw cause;
    return unsupportedWebpack("compiler hooks를 읽을 수 없습니다.");
  }
};

const readAfterSealHook = (compilation: unknown): AfterSealHook => {
  if (!isObject(compilation)) {
    return unsupportedWebpack("public afterSeal hook을 사용할 수 없습니다.");
  }
  try {
    const hooks = compilation.hooks;
    const afterSeal = isObject(hooks) ? hooks.afterSeal : undefined;
    if (!isObject(afterSeal) || typeof afterSeal.tap !== "function") {
      return unsupportedWebpack("public afterSeal hook을 사용할 수 없습니다.");
    }
    return afterSeal as unknown as AfterSealHook;
  } catch (cause) {
    if (cause instanceof NextWebpackBaselineError) throw cause;
    return unsupportedWebpack("public afterSeal hook을 읽을 수 없습니다.");
  }
};

const targetValues = (target: unknown): readonly string[] => {
  if (typeof target === "string") return [target];
  if (!Array.isArray(target)) return [];
  return target.filter((value): value is string => typeof value === "string");
};

/** Next가 Webpack의 public config에 지정한 client/server 단서를 사용한다. */
const isClientCompiler = (compiler: unknown): boolean => {
  if (!isObject(compiler)) {
    return unsupportedWebpack("compiler options를 사용할 수 없습니다.");
  }
  try {
    const options = compiler.options;
    if (!isObject(options)) {
      return unsupportedWebpack("compiler options를 사용할 수 없습니다.");
    }

    const name = options.name;
    if (name === "client") return true;
    if (name === "server" || name === "edge-server") return false;

    const externalsPresets = options.externalsPresets;
    if (isObject(externalsPresets) && externalsPresets.node === true)
      return false;

    const targets = targetValues(options.target);
    if (targets.some((target) => target.includes("node"))) return false;
    if (targets.some((target) => target === "web")) return true;

    return unsupportedWebpack(
      "client Webpack compilation인지 public config로 확인할 수 없습니다.",
    );
  } catch (cause) {
    if (cause instanceof NextWebpackBaselineError) throw cause;
    return unsupportedWebpack("compiler options를 읽을 수 없습니다.");
  }
};

const readCompilation = (value: unknown): WebpackCompilation => {
  if (!isObject(value)) {
    return unsupportedWebpack("compilation 객체를 사용할 수 없습니다.");
  }
  try {
    const modules = value.modules;
    if (!isIterable(modules)) {
      return unsupportedWebpack("compilation modules를 순회할 수 없습니다.");
    }
    const moduleSnapshot: WebpackModule[] = [];
    for (const module of modules) {
      if (!isObject(module)) {
        return unsupportedWebpack(
          "compilation module 형상을 지원할 수 없습니다.",
        );
      }
      moduleSnapshot.push(module);
    }

    const chunkGraph = value.chunkGraph;
    const getModuleChunks = isObject(chunkGraph)
      ? chunkGraph.getModuleChunks
      : undefined;
    if (!isObject(chunkGraph) || typeof getModuleChunks !== "function") {
      return unsupportedWebpack("public chunk graph를 사용할 수 없습니다.");
    }

    const entrypoints = value.entrypoints;
    const getEntrypoint = isObject(entrypoints) ? entrypoints.get : undefined;
    if (!isObject(entrypoints) || typeof getEntrypoint !== "function") {
      return unsupportedWebpack("public entrypoints를 사용할 수 없습니다.");
    }

    const hooks = value.hooks;
    const afterSeal = isObject(hooks) ? hooks.afterSeal : undefined;
    const tapAfterSeal = isObject(afterSeal) ? afterSeal.tap : undefined;
    if (!isObject(afterSeal) || typeof tapAfterSeal !== "function") {
      return unsupportedWebpack("public afterSeal hook을 사용할 수 없습니다.");
    }

    const errors = value.errors;
    if (!Array.isArray(errors)) {
      return unsupportedWebpack("compilation errors를 사용할 수 없습니다.");
    }

    return {
      modules: moduleSnapshot,
      chunkGraph: {
        getModuleChunks: (module) => getModuleChunks.call(chunkGraph, module),
      },
      entrypoints: {
        get: (name) => getEntrypoint.call(entrypoints, name),
      },
      hooks: {
        afterSeal: {
          tap: (name, callback) => tapAfterSeal.call(afterSeal, name, callback),
        },
      },
      errors,
    };
  } catch (cause) {
    if (cause instanceof NextWebpackBaselineError) throw cause;
    return unsupportedWebpack("public compilation 형상을 읽을 수 없습니다.");
  }
};

/**
 * Webpack public Module type에는 합성 module의 inner-module 열거 API가 없다.
 * class/path를 식별하지 않고 structural iterable만 지원하며 형상이 달라지면 fail-closed 한다.
 */
const sourceUnitsOf = function* (
  module: WebpackModule,
): Generator<WebpackModule> {
  const hasNestedModules = withinWebpackBoundary(
    "inner module container를 확인할 수 없습니다.",
    () => "modules" in module,
  );
  if (hasNestedModules) {
    const nestedModules = withinWebpackBoundary(
      "inner module container를 읽을 수 없습니다.",
      () => module.modules,
    );
    if (!isIterable(nestedModules)) {
      return unsupportedWebpack("inner module container를 순회할 수 없습니다.");
    }
    let found = false;
    try {
      for (const child of nestedModules) {
        if (!isObject(child)) {
          return unsupportedWebpack("inner module 형상을 지원할 수 없습니다.");
        }
        found = true;
        yield child;
      }
    } catch (cause) {
      if (cause instanceof NextWebpackBaselineError) throw cause;
      return unsupportedWebpack("inner module container를 순회할 수 없습니다.");
    }
    if (!found)
      return unsupportedWebpack("inner module container가 비어 있습니다.");
    return;
  }
  yield module;
};

type LoaderSourceResult =
  | { readonly kind: "available"; readonly source: string }
  | { readonly kind: "unavailable" };

const loaderSourceOf = (module: WebpackModule): LoaderSourceResult => {
  try {
    const originalSource = module.originalSource;
    if (typeof originalSource !== "function") {
      return { kind: "unavailable" };
    }
    const source = originalSource.call(module);
    if (!isObject(source) || typeof source.source !== "function") {
      return { kind: "unavailable" };
    }
    const value = source.source();
    if (typeof value === "string") return { kind: "available", source: value };
    if (value instanceof Uint8Array) {
      return {
        kind: "available",
        source: Buffer.from(value).toString("utf8"),
      };
    }
    return { kind: "unavailable" };
  } catch {
    return { kind: "unavailable" };
  }
};

const parentsOf = (group: unknown): readonly unknown[] => {
  if (!isObject(group)) {
    return unsupportedWebpack(
      "public chunk group parent API를 사용할 수 없습니다.",
    );
  }
  try {
    const getParents = group.getParents;
    if (typeof getParents !== "function") {
      return unsupportedWebpack(
        "public chunk group parent API를 사용할 수 없습니다.",
      );
    }
    const parents = getParents.call(group);
    if (!isIterable(parents)) {
      return unsupportedWebpack("chunk group parents를 순회할 수 없습니다.");
    }
    return [...parents];
  } catch (cause) {
    if (cause instanceof NextWebpackBaselineError) throw cause;
    return unsupportedWebpack("chunk group parents를 읽을 수 없습니다.");
  }
};

const groupsOf = (chunk: unknown): readonly unknown[] => {
  if (!isObject(chunk)) {
    return unsupportedWebpack("public chunk groups를 순회할 수 없습니다.");
  }
  try {
    const groups = chunk.groupsIterable;
    if (!isIterable(groups)) {
      return unsupportedWebpack("public chunk groups를 순회할 수 없습니다.");
    }
    return [...groups];
  } catch (cause) {
    if (cause instanceof NextWebpackBaselineError) throw cause;
    return unsupportedWebpack("public chunk groups를 읽을 수 없습니다.");
  }
};

const readModuleChunks = (
  chunkGraph: WebpackChunkGraph,
  module: WebpackModule,
): Iterable<unknown> => {
  try {
    const chunks = chunkGraph.getModuleChunks(module);
    if (!isIterable(chunks)) {
      return unsupportedWebpack("module chunks를 순회할 수 없습니다.");
    }
    return [...chunks];
  } catch (cause) {
    if (cause instanceof NextWebpackBaselineError) throw cause;
    return unsupportedWebpack("module chunks를 읽을 수 없습니다.");
  }
};

const isPagesClientReachable = (
  chunks: Iterable<unknown>,
  entrypoints: WebpackEntrypoints,
): boolean => {
  const queue = [...chunks].flatMap(groupsOf);
  const visited = new Set<unknown>();

  while (queue.length > 0) {
    const group = queue.pop();
    if (!isObject(group) || visited.has(group)) continue;
    visited.add(group);

    const name = withinWebpackBoundary(
      "chunk group name을 읽을 수 없습니다.",
      () => group.name,
    );
    const isEntrypoint =
      typeof name === "string" &&
      withinWebpackBoundary(
        "public entrypoints를 읽을 수 없습니다.",
        () => entrypoints.get(name) === group,
      );
    if (isEntrypoint) {
      if (name.startsWith("pages/")) return true;
      continue;
    }
    queue.push(...parentsOf(group));
  }
  return false;
};

const contentHash = (source: string): string =>
  createHash("sha256").update(source).digest("hex");

const createDiagnosticError = (
  packageName: string,
  entrypoint: string,
  diagnostic: SyntaxDiagnostic,
): NextWebpackBaselineError =>
  new NextWebpackBaselineError(
    diagnostic.code,
    `${packageName}/${entrypoint}: ${diagnostic.message}`,
  );

const createSourceUnavailableError = (
  packageName: string,
  entrypoint: string,
): NextWebpackBaselineError =>
  new NextWebpackBaselineError(
    NEXT_WEBPACK_BASELINE_ERROR_CODES.WEBPACK_UNSUPPORTED,
    `${packageName}/${entrypoint}: loader 처리 후 JavaScript source를 읽을 수 없습니다.`,
  );

const inspectCompilation = (
  compilation: WebpackCompilation,
  input: WebpackPluginInput,
  cacheNamespace: "development" | "production",
): void => {
  const analyzed = new Set<string>();
  const unavailableSources = new Set<string>();
  const pending: PendingError[] = [];

  for (const module of compilation.modules) {
    const chunks = readModuleChunks(compilation.chunkGraph, module);
    const isClientEntryReachable = isPagesClientReachable(
      chunks,
      compilation.entrypoints,
    );
    if (!isClientEntryReachable) continue;

    for (const unit of sourceUnitsOf(module)) {
      const { resource, type } = withinWebpackBoundary(
        "module resource/type을 읽을 수 없습니다.",
        () => ({ resource: unit.resource, type: unit.type }),
      );
      if (typeof resource !== "string" || resource === "") continue;
      if (typeof type !== "string" || !type.startsWith("javascript/")) {
        continue;
      }
      const eligibility = createVerdict({
        config: input.config,
        resource,
        syntax: { diagnostics: [] },
        isClientEntryReachable,
      });
      if (eligibility.status === "ignored") continue;
      if (eligibility.resource === undefined) {
        return unsupportedWebpack("module verdict resource가 없습니다.");
      }

      const loaded = loaderSourceOf(unit);
      if (loaded.kind === "unavailable") {
        const unavailableKey = `${eligibility.resource.package}\u0000${eligibility.resource.entrypoint}`;
        if (!unavailableSources.has(unavailableKey)) {
          unavailableSources.add(unavailableKey);
          pending.push({
            sortKey: `${unavailableKey}\u0000${NEXT_WEBPACK_BASELINE_ERROR_CODES.WEBPACK_UNSUPPORTED}`,
            error: createSourceUnavailableError(
              eligibility.resource.package,
              eligibility.resource.entrypoint,
            ),
          });
        }
        continue;
      }
      const source = loaded.source;

      const hash = contentHash(source);
      const analysisKey = `${cacheNamespace}\u0000${resource}\u0000${hash}`;
      if (analyzed.has(analysisKey)) continue;
      analyzed.add(analysisKey);

      const verdict = createVerdict({
        config: input.config,
        resource,
        syntax: analyzeSyntax(source, input.baseline),
        isClientEntryReachable,
      });
      if (verdict.status !== "fail" || verdict.resource === undefined) continue;

      for (const diagnostic of verdict.diagnostics) {
        const sortKey = [
          verdict.resource.package,
          verdict.resource.entrypoint,
          diagnostic.code,
          diagnostic.feature ?? "",
          diagnostic.message,
          hash,
        ].join("\u0000");
        pending.push({
          sortKey,
          error: createDiagnosticError(
            verdict.resource.package,
            verdict.resource.entrypoint,
            diagnostic,
          ),
        });
      }
    }
  }

  pending.sort((left, right) =>
    left.sortKey < right.sortKey ? -1 : left.sortKey > right.sortKey ? 1 : 0,
  );
  withinWebpackBoundary("compilation errors를 갱신할 수 없습니다.", () => {
    Array.prototype.push.call(
      compilation.errors,
      ...pending.map(({ error }) => error),
    );
  });
};

export const createWebpackPlugin = (
  input: WebpackPluginInput,
  options: WebpackPluginOptions,
): WebpackPluginInstance => {
  const cacheNamespace = options.dev ? "development" : "production";
  return {
    apply(compiler) {
      const compilationHook = readCompilationHook(compiler);
      if (!isClientCompiler(compiler)) return;

      withinWebpackBoundary(
        "public compilation hook을 등록할 수 없습니다.",
        () => {
          compilationHook.tap(PLUGIN_NAME, (value) => {
            const afterSealHook = readAfterSealHook(value);
            withinWebpackBoundary(
              "public afterSeal hook을 등록할 수 없습니다.",
              () => {
                afterSealHook.tap(PLUGIN_NAME, () => {
                  const compilation = readCompilation(value);
                  inspectCompilation(compilation, input, cacheNamespace);
                });
              },
            );
          });
        },
      );
    },
  };
};
