import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BOARD_RENDER_VERSION } from '../packages/shared/board-render/src/generated/render-version';
import {
  BOARD_ART_GEOMETRY_ROOT,
  checkBoardRenderVersion,
  computeBoardRenderVersion,
  GENERATED_VERSION_FILE,
  OPAQUE_RENDER_INPUTS,
  renderVersionModuleSource,
} from './generate-board-render-version';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

/**
 * A throwaway tree carrying the real opaque inputs and one stand-in traced-art
 * shard. It has no board photos, so its version legitimately differs from the
 * repo's — these tests are about which inputs reach the digest, not the value.
 */
function scratchTree({ geometryShard }: { geometryShard: string | null }): string {
  const scratchRoot = mkdtempSync(path.join(tmpdir(), 'board-render-version-'));
  for (const relativePath of OPAQUE_RENDER_INPUTS) {
    const target = path.join(scratchRoot, relativePath);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(path.join(REPO_ROOT, relativePath)));
  }
  if (geometryShard !== null) {
    const shardTarget = path.join(scratchRoot, BOARD_ART_GEOMETRY_ROOT, 'kilter', '1-10.cjs');
    mkdirSync(path.dirname(shardTarget), { recursive: true });
    writeFileSync(shardTarget, geometryShard);
  }
  return scratchRoot;
}

describe('computeBoardRenderVersion', () => {
  it('is stable across two runs over the same tree', () => {
    expect(computeBoardRenderVersion(REPO_ROOT)).toBe(computeBoardRenderVersion(REPO_ROOT));
  });

  it('emits a 12-char lowercase hex digest', () => {
    expect(computeBoardRenderVersion(REPO_ROOT)).toMatch(/^[0-9a-f]{12}$/);
  });

  it('matches the committed constant', () => {
    // The same gate as the `board-render-version` CI job, run again here so a
    // stale constant is a red test locally and not only in CI.
    expect(BOARD_RENDER_VERSION).toBe(computeBoardRenderVersion(REPO_ROOT));
  });

  it('names the missing path when an opaque input is absent', () => {
    const emptyRoot = mkdtempSync(path.join(tmpdir(), 'board-render-version-'));
    expect(() => computeBoardRenderVersion(emptyRoot)).toThrow(OPAQUE_RENDER_INPUTS[0]);
  });

  it('names the traced-art directory when it is absent', () => {
    const withoutGeometry = scratchTree({ geometryShard: null });
    expect(() => computeBoardRenderVersion(withoutGeometry)).toThrow(BOARD_ART_GEOMETRY_ROOT);
  });

  it('still produces a version when the traced-art directory is empty', () => {
    // An empty directory is not the same as a missing one: the tables can
    // legitimately regenerate to nothing for a catalogue with no traced board,
    // and the version must stay a real digest rather than collapse or throw.
    const emptyGeometry = scratchTree({ geometryShard: null });
    mkdirSync(path.join(emptyGeometry, BOARD_ART_GEOMETRY_ROOT), { recursive: true });
    expect(computeBoardRenderVersion(emptyGeometry)).toMatch(/^[0-9a-f]{12}$/);
  });

  it('moves when a traced silhouette changes', () => {
    // The projection cannot see a polygon — it probes with an empty frames
    // string, so no hold is lit and no outline is ever attached. Without the
    // directory hash, re-tracing a board would move no version and Cloudflare
    // would serve the old silhouettes `immutable` for a year.
    const before = computeBoardRenderVersion(scratchTree({ geometryShard: 'module.exports = { outlines: {} };' }));
    const after = computeBoardRenderVersion(scratchTree({ geometryShard: 'module.exports = { outlines: {1:[0]} };' }));
    expect(after).not.toBe(before);
  });
});

