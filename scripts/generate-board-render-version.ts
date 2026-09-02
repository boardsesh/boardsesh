/// <reference types="node" />

/**
 * Generate the committed `BOARD_RENDER_VERSION` constant that `buildBoardRenderUrl`
 * appends to every `/render/board` URL as `&v=` (issue #4773).
 *
 * Usage:
 *   vp run generate:board-render-version            # write the constant
 *   vp run check:board-render-version               # fail if the committed one is stale
 *
 * Why the version exists
 * ----------------------
 * Board-render responses are served `immutable` for a year. Until #3837 that was
 * covered by Vercel purging its CDN on every deploy (12-22x/day in practice), so a
 * renderer change reached users within minutes. Cloudflare does not purge on deploy
 * and we hold no `Zone.Cache Purge` token, so without a version in the URL a change
 * to the WASM renderer, the sharp pipeline, board geometry or the board photos would
 * be invisible to everyone already holding the old bytes — for up to a year.
 *
 * Why a committed constant and not a build-time hash
 * --------------------------------------------------
 * `buildBoardRenderUrl` compiles into web's *client* bundle (board-image-layers is
 * reachable from `'use client'` components), so the value must be byte-identical in
 * the RSC graph, the browser chunk and the Node route handler. A source literal is
 * that by construction. A build-time hash would also have to survive
 * `scripts/create-service-docker-context.mjs`, which copies workspace packages only:
 * `packages/board-renderer/core` (the Rust source) is not a workspace and never
 * enters `.docker-context/web`, so a hash computed in the Docker build could differ
 * from one computed on Vercel — two `v` values for identical bytes, which is worse
 * than no version at all.
 *
 * What goes into the hash
 * -----------------------
 * Two halves:
 *   1. A semantic projection of the shipped board catalogue, in
 *      `@boardsesh/board-render`'s `render-version-projection.ts`. See the long
 *      comment there for why a projection beats a hand-kept file list.
 *   2. File hashes for the parts no projection can see: the compiled WASM binary
 *      and its bindgen glue, and the two imperative sharp modules.
 * Plus the SHA-256 of every board photo the catalogue actually composites — resolved
 * from the projection, so an unreferenced image under `public/images/` does not churn
 * the version and a newly referenced one cannot be missed.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  buildBoardRenderProjections,
  combineBoardRenderVersion,
} from '../packages/shared/board-render/src/render-version-projection';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

export const GENERATED_VERSION_FILE = 'packages/shared/board-render/src/generated/render-version.ts';

/**
 * Inputs the catalogue projection cannot express, hashed by content.
 *
 * The WASM half is a compiled binary — opaque by definition, and committed to git
 * so every checkout and every Docker context agrees on its bytes. The sharp half is
 * imperative code (encode options, composite order, the OG backdrop SVG), not data,
 * so there is nothing to project. Everything else — board geometry, hold colours,
 * dimensions, edges, OG canvas size — is covered by the projection and must NOT be
 * listed here, or unrelated edits to those files churn the version for no pixel change.
 */
export const OPAQUE_RENDER_INPUTS: readonly string[] = [
  // The renderer itself: hold marker shapes, SHAPE_AREA_SCALE, stroke geometry.
  'packages/board-renderer/wasm/pkg/board_renderer_wasm_bg.wasm',
  // wasm-bindgen glue; moves with the toolchain, and the toolchain moves the output.
  'packages/board-renderer/wasm/pkg/board_renderer_wasm.js',
  // sharp composite / dim / encode quality (#4675 changed exactly this).
  'packages/shared/board-render/src/pipeline.ts',
  // The OG social-card backdrop SVG (gradient stops, blur radius, frame geometry).
  // `getBackgroundRelPaths` lives here too and IS covered by the projection, so this
  // file is the one deliberate overlap: a comment-only edit to it churns the version.
  // Worth it — the backdrop is drawn, not derived, and there is nothing to project.
  'packages/shared/board-render/src/background.ts',
];

/**
 * The traced board art, hashed as a directory rather than projected.
 *
 * The projection cannot see a single polygon: it probes `buildRenderConfig` with
 * an empty frames string, so no hold is lit and no `outline`, `led_inner` or
 * `silhouette_lightness` is ever attached. Re-tracing a board would therefore
 * move no version, and Cloudflare would keep serving the old silhouettes
 * `immutable` for a year.
 *
 * Hashed whole (sorted, path + bytes) rather than listed file by file: the shards
 * are one generated artefact, and a new board must not be able to slip in
 * unhashed. `wall-lightness.cjs` rides along, which is right — it decides every
 * board's veil strength.
 */
export const BOARD_ART_GEOMETRY_ROOT = 'packages/shared/board-art-geometry/src/generated';

/** Board photos live in web's public tree; the backend gets a copy of the same files. */
const PUBLIC_IMAGE_ROOT = 'packages/web/public';

function hashFile(absolutePath: string): string {
  return createHash('sha256').update(readFileSync(absolutePath)).digest('hex');
}

/** Every file under `directory`, repo-relative and sorted, so the walk is stable. */
function listFilesRecursively(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...listFilesRecursively(entryPath));
    else if (entry.isFile()) found.push(entryPath);
  }
  return found.sort();
}

