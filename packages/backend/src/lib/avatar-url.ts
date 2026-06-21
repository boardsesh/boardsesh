export function buildStaticAvatarUrl(fileName: string, version: string): string {
  return `/static/avatars/${fileName}?v=${encodeURIComponent(version)}`;
}
