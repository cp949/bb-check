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
  readonly loaderSource: string | Uint8Array | null;
  readonly beforeLoadersSource?: string;
  readonly entrypoints: readonly string[];
}

export interface ObservedWebpackModule {
  readonly resource?: unknown;
  readonly type: string;
  readonly beforeLoadersSource?: string;
  readonly originalSource: () => {
    readonly source: () => string | Uint8Array;
  } | null;
  readonly sourceReads: number;
}

interface ChunkGroup {
  readonly name?: string;
  readonly getParents: () => Iterable<ChunkGroup>;
}

interface Chunk {
  readonly groupsIterable: Iterable<ChunkGroup>;
}

export interface WebpackCompilationDouble {
  readonly modules: Iterable<ObservedWebpackModule>;
  readonly chunkGraph: {
    readonly getModuleChunks: (
      module: ObservedWebpackModule,
    ) => Iterable<Chunk>;
  };
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
}: {
  readonly target?: "web" | "node";
  readonly modules: readonly WebpackModuleDefinition[];
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
  const modules = definitions.map((definition): ObservedWebpackModule => {
    let sourceReads = 0;
    const module: ObservedWebpackModule = {
      ...(Object.hasOwn(definition, "resource")
        ? { resource: definition.resource }
        : {}),
      ...(definition.beforeLoadersSource === undefined
        ? {}
        : { beforeLoadersSource: definition.beforeLoadersSource }),
      type: "javascript/auto",
      originalSource: () => {
        sourceReads += 1;
        if (definition.loaderSource === null) return null;
        return { source: () => definition.loaderSource ?? "" };
      },
      get sourceReads() {
        return sourceReads;
      },
    };

    const parents = definition.entrypoints.flatMap((name) => {
      const entrypoint = entrypoints.get(name);
      return entrypoint === undefined ? [] : [entrypoint];
    });
    const moduleGroup: ChunkGroup = {
      getParents: () => parents,
    };
    chunksByModule.set(module, [
      {
        groupsIterable:
          definition.entrypoints.length === 0 ? [] : [moduleGroup],
      },
    ]);
    return module;
  });

  const afterSeal = createVoidSyncHook();
  const compilation: WebpackCompilationDouble = {
    modules,
    chunkGraph: {
      getModuleChunks: (module) => chunksByModule.get(module) ?? [],
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
      afterSeal.call();
      return compilation.errors;
    },
  };
};
