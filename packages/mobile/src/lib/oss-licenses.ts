/**
 * App-facing accessor for the bundled third-party license attribution, generated
 * at build time by scripts/generate-oss-licenses.ts.
 *
 * Loaded through a dynamic import() so the ~1 MB manifest's module factory only
 * runs when the licenses screen mounts and calls this — app startup (and every
 * user who never opens the screen) never parses it. The bytes still ship in the
 * bundle; Metro doesn't code-split, but it does evaluate the module lazily.
 */
export type OssLicense = {
  name: string;
  version: string;
  license: string;
  repository: string | null;
  publisher: string | null;
  licenseText: string | null;
};

export async function loadOssLicenses(): Promise<OssLicense[]> {
  const imported = await import('../data/oss-licenses.generated.json');
  return imported.default as unknown as OssLicense[];
}
