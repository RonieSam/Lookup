import type { RecordData } from "./columns";

export interface MergeResult {
  merged: RecordData;
  added: number;
  changed: number;
  unchanged: number;
  /** Fields where the file disagreed but the stored value was kept. */
  skipped: number;
}

/**
 * Merges one uploaded record into a stored one.
 *
 * - A field the student doesn't have yet is always added.
 * - A field that already has a different value is replaced only when
 *   `overwrite` is true; otherwise the stored value is kept.
 * - Fields missing from `incoming` are never removed.
 */
export function mergeRecord(
  existing: RecordData | undefined,
  incoming: RecordData,
  overwrite: boolean,
): MergeResult {
  const merged: RecordData = { ...(existing ?? {}) };
  let added = 0;
  let changed = 0;
  let unchanged = 0;
  let skipped = 0;

  for (const [key, value] of Object.entries(incoming)) {
    if (!Object.hasOwn(merged, key)) {
      merged[key] = value;
      added++;
    } else if (merged[key] === value) {
      unchanged++;
    } else if (overwrite) {
      merged[key] = value;
      changed++;
    } else {
      skipped++;
    }
  }

  return { merged, added, changed, unchanged, skipped };
}
