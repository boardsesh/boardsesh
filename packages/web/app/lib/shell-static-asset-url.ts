import { STATIC_SHELL_ASSET_OBJECT_KEYS } from '@boardsesh/static-assets/shell';

export type ShellStaticAssetPath = keyof typeof STATIC_SHELL_ASSET_OBJECT_KEYS;

/** Resolve a logo or app icon without importing the full board-image catalog. */
export function resolveShellStaticAssetUrl(
  logicalPath: ShellStaticAssetPath,
  baseUrl: string | undefined = process.env.NEXT_PUBLIC_STATIC_ASSET_BASE_URL,
): string {
  if (!baseUrl) return logicalPath;
  const shellCatalog: Readonly<Record<string, string>> = STATIC_SHELL_ASSET_OBJECT_KEYS;
  const objectKey = shellCatalog[logicalPath];
  if (!objectKey) {
    throw new Error(`Static shell asset is missing from the generated catalog: ${logicalPath}`);
  }
  return `${baseUrl.replace(/\/+$/, '')}/${objectKey}`;
}
