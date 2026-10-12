// Pure helpers shared by the CapsuleRow platform trees (no native imports, no
// rendering), so each platform reads a capsule's state the same way.

import type { Capsule } from './CapsuleRow.types';

/** Whether a capsule draws in its active (filled brand) style. A sheet opener lights once it has a count. */
export function isCapsuleActive(capsule: Capsule): boolean {
  return capsule.kind === 'sheet' ? (capsule.count ?? 0) > 0 : capsule.active;
}
