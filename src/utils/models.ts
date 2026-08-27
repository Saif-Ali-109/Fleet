/** Collapse consecutive duplicate model ids for fallback reporting (rider #2). */
export function collapseConsecutiveModels(ids: readonly string[]): string[] {
  const out: string[] = [];
  for (const id of ids) {
    if (out.length === 0 || out[out.length - 1] !== id) out.push(id);
  }
  return out;
}
