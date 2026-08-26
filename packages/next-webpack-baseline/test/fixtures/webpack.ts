interface SyncHook<T> {
  readonly tap: (name: string, callback: (value: T) => void) => void;
  readonly call: (value: T) => void;
}

interface VoidSyncHook {
  readonly tap: (name: string, callback: () => void) => void;
  readonly call: () => void;
}

const createSyncHook = <T>(): SyncHook<T> => {
  const callbacks: Array<(value: T) => void> = [];
  return {
    tap(_name, callback) {
      callbacks.push(callback);
    },
    call(value) {
      for (const callback of callbacks) callback(value);
    },
  };
};

const createVoidSyncHook = (): VoidSyncHook => {
  const callbacks: Array<() => void> = [];
  return {
    tap(_name, callback) {
      callbacks.push(callback);
    },
    call() {
      for (const callback of callbacks) callback();
    },
  };
};

export interface WebpackModuleDefinition {
  readonly resource?: unknown;
  /** webpack `<matchResource>!=!<request>` 문법의 matchResource. nameForCondition()이 resource 대신 이 값을 사용한다. */
  readonly matchResource?: string;
  readonly loaderSource:
    string | Uint8Array | null | { readonly unsupported: true };
  readonly beforeLoadersSource?: string;
  readonly entrypoints: readonly string[];
  readonly sourceFailure?:
    "missing-original-source" | "original-source-throws" | "source-throws";
  readonly resourceShape?: "getter-throws";
  readonly conditionNameShape?:
    "missing" | "getter-throws" | "call-throws" | "non-string";
  readonly typeShape?: "getter-throws";
  readonly children?: readonly WebpackModuleDefinition[];
  readonly nestedModulesShape?:
    "non-iterable" | "throws" | "iterator-getter-throws";
  readonly groupShape?:
    | "missing-groups"
    | "missing-parents"
    | "primitive-group-element"
    | "primitive-parent-element"
    | "groups-getter-throws"
    | "parents-getter-throws"
    | "name-getter-throws";
}

export interface ObservedWebpackModule {
  readonly resource?: unknown;
  readonly nameForCondition?: unknown;
  readonly type: string;
  readonly beforeLoadersSource?: string;
  readonly originalSource?: () => {
    readonly source: () => unknown;
  } | null;
  readonly modules?: unknown;
  readonly sourceReads: number;
}

interface ChunkGroup {
  readonly name?: string;
  readonly getParents?: () => unknown;
}

interface Chunk {
  readonly groupsIterable?: unknown;
}

interface WebpackChunkGraphDouble {
  readonly getModuleChunks: (module: ObservedWebpackModule) => unknown;
}

interface WebpackEntrypointsDouble {
  readonly get: (name: string) => unknown;
}

export interface WebpackCompilationDouble {
  readonly modules: Iterable<ObservedWebpackModule>;
  readonly chunkGraph: WebpackChunkGraphDouble | undefined;
  readonly entrypoints: WebpackEntrypointsDouble;
  readonly hooks: { readonly afterSeal: VoidSyncHook };
  readonly errors: Error[];
  readonly warnings: Error[];
}

export interface WebpackCompilerDouble {
  readonly options: { readonly target: string };
  readonly hooks: {
    readonly compilation: SyncHook<WebpackCompilationDouble>;
  };
}

export interface WebpackFixture {
  readonly compiler: WebpackCompilerDouble;
  readonly compilation: WebpackCompilationDouble;
  readonly modules: readonly ObservedWebpackModule[];
  readonly run: () => readonly Error[];
}

