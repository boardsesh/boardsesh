/// <reference types="node" />

/**
 * Generates packages/mobile/src/data/oss-licenses.generated.json — the
 * third-party open-source license attribution shown on the mobile licenses
 * screen. Bundled MIT/BSD/Apache/ISC deps require reproducing their license
 * text + copyright notices in-app, so each entry carries the full notice.
 *
 * Walks the *production* dependency tree of packages/mobile via
 * license-checker-rseidelsohn. Scope = JavaScript deps; native CocoaPods / Android
 * library attribution is a separate, native-build-coupled follow-up.
 *
 * Degrades gracefully: if collection fails, the existing committed JSON is kept
 * and the script still exits 0. Output is sorted (no timestamp) so re-runs only
 * change the file when the dependency set actually changes.
 *
 * Usage: vp run generate:oss-licenses
 */

import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

type RawLicenseInfo = {
  licenses?: string | string[];
  repository?: string;
  publisher?: string;
  licenseFile?: string;
};

type LicenseChecker = {
  init: (
    options: { start: string; production?: boolean; development?: boolean; excludePrivatePackages?: boolean },
    callback: (error: Error | null, packages: Record<string, RawLicenseInfo>) => void,
  ) => void;
};

export type OssLicense = {
  name: string;
  version: string;
  license: string;
  repository: string | null;
  publisher: string | null;
  licenseText: string | null;
};

const require = createRequire(import.meta.url);
const licenseChecker = require('license-checker-rseidelsohn') as LicenseChecker;

const here = dirname(fileURLToPath(import.meta.url));
const MOBILE_DIR = resolve(here, '../packages/mobile');
const OUTPUT_PATH = resolve(MOBILE_DIR, 'src/data/oss-licenses.generated.json');
// Full GPL/Apache notices run ~35KB; this cap keeps a rogue bundled text file
// from bloating the JS bundle while preserving every real license in full.
const MAX_LICENSE_TEXT = 100_000;

export function splitNameVersion(key: string): { name: string; version: string } {
  const at = key.lastIndexOf('@');
  if (at <= 0) return { name: key, version: '' };
  return { name: key.slice(0, at), version: key.slice(at + 1) };
}

export function normalizeLicense(licenses: string | string[] | undefined): string {
  if (!licenses) return 'UNKNOWN';
  return Array.isArray(licenses) ? licenses.join(', ') : licenses;
}

function readLicenseText(licenseFile: string | undefined): string | null {
  if (!licenseFile) return null;
  try {
    const text = readFileSync(licenseFile, 'utf8').trim();
    if (!text) return null;
    return text.length > MAX_LICENSE_TEXT ? `${text.slice(0, MAX_LICENSE_TEXT)}\n…` : text;
  } catch {
    return null;
  }
}

// Our own workspace packages aren't third-party attribution — they ship under
// the project's own license and license-checker can't read a license field off
// them, so they'd otherwise show up as noisy "UNKNOWN" entries.
function isFirstParty(name: string): boolean {
  return name === 'boardsesh-mobile' || name.startsWith('@boardsesh/');
}

export function transformLicenses(packages: Record<string, RawLicenseInfo>): OssLicense[] {
  return Object.entries(packages)
    .map(([key, info]) => {
      const { name, version } = splitNameVersion(key);
      return {
        name,
        version,
        license: normalizeLicense(info.licenses),
        repository: info.repository ?? null,
        publisher: info.publisher ?? null,
        licenseText: readLicenseText(info.licenseFile),
      };
    })
    .filter((entry) => !isFirstParty(entry.name))
    .sort((first, second) => first.name.localeCompare(second.name) || first.version.localeCompare(second.version));
}

function collectLicenses(): Promise<Record<string, RawLicenseInfo>> {
  return new Promise((resolvePromise, rejectPromise) => {
    licenseChecker.init({ start: MOBILE_DIR, production: true, excludePrivatePackages: true }, (error, packages) => {
      if (error) rejectPromise(error);
      else resolvePromise(packages);
    });
  });
}

async function main(): Promise<void> {
  let licenses: OssLicense[];
  try {
    licenses = transformLicenses(await collectLicenses());
  } catch (error) {
    console.warn(`[oss-licenses] generation failed, keeping existing file: ${String(error)}`);
    return;
  }
  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(licenses, null, 2)}\n`);
  console.log(`[oss-licenses] wrote ${licenses.length} packages`);
}

void main();
