// Pure helpers shared by the CapsuleRow platform trees (no native imports, no
// rendering), so each platform reads a capsule's state the same way.

import type { Capsule } from './CapsuleRow.types';

/** Whether a capsule draws in its active (filled brand) style. A sheet opener lights once it has a count. */
export function isCapsuleActive(capsule: Capsule): boolean {
  return capsule.kind === 'sheet' ? (capsule.count ?? 0) > 0 : capsule.active;
}

/** Count badges follow Badge's 99+ ceiling and disappear when no filter is active. */
export function capsuleBadgeLabel(count: number | undefined): string | undefined {
  if (count == null || count <= 0 || !Number.isFinite(count)) return undefined;
  return count > 99 ? '99+' : String(count);
}
