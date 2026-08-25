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
  readonly loaderSource:
    string | Uint8Array | null | { readonly unsupported: true };
  readonly beforeLoadersSource?: string;
  readonly entrypoints: readonly string[];
  readonly sourceFailure?:
    "missing-original-source" | "original-source-throws" | "source-throws";
  readonly children?: readonly WebpackModuleDefinition[];
  readonly nestedModulesShape?: "non-iterable" | "throws";
  readonly groupShape?: "missing-groups" | "missing-parents";
}

export interface ObservedWebpackModule {
  readonly resource?: unknown;
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

export interface WebpackCompilationDouble {
  readonly modules: Iterable<ObservedWebpackModule>;
  readonly chunkGraph: WebpackChunkGraphDouble | undefined;
  readonly entrypoints: ReadonlyMap<string, ChunkGroup>;
  readonly hooks: { readonly afterSeal: VoidSyncHook };
  readonly errors: Error[];
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
}: {
  readonly target?: "web" | "node";
  readonly modules: readonly WebpackModuleDefinition[];
  readonly chunkGraphTiming?: "compilation" | "after-seal";
  readonly moduleChunksShape?: "iterable" | "non-iterable";
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
    }
    return module;
  };

  const modules = definitions.map((definition): ObservedWebpackModule => {
    const module = createObservedModule(definition);

    const parents = definition.entrypoints.flatMap((name) => {
      const entrypoint = entrypoints.get(name);
      return entrypoint === undefined ? [] : [entrypoint];
    });
    const moduleGroup: ChunkGroup =
      definition.groupShape === "missing-parents"
        ? {}
        : { getParents: () => parents };
    chunksByModule.set(
      module,
      definition.groupShape === "missing-groups"
        ? [{}]
        : [
            {
              groupsIterable:
                definition.entrypoints.length === 0 ? [] : [moduleGroup],
            },
          ],
    );
    return module;
  });

  const afterSeal = createVoidSyncHook();
  const chunkGraph: WebpackChunkGraphDouble = {
    getModuleChunks: (module) =>
      moduleChunksShape === "iterable"
        ? (chunksByModule.get(module) ?? [])
        : undefined,
  };
  let activeChunkGraph =
    chunkGraphTiming === "compilation" ? chunkGraph : undefined;
  const compilation: WebpackCompilationDouble = {
    modules,
    get chunkGraph() {
      return activeChunkGraph;
    },
    entrypoints,
    hooks: { afterSeal },
    errors: [],
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
