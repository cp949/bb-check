export { loadLibraryBaseline } from "./baseline.js";
export { resolveDistEntries } from "./dist-entries.js";
export { findFirstSyntaxDivergence } from "./syntax-gate.js";
export { createOriginLookup } from "./source-origin.js";
export { collectGlobalReferences } from "./compat-scope.js";
export { normalizeBrowserSupport, buildCompatIndex } from "./compat-bcd.js";
export type {
  CompatIndex,
  CompatCandidate,
  CompatIssue,
  CompatIssueReason,
  CompatSupportInput,
  CompatSupportStatementLike,
} from "./compat-bcd.js";
export { createCompatScanner } from "./compat-scanner.js";
export type {
  CompatScanner,
  CompatScannerOptions,
  CompatFinding,
  CompatFindingTier,
} from "./compat-scanner.js";
export { createDependencyClosureScanner } from "./dependency-closure.js";
export type {
  DependencyClosureScanner,
  DependencyFinding,
  DependencyFindingKind,
} from "./dependency-closure.js";
export { checkLibrary } from "./check-library.js";
export type { CheckLibraryOptions } from "./check-library.js";