/** Content hash of a whole generated directory: sorted relative paths plus their bytes. */
function hashDirectory(absoluteRoot: string): string {
  const directoryHash = createHash('sha256');
  for (const filePath of listFilesRecursively(absoluteRoot)) {
    directoryHash.update(`${path.relative(absoluteRoot, filePath)}=${hashFile(filePath)}\n`);
  }
  return directoryHash.digest('hex');
}

/**
 * Compute the version from the working tree. Throws — loudly, naming the path — if a
 * declared opaque input is missing, rather than silently hashing a shorter list.
 */
export function computeBoardRenderVersion(repoRoot: string): string {
  const fileHashes: Record<string, string> = {};
  for (const relativePath of OPAQUE_RENDER_INPUTS) {
    const absolutePath = path.join(repoRoot, relativePath);
    if (!existsSync(absolutePath)) {
      throw new Error(
        `board-render version input is missing: ${relativePath}. ` +
          'Run `vp run build:wasm` if the WASM package has not been built, or fix OPAQUE_RENDER_INPUTS.',
      );
    }
    fileHashes[relativePath] = hashFile(absolutePath);
  }

  const geometryRoot = path.join(repoRoot, BOARD_ART_GEOMETRY_ROOT);
  if (!existsSync(geometryRoot)) {
    throw new Error(
      `board-render version input is missing: ${BOARD_ART_GEOMETRY_ROOT}. ` +
        'Run `vp run generate:board-art-geometry`, or fix BOARD_ART_GEOMETRY_ROOT.',
    );
  }
  fileHashes[BOARD_ART_GEOMETRY_ROOT] = hashDirectory(geometryRoot);

  const projections = buildBoardRenderProjections();
  const boardHashes: Record<string, string> = {};
  for (const [boardName, projection] of Object.entries(projections)) {
    const boardHash = createHash('sha256');
    boardHash.update(`config=${projection.configDigest}\n`);
    for (const imageRelPath of projection.imageRelPaths) {
      const absolutePath = path.join(repoRoot, PUBLIC_IMAGE_ROOT, imageRelPath);
      // A referenced photo that is absent renders without that layer, so absence is
      // itself part of the output — record it instead of throwing.
      const imageHash = existsSync(absolutePath) ? hashFile(absolutePath) : 'absent';
      boardHash.update(`image:${imageRelPath}=${imageHash}\n`);
    }
    boardHashes[boardName] = boardHash.digest('hex');
  }

  return combineBoardRenderVersion({ fileHashes, boardHashes });
}

/**
 * The exact text of the generated module. Emitted prettier-clean on the first try:
 * `vite.config.ts` skips `/generated/` paths in the staged `vp check --fix` hook, so
 * nothing will reformat this for us.
 */
export function renderVersionModuleSource(version: string): string {
  return `// GENERATED FILE - DO NOT EDIT.
// Run \`vp run generate:board-render-version\` to refresh it.
//
// Cache version for /render/board URLs. Derived from the shipped board
// catalogue plus the compiled renderer and sharp pipeline, so a change that alters
// what the route draws mints new URLs and the old ones age out of Cloudflare instead
// of being served for a year (#4773).
//
// Deliberately import-free: this module is reachable from web's client bundle
// through buildBoardRenderUrl, and must never drag sharp or the WASM glue with it.
export const BOARD_RENDER_VERSION = '${version}';
`;
}

export function writeBoardRenderVersion(repoRoot: string): { version: string; changed: boolean } {
  const version = computeBoardRenderVersion(repoRoot);
  const targetPath = path.join(repoRoot, GENERATED_VERSION_FILE);
  const nextSource = renderVersionModuleSource(version);
  const currentSource = existsSync(targetPath) ? readFileSync(targetPath, 'utf8') : null;
  if (currentSource === nextSource) return { version, changed: false };
  writeFileSync(targetPath, nextSource);
  return { version, changed: true };
}

export type BoardRenderVersionDrift = {
  committedSource: string | null;
  expectedSource: string;
};

export type BoardRenderVersionCheck = {
  /** The version the working tree implies, whether or not the committed file agrees. */
  version: string;
  /** Null when the committed file is current; the two sources when it is not. */
  drift: BoardRenderVersionDrift | null;
};

export function checkBoardRenderVersion(repoRoot: string): BoardRenderVersionCheck {
  const version = computeBoardRenderVersion(repoRoot);
  const targetPath = path.join(repoRoot, GENERATED_VERSION_FILE);
  const committedSource = existsSync(targetPath) ? readFileSync(targetPath, 'utf8') : null;
  const expectedSource = renderVersionModuleSource(version);
  if (committedSource === expectedSource) return { version, drift: null };
  return { version, drift: { committedSource, expectedSource } };
}

function main(): void {
  const isCheck = process.argv.includes('--check');

  if (isCheck) {
    const { version, drift } = checkBoardRenderVersion(REPO_ROOT);
    if (drift === null) {
      console.log(`board-render version is up to date (${version}).`);
      return;
    }
    console.error(
      `${GENERATED_VERSION_FILE} is out of date.\n` +
        `  expected BOARD_RENDER_VERSION = '${version}'\n` +
        '  run `vp run generate:board-render-version` and commit the result.',
    );
    process.exitCode = 1;
    return;
  }

  const { version, changed } = writeBoardRenderVersion(REPO_ROOT);
  console.log(changed ? `Wrote BOARD_RENDER_VERSION = '${version}'.` : `BOARD_RENDER_VERSION already '${version}'.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main();
}
