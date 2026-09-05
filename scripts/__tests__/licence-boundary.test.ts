/// <reference types="node" />

/**
 * Guards the licence boundary described in docs/licensing.md.
 *
 * The Aura board renderer and its bindings are AGPL-3.0-or-later; the rest of
 * the monorepo is Apache-2.0. Four things have to agree for that to hold, and
 * none of them is checked by any other tool in the repo: the canonical licence
 * text inside each covered package, the `license` field in each covered
 * package.json / Cargo.toml, the per-path map in REUSE.toml, and the SPDX
 * header on each covered source file. This spec reads all of them from disk,
 * so Vitest's `--changed` module-graph analysis never selects it for the diffs
 * it guards; the `licence-boundary` job in .github/workflows/ci.yml runs it
 * unfiltered whenever any of those inputs change.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

const AGPL_IDENTIFIER = 'AGPL-3.0-or-later';

/** SHA-256 of the unmodified GNU AGPL-3.0 text (gnu.org/licenses/agpl-3.0.txt, 34,523 bytes). */
const AGPL_TEXT_SHA256 = '8486a10c4393cee1c25392769ddd3b2d6c242d6ec7928e1414efff7dfb2f07ef';

/** The covered directories, exactly as docs/licensing.md lists them. */
const AGPL_DIRECTORIES = [
  'packages/board-renderer',
  'packages/mobile/modules/board-renderer',
  'packages/shared/board-render',
  'packages/shared/board-look',
  'packages/shared/board-art-geometry',
] as const;

/** Every package.json inside the boundary that declares the licence. */
const AGPL_PACKAGE_MANIFESTS = [
  'packages/board-renderer/wasm/package.json',
  'packages/board-renderer/wasm/pkg/package.json',
  'packages/mobile/modules/board-renderer/package.json',
  'packages/shared/board-render/package.json',
  'packages/shared/board-look/package.json',
  'packages/shared/board-art-geometry/package.json',
] as const;

const CARGO_CRATE_MANIFESTS = [
  'packages/board-renderer/core/Cargo.toml',
  'packages/board-renderer/ffi/Cargo.toml',
  'packages/board-renderer/wasm/Cargo.toml',
] as const;

/** Verbatim copies of the wasm-pack output served from Apache-2.0 packages. */
const WASM_ARTIFACT_COPIES = [
  'packages/web/public/wasm/board_renderer_wasm.js',
  'packages/web/public/wasm/board_renderer_wasm_bg.wasm',
  'packages/mobile/public/wasm/board_renderer_wasm.js',
  'packages/mobile/public/wasm/board_renderer_wasm_bg.wasm',
] as const;

/**
 * Covered source files that deliberately carry no SPDX header: their content
 * hash is an input to BOARD_RENDER_VERSION (scripts/generate-board-render-version.ts),
 * so a comment-only edit would mint new /render/board URLs and flush the CDN.
 */
const HEADER_EXEMPT_FILES = new Set([
  'packages/shared/board-render/src/pipeline.ts',
  'packages/shared/board-render/src/background.ts',
]);

/** Extensions whose files must open with an SPDX header. */
const HEADERED_EXTENSIONS = new Set([
  '.rs',
  '.swift',
  '.kt',
  '.cpp',
  '.h',
  '.ts',
  '.tsx',
  '.gradle',
  '.sh',
  '.podspec',
]);
const HEADERED_BASENAMES = new Set(['CMakeLists.txt', 'cbindgen.toml']);

/** Path fragments that are generated output or binaries and cannot carry a header. */
const HEADER_SKIP_FRAGMENTS = ['/generated/', '/wasm/pkg/', '/jniLibs/', '.xcframework/'];

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

function walkFiles(relativeDirectory: string): string[] {
  const collected: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(repoPath(directory), { withFileTypes: true })) {
      const entryPath = path.posix.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'target' || entry.name === 'build') continue;
        visit(entryPath);
      } else if (entry.isFile()) {
        collected.push(entryPath);
      }
    }
  };
  visit(relativeDirectory);
  return collected;
}

function isInsideBoundary(relativePath: string): boolean {
  return AGPL_DIRECTORIES.some((directory) => relativePath === directory || relativePath.startsWith(`${directory}/`));
}

function readPackageLicense(relativePath: string): string | undefined {
  const manifest = JSON.parse(readRepoFile(relativePath)) as { license?: unknown };
  return typeof manifest.license === 'string' ? manifest.license : undefined;
}

