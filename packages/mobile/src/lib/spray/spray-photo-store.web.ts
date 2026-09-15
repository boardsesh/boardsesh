// Browser twin of `spray-photo-store.ts`.
//
// `expo-file-system` has no browser build (the same reason `cache-dir-io.web.ts`
// exists), and there is nothing here worth shimming: the durable store exists so
// a phone in a basement can decode a photo it downloaded days ago, and a browser
// tab that is offline has no board surface to draw it on. An online browser
// loads the presigned URL straight into an `<img>` and the HTTP cache is the
// disk cache.
//
// So every entry point answers "not stored", and storing is a no-op that reports
// failure honestly rather than pretending a file landed.

export const SPRAY_PHOTO_STORE_DIR_NAME = 'spray-wall-photos';

export function sprayPhotoStoreFileName(photoKey: string): string {
  return photoKey.replace(/[^A-Za-z0-9._-]/g, '_');
}

export function tryGetStoredSprayPhotoPathSync(_photoKey: string | null | undefined): string | null {
  return null;
}

export async function storeSprayPhoto(_photoKey: string, _photoUrl: string): Promise<string | null> {
  return null;
}

export function deleteStoredSprayPhoto(_photoKey: string | null | undefined): void {
  // Nothing on disk.
}

export function pruneStoredSprayPhotos(_liveKeys: Iterable<string>): number {
  return 0;
}

export function clearStoredSprayPhotos(): void {
  // Nothing on disk, nothing to wipe.
}
