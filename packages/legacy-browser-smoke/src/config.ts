import { LegacyBrowserSmokeError } from "./errors.js";

export interface LegacyBrowserSmokeConfig {
  readonly pages: readonly SmokePage[];
  readonly timeoutMs: number;
  readonly knownUnsupported?: readonly KnownUnsupportedSignal[];
}

export interface SmokePage {
  readonly name: string;
  readonly path: `/${string}`;
  readonly ready: ReadyCondition;
}

export type ReadyCondition =
  | { readonly kind: "selector"; readonly selector: string }
  | { readonly kind: "expression"; readonly expression: string };

export interface KnownUnsupportedSignal {
  readonly kind: "console" | "page-error" | "request-failed" | "http-error";
  readonly pattern: string;
  readonly count: number;
  readonly reason: string;
}

const configInvalid = (): never => {
  throw new LegacyBrowserSmokeError(
    "LBS_CONFIG_INVALID",
    "legacy browser smoke configuration is invalid",
  );
};

const isOwnDataObject = (value: unknown): value is object =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

const ownData = (
  value: unknown,
  keys: readonly string[],
  requiredKeys: readonly string[] = keys,
): Readonly<Record<string, unknown>> => {
  if (!isOwnDataObject(value)) configInvalid();
  const objectValue = value as object;

  const ownKeys = Reflect.ownKeys(objectValue);
  for (const key of ownKeys) {
    if (typeof key !== "string" || !keys.includes(key)) configInvalid();
    const descriptor = Object.getOwnPropertyDescriptor(objectValue, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      configInvalid();
    }
  }

  const output: Record<string, unknown> = {};
  for (const key of requiredKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(objectValue, key);
    output[key] =
      descriptor !== undefined && "value" in descriptor
        ? descriptor.value
        : configInvalid();
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(objectValue, key);
    if (descriptor !== undefined && "value" in descriptor) {
      output[key] = descriptor.value;
    }
  }
  return output;
};

const denseArray = (value: unknown): readonly unknown[] => {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) {
    return configInvalid();
  }

  const arrayValue = value as unknown[];
  const length = arrayValue.length;
  const keys = Reflect.ownKeys(arrayValue);
  if (keys.length !== length + 1) configInvalid();
  const lengthDescriptor = Object.getOwnPropertyDescriptor(
    arrayValue,
    "length",
  );
  if (
    lengthDescriptor === undefined ||
    !("value" in lengthDescriptor) ||
    lengthDescriptor.value !== length
  ) {
    configInvalid();
  }

  const copy: unknown[] = new Array(length);
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    const descriptor = Object.getOwnPropertyDescriptor(arrayValue, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      configInvalid();
    }
    copy[index] =
      descriptor !== undefined && "value" in descriptor
        ? descriptor.value
        : configInvalid();
  }
  return copy;
};

const nonEmptyText = (value: unknown): string => {
  if (typeof value !== "string") return configInvalid();
  const text = value.trim();
  if (text === "") return configInvalid();
  return text;
};

const positiveSafeInteger = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    return configInvalid();
  }
  return value;
};

const normalizeReady = (value: unknown): ReadyCondition => {
  if (!isOwnDataObject(value)) configInvalid();
  const kindDescriptor = Object.getOwnPropertyDescriptor(
    value as object,
    "kind",
  );
  const kind =
    kindDescriptor !== undefined && "value" in kindDescriptor
      ? kindDescriptor.value
      : configInvalid();
  if (kind === "selector") {
    const candidate = ownData(value, ["kind", "selector"]);
    return Object.freeze({
      kind: "selector" as const,
      selector: nonEmptyText(candidate.selector),
    });
  }

  const expression = ownData(value, ["kind", "expression"]);
  if (expression.kind !== "expression") configInvalid();
  return Object.freeze({
    kind: "expression" as const,
    expression: nonEmptyText(expression.expression),
  });
};

const hasControlCharacter = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
};

const normalizePage = (value: unknown): SmokePage => {
  const page = ownData(value, ["name", "path", "ready"]);
  const path = page.path;
  if (
    typeof path !== "string" ||
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("\\") ||
    hasControlCharacter(path)
  ) {
    configInvalid();
  }
  return Object.freeze({
    name: nonEmptyText(page.name),
    path: path as `/${string}`,
    ready: normalizeReady(page.ready),
  });
};

const normalizePattern = (value: unknown): string => {
  if (typeof value !== "string") return configInvalid();
  const pattern = value.replace(/\r\n?/gu, "\n").trim();
  if (pattern === "") return configInvalid();
  return pattern;
};

const normalizeSignal = (value: unknown): KnownUnsupportedSignal => {
  const signal = ownData(value, ["kind", "pattern", "count", "reason"]);
  const kind = signal.kind;
  if (
    kind !== "console" &&
    kind !== "page-error" &&
    kind !== "request-failed" &&
    kind !== "http-error"
  ) {
    configInvalid();
  }
  const signalKind = kind as KnownUnsupportedSignal["kind"];
  return Object.freeze({
    kind: signalKind,
    pattern: normalizePattern(signal.pattern),
    count: positiveSafeInteger(signal.count),
    reason: nonEmptyText(signal.reason),
  });
};

export const defineSmokeConfig = (
  input: LegacyBrowserSmokeConfig,
): LegacyBrowserSmokeConfig => {
  const config = ownData(
    input,
    ["pages", "timeoutMs", "knownUnsupported"],
    ["pages", "timeoutMs"],
  );
  const rawPages = denseArray(config.pages);
  if (rawPages.length === 0) configInvalid();
  const pages: SmokePage[] = [];
  const names = new Set<string>();
  for (const rawPage of rawPages) {
    const page = normalizePage(rawPage);
    if (names.has(page.name)) configInvalid();
    names.add(page.name);
    pages.push(page);
  }

  const rawSignals =
    config.knownUnsupported === undefined
      ? []
      : denseArray(config.knownUnsupported);
  const knownUnsupported: KnownUnsupportedSignal[] = [];
  const signalKeys = new Set<string>();
  for (const rawSignal of rawSignals) {
    const signal = normalizeSignal(rawSignal);
    const key = `${signal.kind}\u0000${signal.pattern}`;
    if (signalKeys.has(key)) configInvalid();
    signalKeys.add(key);
    knownUnsupported.push(signal);
  }

  return Object.freeze({
    pages: Object.freeze(pages),
    timeoutMs: positiveSafeInteger(config.timeoutMs),
    knownUnsupported: Object.freeze(knownUnsupported),
  });
};