describe('licence boundary: AGPL-3.0-or-later for the Aura renderer, Apache-2.0 elsewhere', () => {
  it('keeps the repository root on the unmodified Apache License 2.0', () => {
    const rootLicense = readRepoFile('LICENSE');
    expect(rootLicense.trimStart().startsWith('Apache License')).toBe(true);
    expect(rootLicense).toContain('Version 2.0, January 2004');
    expect(rootLicense).not.toContain('AFFERO');
  });

  it.each(AGPL_DIRECTORIES)('%s ships the canonical, unmodified AGPL-3.0 text as LICENSE', (directory) => {
    const licensePath = `${directory}/LICENSE`;
    expect(existsSync(repoPath(licensePath)), `${licensePath} is missing`).toBe(true);
    expect(sha256(licensePath)).toBe(AGPL_TEXT_SHA256);
  });

  it('ships the same canonical text next to the committed wasm-pack output', () => {
    expect(sha256('packages/board-renderer/wasm/pkg/LICENSE')).toBe(AGPL_TEXT_SHA256);
  });

  it.each(AGPL_PACKAGE_MANIFESTS)('%s declares license "AGPL-3.0-or-later"', (manifestPath) => {
    expect(readPackageLicense(manifestPath)).toBe(AGPL_IDENTIFIER);
  });

  it('declares the licence once in the Cargo workspace and inherits it in every crate', () => {
    const workspaceManifest = readRepoFile('packages/board-renderer/Cargo.toml');
    expect(workspaceManifest).toMatch(/\[workspace\.package\][\s\S]*?license = "AGPL-3\.0-or-later"/);
    for (const crateManifest of CARGO_CRATE_MANIFESTS) {
      expect(readRepoFile(crateManifest), crateManifest).toContain('license.workspace = true');
    }
  });

  it('never declares the AGPL on a package outside the boundary, or another licence inside it', () => {
    const manifests = walkFiles('packages').filter((filePath) => path.basename(filePath) === 'package.json');
    expect(manifests.length).toBeGreaterThan(20);
    const misplaced: string[] = [];
    for (const manifestPath of manifests) {
      const declared = readPackageLicense(manifestPath);
      const inside = isInsideBoundary(manifestPath);
      if (inside && declared !== AGPL_IDENTIFIER) misplaced.push(`${manifestPath}: ${declared ?? '(none)'}`);
      if (!inside && declared === AGPL_IDENTIFIER) misplaced.push(`${manifestPath}: ${declared}`);
    }
    expect(misplaced).toEqual([]);
  });

  it('maps every covered directory and artifact copy to the AGPL in REUSE.toml', () => {
    const reuse = readRepoFile('REUSE.toml');
    expect(reuse).toMatch(/path = "\*\*"[\s\S]*?SPDX-License-Identifier = "Apache-2\.0"/);
    for (const directory of AGPL_DIRECTORIES) {
      const annotation = new RegExp(
        `path = "${directory.replaceAll('/', '\\/')}/\\*\\*"[\\s\\S]*?SPDX-License-Identifier = "${AGPL_IDENTIFIER}"`,
      );
      expect(reuse, `REUSE.toml lacks an AGPL annotation for ${directory}`).toMatch(annotation);
    }
    for (const artifactCopy of WASM_ARTIFACT_COPIES) {
      expect(reuse, `REUSE.toml lacks ${artifactCopy}`).toContain(`"${artifactCopy}"`);
      expect(existsSync(repoPath(artifactCopy)), `${artifactCopy} is missing`).toBe(true);
    }
  });

  it('keeps the wasm artifact copies byte-identical to the licensed pkg output', () => {
    for (const artifactCopy of WASM_ARTIFACT_COPIES) {
      const source = `packages/board-renderer/wasm/pkg/${path.basename(artifactCopy)}`;
      expect(sha256(artifactCopy), `${artifactCopy} drifted from ${source}`).toBe(sha256(source));
    }
  });

  it('opens every covered source file with an SPDX AGPL header', () => {
    const missingHeader: string[] = [];
    for (const directory of AGPL_DIRECTORIES) {
      for (const filePath of walkFiles(directory)) {
        const extension = path.extname(filePath);
        const basename = path.basename(filePath);
        if (!HEADERED_EXTENSIONS.has(extension) && !HEADERED_BASENAMES.has(basename)) continue;
        if (HEADER_SKIP_FRAGMENTS.some((fragment) => filePath.includes(fragment))) continue;
        if (HEADER_EXEMPT_FILES.has(filePath)) continue;
        const firstLines = readRepoFile(filePath).split('\n', 3).join('\n');
        if (!firstLines.includes(`SPDX-License-Identifier: ${AGPL_IDENTIFIER}`)) missingHeader.push(filePath);
      }
    }
    expect(missingHeader).toEqual([]);
  });

  it('leaves the two cache-versioned pipeline files header-free so the CDN version does not churn', () => {
    for (const exemptFile of HEADER_EXEMPT_FILES) {
      expect(statSync(repoPath(exemptFile)).isFile()).toBe(true);
      expect(readRepoFile(exemptFile)).not.toContain('SPDX-License-Identifier');
    }
  });

  it('documents each covered directory in docs/licensing.md', () => {
    const licensingDoc = readRepoFile('docs/licensing.md');
    for (const directory of AGPL_DIRECTORIES) {
      expect(licensingDoc).toContain(`\`${directory}/\``);
    }
    for (const exemptFile of HEADER_EXEMPT_FILES) {
      expect(licensingDoc).toContain(`\`${exemptFile}\``);
    }
  });
});
