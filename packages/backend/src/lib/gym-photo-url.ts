export function buildStaticGymPhotoUrl(fileName: string, version: string): string {
  return `/static/gym-photos/${fileName}?v=${encodeURIComponent(version)}`;
}
