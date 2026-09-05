/// <reference types="node" />

/**
 * Guards the licence boundary described in LICENSING.md.
 *
 * The product core is AGPL-3.0-or-later; the interoperability tier (schema,
 * API clients, board catalogue and config, Bluetooth protocols, board API
 * clients, firmware, and two packages left under their contributors' licence)
 * is Apache-2.0. Five things have to agree for that to hold, and none of them
 * is checked by any other tool in the repo: the canonical licence texts, the
 * `license` field in every package manifest, the per-path map in REUSE.toml,
 * the SPDX header on each source file in the tiers that carry headers, and
 * the rule that an Apache-2.0 package never depends on an AGPL one (otherwise
 * it could not be reused permissively on its own). This spec reads all of them
 * from disk, so Vitest's `--changed` module-graph analysis never selects it
 * for the diffs it guards; the `licence-boundary` job in
 * .github/workflows/ci.yml runs it unfiltered whenever any input changes.
 */

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

const AGPL = 'AGPL-3.0-or-later';
const APACHE = 'Apache-2.0';

/** SHA-256 of the unmodified GNU AGPL-3.0 text (gnu.org/licenses/agpl-3.0.txt, 34,523 bytes). */
const AGPL_TEXT_SHA256 = '8486a10c4393cee1c25392769ddd3b2d6c242d6ec7928e1414efff7dfb2f07ef';
/** SHA-256 of the unmodified Apache License 2.0 text (apache.org/licenses/LICENSE-2.0.txt, 11,357 bytes). */
const APACHE_TEXT_SHA256 = 'c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4';

/**
 * The Apache-2.0 tier, exactly as LICENSING.md lists it. Every directory
 * carries its own LICENSE copy; the ones with a package.json declare the
 * licence there too. Everything else under the repository is AGPL.
 */
const APACHE_DIRECTORIES = [
  'packages/shared-schema',
  'packages/board-constants',
  'packages/shared/board-config',
  'packages/shared/ble-protocol',
  'packages/shared/graphql',
  'packages/shared/graphql-client',
  'packages/moonboard-ocr',
  'packages/crypto',
  'packages/shared/logbook',
  'packages/mobile/modules/health-workouts',
  'packages/aurora-sync/src/api',
  'packages/kilter-sync/src/api',
  'packages/moonboard-sync/src/api',
  'packages/board-controller',
  'packages/web/board-controller',
  'embedded',
] as const;

/** The Aura renderer: AGPL like the rest of the core, but with per-file headers (solely authored). */
const RENDERER_DIRECTORIES = [
  'packages/board-renderer',
  'packages/mobile/modules/board-renderer',
  'packages/shared/board-render',
  'packages/shared/board-look',
  'packages/shared/board-art-geometry',
] as const;

const CARGO_CRATE_MANIFESTS = [
  'packages/board-renderer/core/Cargo.toml',
  'packages/board-renderer/ffi/Cargo.toml',
  'packages/board-renderer/wasm/Cargo.toml',
] as const;

/** Verbatim copies of the wasm-pack output served from the two web targets. */
const WASM_ARTIFACT_COPIES = [
  'packages/web/public/wasm/board_renderer_wasm.js',
  'packages/web/public/wasm/board_renderer_wasm_bg.wasm',
  'packages/mobile/public/wasm/board_renderer_wasm.js',
  'packages/mobile/public/wasm/board_renderer_wasm_bg.wasm',
] as const;

/**
 * Renderer files that deliberately carry no SPDX header: their content hash is
 * an input to BOARD_RENDER_VERSION (scripts/generate-board-render-version.ts),
 * so a comment-only edit would mint new /render/board URLs and flush the CDN.
 */
const HEADER_EXEMPT_FILES = new Set([
  'packages/shared/board-render/src/pipeline.ts',
  'packages/shared/board-render/src/background.ts',
]);

/** Service images and the licence of the first-party code inside them. */
const DOCKERFILE_LABELS: ReadonlyArray<readonly [string, string]> = [
  ['Dockerfile.web', AGPL],
  ['Dockerfile.backend', AGPL],
  ['Dockerfile.sync', AGPL],
  ['packages/web/board-controller/Dockerfile', APACHE],
];

const HEADERED_EXTENSIONS = new Set([
  '.rs',
  '.swift',
  '.kt',
  '.cpp',
  '.c',
  '.h',
  '.hpp',
  '.ino',
  '.py',
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
]);
const HEADER_SKIP_SEGMENTS = new Set([
  'generated',
  '__generated__',
  'static',
  'node_modules',
  'dist',
  'build',
  '.pio',
  'pkg',
  'jniLibs',
]);
const HEADER_SKIP_FRAGMENTS = ['.xcframework/'];

/** Dependency installs and build output: never part of the tree the boundary describes. */
const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  'target',
  '.pio',
  '__pycache__',
  '.next',
  '.expo',
  'dist',
  'build',
  '.docker-context',
]);

function repoPath(relativePath: string): string {
  return path.join(REPO_ROOT, relativePath);
}

function readRepoFile(relativePath: string): string {
  return readFileSync(repoPath(relativePath), 'utf8');
}

