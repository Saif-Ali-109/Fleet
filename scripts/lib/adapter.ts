import type { CanonicalConfig } from "./canonical.js";

/** One file an adapter wants written to disk. */
export interface GeneratedFile {
  /** Absolute path. */
  path: string;
  /** Full file contents. */
  contents: string;
}

/**
 * A tool adapter: takes the canonical config, returns the files that tool
 * needs. Pure function — no filesystem I/O in here, so adapters are trivial
 * to unit test and safe to run in --check mode without side effects.
 *
 * To support a new CLI agent: write one function matching this shape in
 * scripts/adapters/, then register it in scripts/generate-configs.ts's
 * ADAPTERS list. Nothing else in the pipeline changes.
 */
export type Adapter = (config: CanonicalConfig) => GeneratedFile[];