export const createWebpackFixture = ({
  target = "web",
  modules: definitions,
  chunkGraphTiming = "compilation",
  moduleChunksShape = "iterable",
  entrypointsShape = "map",
}: {
  readonly target?: "web" | "node";
  readonly modules: readonly WebpackModuleDefinition[];
  readonly chunkGraphTiming?: "compilation" | "after-seal";
  readonly moduleChunksShape?:
    "iterable" | "non-iterable" | "method-getter-throws";
  readonly entrypointsShape?: "map" | "get-throws" | "primitive-result";
}): WebpackFixture => {
  const entrypoints = new Map<string, ChunkGroup>();
  for (const definition of definitions) {
    for (const name of definition.entrypoints) {
      if (!entrypoints.has(name)) {
        entrypoints.set(name, { name, getParents: () => [] });
      }
    }
  }

  const chunksByModule = new Map<ObservedWebpackModule, readonly Chunk[]>();
  const createObservedModule = (
    definition: WebpackModuleDefinition,
  ): ObservedWebpackModule => {
    let sourceReads = 0;
    let module: ObservedWebpackModule = {
      ...(Object.hasOwn(definition, "resource")
        ? { resource: definition.resource }
        : {}),
      ...(definition.beforeLoadersSource === undefined
        ? {}
        : { beforeLoadersSource: definition.beforeLoadersSource }),
      type: "javascript/auto",
      ...(definition.conditionNameShape === "missing"
        ? {}
        : {
            nameForCondition: () => {
              if (definition.conditionNameShape === "call-throws") {
                throw new Error("fixture condition name call sentinel");
              }
              if (definition.conditionNameShape === "non-string") return 42;
              // NormalModule.nameForCondition()과 동일: matchResource 우선, 첫 query 앞에서 자른다.
              const conditionSource =
                definition.matchResource ?? definition.resource;
              return typeof conditionSource === "string"
                ? conditionSource.split("?", 1)[0]
                : null;
            },
          }),
      ...(definition.sourceFailure === "missing-original-source"
        ? {}
        : {
            originalSource: () => {
              sourceReads += 1;
              if (definition.sourceFailure === "original-source-throws") {
                throw new Error("fixture originalSource failure");
              }
              if (definition.loaderSource === null) return null;
              return {
                source: () => {
                  if (definition.sourceFailure === "source-throws") {
                    throw new Error("fixture source failure");
                  }
                  return definition.loaderSource;
                },
              };
            },
          }),
      get sourceReads() {
        return sourceReads;
      },
    };

    if (definition.resourceShape === "getter-throws") {
      Object.defineProperty(module, "resource", {
        get() {
          throw new Error("fixture resource getter sentinel");
        },
      });
    }
    if (definition.conditionNameShape === "getter-throws") {
      Object.defineProperty(module, "nameForCondition", {
        get() {
          throw new Error("fixture condition name getter sentinel");
        },
      });
    }
    if (definition.typeShape === "getter-throws") {
      Object.defineProperty(module, "type", {
        get() {
          throw new Error("fixture type getter sentinel");
        },
      });
    }

    if (definition.children !== undefined) {
      module = {
        ...module,
        modules: definition.children.map(createObservedModule),
      };
    } else if (definition.nestedModulesShape === "non-iterable") {
      module = { ...module, modules: {} };
    } else if (definition.nestedModulesShape === "throws") {
      Object.defineProperty(module, "modules", {
        get() {
          throw new Error("fixture nested modules failure");
        },
      });
    } else if (definition.nestedModulesShape === "iterator-getter-throws") {
      const nestedModules = {};
      Object.defineProperty(nestedModules, Symbol.iterator, {
        get() {
          throw new Error("fixture nested iterator sentinel");
        },
      });
      module = { ...module, modules: nestedModules };
    }
    return module;
  };

  const modules = definitions.map((definition): ObservedWebpackModule => {
    const module = createObservedModule(definition);

    const parents = definition.entrypoints.flatMap((name) => {
      const entrypoint = entrypoints.get(name);
      return entrypoint === undefined ? [] : [entrypoint];
    });
    const moduleGroup: ChunkGroup = {};
    if (definition.groupShape === "parents-getter-throws") {
      Object.defineProperty(moduleGroup, "getParents", {
        get() {
          throw new Error("fixture parents getter sentinel");
        },
      });
    } else if (definition.groupShape !== "missing-parents") {
      Object.defineProperty(moduleGroup, "getParents", {
        value: () =>
          definition.groupShape === "primitive-parent-element" ? [42] : parents,
      });
    }
    if (definition.groupShape === "name-getter-throws") {
      Object.defineProperty(moduleGroup, "name", {
        get() {
          throw new Error("fixture group name getter sentinel");
        },
      });
    }

    const chunk: Chunk = {};
    if (definition.groupShape === "groups-getter-throws") {
      Object.defineProperty(chunk, "groupsIterable", {
        get() {
          throw new Error("fixture groups getter sentinel");
        },
      });
    } else if (definition.groupShape !== "missing-groups") {
      Object.defineProperty(chunk, "groupsIterable", {
        value:
          definition.entrypoints.length === 0
            ? []
            : definition.groupShape === "primitive-group-element"
              ? [42]
              : [moduleGroup],
      });
    }
    chunksByModule.set(module, [chunk]);
    return module;
  });

  const afterSeal = createVoidSyncHook();
  const chunkGraph = {} as WebpackChunkGraphDouble;
  if (moduleChunksShape === "method-getter-throws") {
    Object.defineProperty(chunkGraph, "getModuleChunks", {
      get() {
        throw new Error("fixture module chunks getter sentinel");
      },
    });
  } else {
    Object.defineProperty(chunkGraph, "getModuleChunks", {
      value: (module: ObservedWebpackModule) =>
        moduleChunksShape === "iterable"
          ? (chunksByModule.get(module) ?? [])
          : undefined,
    });
  }
  let activeChunkGraph =
    chunkGraphTiming === "compilation" ? chunkGraph : undefined;
  let exposedEntrypoints: WebpackEntrypointsDouble = entrypoints;
  if (entrypointsShape === "get-throws") {
    exposedEntrypoints = {
      get() {
        throw new Error("fixture entrypoints get sentinel");
      },
    };
  } else if (entrypointsShape === "primitive-result") {
    exposedEntrypoints = { get: () => 42 };
  }
  const compilation: WebpackCompilationDouble = {
    modules,
    get chunkGraph() {
      return activeChunkGraph;
    },
    entrypoints: exposedEntrypoints,
    hooks: { afterSeal },
    errors: [],
    warnings: [],
  };
  const compilationHook = createSyncHook<WebpackCompilationDouble>();
  const compiler: WebpackCompilerDouble = {
    options: { target },
    hooks: { compilation: compilationHook },
  };

  return {
    compiler,
    compilation,
    modules,
    run() {
      compilationHook.call(compilation);
      activeChunkGraph = chunkGraph;
      afterSeal.call();
      return compilation.errors;
    },
  };
};