function sha256(relativePath: string): string {
  return createHash('sha256')
    .update(readFileSync(repoPath(relativePath)))
    .digest('hex');
}

/** Tracked-style walk: skips node_modules, build output and symlinks (embedded/test/lib links back into libs/). */
function walkFiles(relativeDirectory: string): string[] {
  const collected: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(repoPath(directory), { withFileTypes: true })) {
      const entryPath = path.posix.join(directory, entry.name);
      if (lstatSync(repoPath(entryPath)).isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
        visit(entryPath);
      } else if (entry.isFile()) {
        collected.push(entryPath);
      }
    }
  };
  visit(relativeDirectory);
  return collected;
}

function isUnder(relativePath: string, directories: readonly string[]): boolean {
  return directories.some((directory) => relativePath === directory || relativePath.startsWith(`${directory}/`));
}

type Manifest = {
  name?: string;
  license?: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

function readManifest(relativePath: string): Manifest {
  return JSON.parse(readRepoFile(relativePath)) as Manifest;
}

function wantsHeader(filePath: string): boolean {
  if (!HEADERED_EXTENSIONS.has(path.extname(filePath))) return false;
  if (filePath.split('/').some((segment) => HEADER_SKIP_SEGMENTS.has(segment))) return false;
  if (HEADER_SKIP_FRAGMENTS.some((fragment) => filePath.includes(fragment))) return false;
  return true;
}

function headerIdentifier(filePath: string): string | undefined {
  const firstLines = readRepoFile(filePath).split('\n', 4).join('\n');
  return /SPDX-License-Identifier:\s*([^\s]+)/.exec(firstLines)?.[1];
}

const workspaceManifests = walkFiles('packages').filter((filePath) => path.basename(filePath) === 'package.json');

describe('licence boundary: AGPL-3.0-or-later core, Apache-2.0 interoperability tier', () => {
  it('ships both canonical texts and uses the AGPL as the repository licence', () => {
    expect(sha256('LICENSE')).toBe(AGPL_TEXT_SHA256);
    expect(sha256('LICENSES/AGPL-3.0-or-later.txt')).toBe(AGPL_TEXT_SHA256);
    expect(sha256('LICENSES/Apache-2.0.txt')).toBe(APACHE_TEXT_SHA256);
    expect(readRepoFile('LICENSES/CC-BY-4.0.txt').startsWith('Creative Commons Attribution 4.0 International')).toBe(
      true,
    );
  });

  it.each(APACHE_DIRECTORIES)('%s carries the unmodified Apache-2.0 text as LICENSE', (directory) => {
    expect(existsSync(repoPath(`${directory}/LICENSE`)), `${directory}/LICENSE is missing`).toBe(true);
    expect(sha256(`${directory}/LICENSE`)).toBe(APACHE_TEXT_SHA256);
  });

  it.each(RENDERER_DIRECTORIES)('%s carries the unmodified AGPL-3.0 text as LICENSE', (directory) => {
    expect(sha256(`${directory}/LICENSE`)).toBe(AGPL_TEXT_SHA256);
  });

  it('declares the licence of every workspace package by its tier', () => {
    expect(workspaceManifests.length).toBeGreaterThan(40);
    const wrong: string[] = [];
    for (const manifestPath of workspaceManifests) {
      const expected = isUnder(manifestPath, APACHE_DIRECTORIES) ? APACHE : AGPL;
      const declared = readManifest(manifestPath).license;
      if (declared !== expected) wrong.push(`${manifestPath}: ${declared ?? '(none)'} (expected ${expected})`);
    }
    expect(wrong).toEqual([]);
    expect(readManifest('package.json').license).toBe(`${AGPL} AND ${APACHE}`);
  });

  it('never lets an Apache-2.0 package depend on an AGPL one at runtime', () => {
    const licenceByName = new Map<string, string>();
    for (const manifestPath of workspaceManifests) {
      const manifest = readManifest(manifestPath);
      if (manifest.name && manifest.license) licenceByName.set(manifest.name, manifest.license);
    }
    const violations: string[] = [];
    for (const manifestPath of workspaceManifests) {
      if (!isUnder(manifestPath, APACHE_DIRECTORIES)) continue;
      const manifest = readManifest(manifestPath);
      const runtimeDependencies = { ...manifest.dependencies, ...manifest.peerDependencies };
      for (const dependencyName of Object.keys(runtimeDependencies)) {
        if (!dependencyName.startsWith('@boardsesh/')) continue;
        const dependencyLicence = licenceByName.get(dependencyName);
        if (dependencyLicence !== APACHE)
          violations.push(`${manifest.name} -> ${dependencyName} (${dependencyLicence ?? 'unknown'})`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('declares the licence once in the Cargo workspace and inherits it in every crate', () => {
    expect(readRepoFile('packages/board-renderer/Cargo.toml')).toMatch(
      /\[workspace\.package\][\s\S]*?license = "AGPL-3\.0-or-later"/,
    );
    for (const crateManifest of CARGO_CRATE_MANIFESTS) {
      expect(readRepoFile(crateManifest), crateManifest).toContain('license.workspace = true');
    }
  });

  it('declares Apache-2.0 on every PlatformIO library manifest', () => {
    const libraryManifests = walkFiles('embedded').filter((filePath) => path.basename(filePath) === 'library.json');
    expect(libraryManifests.length).toBeGreaterThan(15);
    const wrong = libraryManifests.filter((manifestPath) => readManifest(manifestPath).license !== APACHE);
    expect(wrong).toEqual([]);
  });

  it('labels each service image with the licence of its first-party code', () => {
    for (const [dockerfile, licence] of DOCKERFILE_LABELS) {
      expect(readRepoFile(dockerfile), dockerfile).toContain(`org.opencontainers.image.licenses="${licence}"`);
    }
  });

  it('publishes the public API specification as Apache-2.0', () => {
    const generator = readRepoFile('packages/web/app/lib/api-docs/generate-openapi.ts');
    expect(generator).toContain("name: 'Apache-2.0'");
    expect(generator).not.toContain("name: 'MIT'");
  });

  it('maps the core to the AGPL and every Apache directory to Apache-2.0 in REUSE.toml', () => {
    const reuse = readRepoFile('REUSE.toml');
    expect(reuse).toMatch(/path = "\*\*"[\s\S]*?SPDX-License-Identifier = "AGPL-3\.0-or-later"/);
    const apacheBlock = reuse
      .split('[[annotations]]')
      .find((block) => block.includes('SPDX-License-Identifier = "Apache-2.0"'));
    expect(apacheBlock, 'REUSE.toml lacks the Apache-2.0 annotation block').toBeDefined();
    for (const directory of APACHE_DIRECTORIES) {
      expect(apacheBlock, `REUSE.toml Apache block lacks ${directory}`).toContain(`"${directory}/**"`);
    }
    for (const artifactCopy of WASM_ARTIFACT_COPIES) {
      expect(reuse, `REUSE.toml lacks ${artifactCopy}`).toContain(`"${artifactCopy}"`);
    }
    expect(reuse).toMatch(/path = "CODE_OF_CONDUCT\.md"[\s\S]*?SPDX-License-Identifier = "CC-BY-4\.0"/);
  });

  it('keeps the wasm artifact copies byte-identical to the licensed pkg output', () => {
    for (const artifactCopy of WASM_ARTIFACT_COPIES) {
      const source = `packages/board-renderer/wasm/pkg/${path.basename(artifactCopy)}`;
      expect(sha256(artifactCopy), `${artifactCopy} drifted from ${source}`).toBe(sha256(source));
    }
  });

  it('opens every renderer source file with an SPDX AGPL header', () => {
    const missing: string[] = [];
    for (const directory of RENDERER_DIRECTORIES) {
      for (const filePath of walkFiles(directory)) {
        if (!wantsHeader(filePath) || HEADER_EXEMPT_FILES.has(filePath)) continue;
        if (headerIdentifier(filePath) !== AGPL) missing.push(filePath);
      }
    }
    expect(missing).toEqual([]);
  });

  it('opens every Apache-tier source file with an SPDX Apache-2.0 header', () => {
    const missing: string[] = [];
    for (const directory of APACHE_DIRECTORIES) {
      for (const filePath of walkFiles(directory)) {
        if (!wantsHeader(filePath)) continue;
        if (headerIdentifier(filePath) !== APACHE) missing.push(filePath);
      }
    }
    expect(missing).toEqual([]);
  });

  it('leaves the two cache-versioned pipeline files header-free so the CDN version does not churn', () => {
    for (const exemptFile of HEADER_EXEMPT_FILES) {
      expect(readRepoFile(exemptFile)).not.toContain('SPDX-License-Identifier');
    }
  });

  it('documents the boundary and the transition in LICENSING.md and nowhere claims the repo is all Apache', () => {
    const licensing = readRepoFile('LICENSING.md');
    for (const directory of [...APACHE_DIRECTORIES, ...RENDERER_DIRECTORIES]) {
      expect(licensing, `LICENSING.md does not mention ${directory}`).toContain(`\`${directory}/\``);
    }
    for (const exemptFile of HEADER_EXEMPT_FILES) {
      expect(licensing).toContain(`\`${exemptFile}\``);
    }
    expect(licensing).toMatch(/Last commit on `main` under Apache-2\.0 alone:\*\* `[0-9a-f]{8}`/);
    expect(existsSync(repoPath('docs/licensing.md'))).toBe(false);
    for (const claimant of ['README.md', 'LEGAL.md', 'CONTRIBUTING.md']) {
      const text = readRepoFile(claimant);
      expect(text, `${claimant} still describes the whole project as Apache-licensed`).not.toMatch(
        /completely open source under the Apache|Apache-2\.0 for the app\b|repository as a whole is under the Apache/,
      );
      expect(text).toContain('LICENSING.md');
    }
    for (const locale of ['en-US', 'es', 'fr', 'de']) {
      expect(readRepoFile(`packages/shared/i18n/locales/${locale}/marketing.json`)).toContain('AGPL-3.0');
    }
  });
});
