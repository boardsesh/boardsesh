import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// W-24 (#4438) edits packages/mobile/public/index.html and claims the change
// reaches app.boardsesh.com only — never the native store fleet. Standing rule 2
// says that claim needs a test, not an assertion.
//
// Two independent properties make it true, and this pins both:
//   1. public/ is not a native fingerprint input, so the change cannot even
//      produce a new runtimeVersion — but fingerprint-neutrality only
//      guarantees DELIVERY, so on its own it would be the weaker half.
//   2. public/ is never read by native code. Expo consumes it only on the web
//      export path (@expo/cli's publicFolder.js + webTemplate.js). That is the
//      safety half: the native app never reads the byte we changed.
//
// assetBundlePatterns is deliberately NOT part of the claim, and NOT asserted
// below: it filters assets Metro has already resolved from the JS module graph,
// and public/ is not in that graph, so widening it would not embed public/ in a
// binary either. Pinning it here would red an unrelated legitimate change for a
// reason that isn't true.

const mobileRoot = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(import.meta.url);

type ExtraSource = { type: string; filePath: string };
const fingerprintConfig = require(join(mobileRoot, 'fingerprint.config.js')) as { extraSources: ExtraSource[] };

const NATIVE_SOURCE_DIRECTORIES = ['src', 'app', 'modules', 'plugins', 'targets'];
const CODE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

function collectSourceFiles(directory: string): string[] {
  return readdirSync(join(mobileRoot, directory), { recursive: true, encoding: 'utf8' })
    .filter((entry) => CODE_EXTENSIONS.some((extension) => entry.endsWith(extension)))
    .filter((entry) => !entry.split(sep).includes('__tests__'))
    .map((entry) => join(directory, entry));
}

describe('packages/mobile/public is a web-only surface', () => {
  it('is not a fingerprint input, so editing it cannot move runtimeVersion', () => {
    // @expo/fingerprint's own defaults source the bare native dirs, autolinking
    // configs, the resolved Expo config, package.json scripts and the patch dir
    // — public/ is in none of them. These extraSources are the only additions,
    // so the whole allowlist just has to stay clear of public/.
    // Resolve before comparing. @expo/fingerprint joins each filePath against
    // the project root, so './public' and '../mobile/public' reach the same
    // directory as 'public' — a literal string match would call those clean.
    const publicDir = join(mobileRoot, 'public');
    const publicSources = fingerprintConfig.extraSources.filter(({ filePath }) => {
      const resolved = resolve(mobileRoot, filePath);
      return resolved === publicDir || resolved.startsWith(publicDir + sep);
    });

    expect(publicSources).toEqual([]);
  });

  it('is not referenced by any native source file', () => {
    const referencingFiles = NATIVE_SOURCE_DIRECTORIES.flatMap(collectSourceFiles).filter((relativePath) => {
      const source = readFileSync(join(mobileRoot, relativePath), 'utf8');
      return source.includes('public/index.html') || source.includes('public/manifest.json');
    });

    expect(referencingFiles).toEqual([]);
  });

  it('does not relocate the public folder via EXPO_PUBLIC_FOLDER', () => {
    // A custom public folder would move index.html/manifest.json to a path the
    // checks above do not cover — and could put them somewhere a fingerprint
    // source does reach.
    expect(readFileSync(join(mobileRoot, 'app.config.ts'), 'utf8')).not.toContain('EXPO_PUBLIC_FOLDER');
  });
});
