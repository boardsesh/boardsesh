import { readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export function applyObservationWrapper(root: string, patches: Record<string, { before: string; after: string }>) {
  const canonicalRoot = realpathSync(root);
  const hashes: Record<string, { before: string; after: string }> = {};
  for (const [relative, patch] of Object.entries(patches)) {
    const path = realpathSync(join(root, relative));
    if (!path.startsWith(canonicalRoot + '/') || readFileSync(path, 'utf8') !== patch.before)
      throw new Error('isolated_wrapper_preimage_mismatch');
    // Replacing the directory entry breaks a package-store hardlink without editing its other owners.
    if (statSync(path).nlink !== 1) {
      writeFileSync(path + '.observation-isolated', patch.before);
      renameSync(path + '.observation-isolated', path);
    }
    if (statSync(path).nlink !== 1) throw new Error('isolated_wrapper_link_count');
    writeFileSync(path + '.observation-trace', patch.after);
    renameSync(path + '.observation-trace', path);
    hashes[relative] = Object.fromEntries(
      ['before', 'after'].map((key) => [
        key,
        createHash('sha256')
          .update(patch[key as 'before' | 'after'])
          .digest('hex'),
      ]),
    ) as { before: string; after: string };
  }
  return hashes;
}
