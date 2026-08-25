import {
  chromiumRevision,
  chromiumVersion,
  type BrowserRegistryEntry,
} from "./baseline.js";
import { LegacyBrowserSmokeError } from "./errors.js";

const archiveUrl =
  "https://storage.googleapis.com/download/storage/v1/b/chromium-browser-snapshots/o/Linux_x64%2F650583%2Fchrome-linux.zip?generation=1555131417316559&alt=media";
const executableRelativePath = "chrome-linux/chrome" as const;
const sha256 =
  "10ae4e05d9f01a8b646dd2ccc2ac1135e597c472abe5be71552aae7d8a35e2ac";

const configInvalid = (): never => {
  throw new LegacyBrowserSmokeError(
    "LBS_CONFIG_INVALID",
    "browser registry entry is invalid",
  );
};

const ownEntry = (value: unknown): Readonly<Record<string, unknown>> => {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return configInvalid();
  }
  const objectValue = value as object;
  const keys = [
    "platform",
    "revision",
    "version",
    "archiveUrl",
    "executableRelativePath",
    "sha256",
  ];
  const ownKeys = Reflect.ownKeys(objectValue);
  if (ownKeys.length !== keys.length) configInvalid();
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
  const entry: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(objectValue, key);
    entry[key] =
      descriptor !== undefined && "value" in descriptor
        ? descriptor.value
        : configInvalid();
  }
  return entry;
};

export const createBrowserRegistryEntry = (
  value: unknown,
): BrowserRegistryEntry => {
  const entry = ownEntry(value);
  if (
    entry.platform !== "linux-x64" ||
    entry.revision !== chromiumRevision ||
    entry.version !== chromiumVersion ||
    entry.archiveUrl !== archiveUrl ||
    entry.executableRelativePath !== executableRelativePath ||
    entry.sha256 !== sha256 ||
    typeof entry.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(entry.sha256)
  ) {
    configInvalid();
  }
  return Object.freeze({
    platform: "linux-x64",
    revision: chromiumRevision,
    version: chromiumVersion,
    archiveUrl,
    executableRelativePath,
    sha256,
  });
};

export const lookupBrowserRegistry = (
  platform: string,
  arch: string,
): BrowserRegistryEntry => {
  if (platform !== "linux" || arch !== "x64") {
    throw new LegacyBrowserSmokeError(
      "LBS_PLATFORM_UNSUPPORTED",
      "only linux x64 browser provisioning is supported",
    );
  }
  return createBrowserRegistryEntry({
    platform: "linux-x64",
    revision: chromiumRevision,
    version: chromiumVersion,
    archiveUrl,
    executableRelativePath,
    sha256,
  });
};
