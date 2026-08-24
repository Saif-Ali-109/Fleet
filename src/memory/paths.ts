import { join } from "node:path";

/** Root-relative folder holding the Manager's runtime artifacts. */
export const MANAGER_DIR = "manager";

/** Resolve a Manager artifact (`MEMORY.txt`, `SESSION_LOG.txt`, `models.json`, …) under rootDir. */
export function resolveManagerPath(rootDir: string, name: string): string {
  return join(rootDir, MANAGER_DIR, name);
}