describe('OPAQUE_RENDER_INPUTS', () => {
  it('hashes the compiled renderer and the imperative sharp modules', () => {
    expect(OPAQUE_RENDER_INPUTS).toContain('packages/board-renderer/wasm/pkg/board_renderer_wasm_bg.wasm');
    expect(OPAQUE_RENDER_INPUTS).toContain('packages/board-renderer/wasm/pkg/board_renderer_wasm.js');
    expect(OPAQUE_RENDER_INPUTS).toContain('packages/shared/board-render/src/pipeline.ts');
    expect(OPAQUE_RENDER_INPUTS).toContain('packages/shared/board-render/src/background.ts');
  });

  it('does not hash inputs the catalogue projection already covers', () => {
    // Adding any of these back would churn the version on comment-and-adjacent-code
    // edits that change no pixels — the whole reason the projection exists.
    // led-placements is the sharpest case: it is 13 of 48 commits over 180 days and
    // the renderer never reads it (render-config.ts prefers each role's
    // calibrated displayColor over the raw LED colour).
    for (const projectedInput of [
      'packages/board-constants/src/led-placements.ts',
      'packages/board-constants/src/generated/led-placements-data.ts',
      'packages/board-constants/src/hold-states.ts',
      'packages/board-constants/src/hole-placements.ts',
      'packages/board-constants/src/product-sizes.ts',
      'packages/shared/board-config/src/board-data.ts',
      'packages/shared/board-render/src/board-details.ts',
      'packages/shared/board-render/src/render-config.ts',
      'packages/shared/board-render/src/headers.ts',
    ]) {
      expect(OPAQUE_RENDER_INPUTS).not.toContain(projectedInput);
    }
  });

  it('does not hash modules with no bearing on the pixels', () => {
    for (const unrelatedInput of [
      'packages/shared/board-render/src/lru.ts',
      'packages/shared/board-render/src/semaphore.ts',
      'packages/shared/board-render/src/validation.ts',
    ]) {
      expect(OPAQUE_RENDER_INPUTS).not.toContain(unrelatedInput);
    }
  });
});

describe('renderVersionModuleSource', () => {
  it('reproduces the committed file byte-for-byte', () => {
    // `vite.config.ts` skips `/generated/` in the staged `vp check --fix` hook, so
    // nothing reformats this file for us — the generator has to emit it clean.
    const committed = readFileSync(path.join(REPO_ROOT, GENERATED_VERSION_FILE), 'utf8');
    expect(renderVersionModuleSource(BOARD_RENDER_VERSION)).toBe(committed);
  });

  it('ends with a trailing newline and a single-quoted literal', () => {
    const source = renderVersionModuleSource('abcdef123456');
    expect(source.endsWith("export const BOARD_RENDER_VERSION = 'abcdef123456';\n")).toBe(true);
  });

  it('emits no imports', () => {
    expect(renderVersionModuleSource('abcdef123456')).not.toMatch(/^\s*import\s/m);
  });
});

describe('checkBoardRenderVersion', () => {
  it('reports no drift for the committed tree', () => {
    const { version, drift } = checkBoardRenderVersion(REPO_ROOT);
    expect(drift).toBeNull();
    expect(version).toBe(BOARD_RENDER_VERSION);
  });

  it('reports drift when the committed constant is stale', () => {
    // Mirror the real inputs into a scratch tree, then stale only the generated
    // file — proves the check reads the committed file rather than recomputing
    // both sides and always agreeing with itself.
    const scratchRoot = scratchTree({ geometryShard: 'module.exports = { outlines: {} };' });
    const generatedTarget = path.join(scratchRoot, GENERATED_VERSION_FILE);
    mkdirSync(path.dirname(generatedTarget), { recursive: true });
    writeFileSync(generatedTarget, renderVersionModuleSource('000000000000'));

    const { version, drift } = checkBoardRenderVersion(scratchRoot);
    expect(drift).not.toBeNull();
    expect(version).toMatch(/^[0-9a-f]{12}$/);
    // The scratch tree has no board photos, so its version legitimately differs
    // from the repo's — what matters is that the check compares the committed
    // text against the recomputed one instead of agreeing with itself.
    expect(drift?.committedSource).toContain('000000000000');
    expect(drift?.expectedSource).not.toBe(drift?.committedSource);
  });
});
