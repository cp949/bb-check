export const chromiumRevision = "650583" as const;
export const chromiumVersion = "Chromium 75.0.3765.0" as const;

export interface BrowserRegistryEntry {
  readonly platform: "linux-x64";
  readonly revision: typeof chromiumRevision;
  readonly version: typeof chromiumVersion;
  readonly archiveUrl: string;
  readonly executableRelativePath: "chrome-linux/chrome";
  readonly sha256: string;
}
