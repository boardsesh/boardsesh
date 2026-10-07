// Best-effort removal of a wall photo file this device rendered and no longer
// needs — a rotated preview the crop step drew, or an edit superseded by a newer
// one (`docs/spray-walls.md`, "Adding a wall").
//
// Best effort, and silent: these are files in the app's cache directory, which
// the OS clears on its own schedule anyway. A failed delete must never surface
// as an error on a step whose real work already succeeded.

import { File } from 'expo-file-system';

export function discardLocalPhoto(uri: string | null | undefined): void {
  if (!uri || !uri.startsWith('file:')) return;
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    // Already gone, or never ours to delete. Either way there is nothing to do.
  }
}
