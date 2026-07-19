// @vitest-environment jsdom
//
// The off-thread render worker (public/wasm/board-render.worker.js) is a STATIC
// asset served verbatim — Metro never bundles it, no tsconfig covers it, and no
// other test executes it. It hand-duplicates decodeRenderOutput + the render
// limits from modules/board-renderer/src/index.web.ts (the main-thread twin).
// Because worker breakage degrades silently to the main-thread fallback, drift
// between the two copies would never surface in CI. This test loads the worker's
// decode logic straight from the asset source and pins it to the canonical
// implementation so the copies cannot diverge unnoticed.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { _webRendererForTests } from '../../../modules/board-renderer/src/index.web';

// Locate the static worker asset by walking up from the working directory. The
// test runner rewrites `import.meta.url` to a non-file URL, so resolve against
// cwd instead — which is the repo root under CI/vitest and packages/mobile for a
// scoped run; both are covered.
function resolveWorkerPath(): string {
  const fromRepoRoot = join('packages', 'mobile', 'public', 'wasm', 'board-render.worker.js');
  const fromMobile = join('public', 'wasm', 'board-render.worker.js');
  let directory = process.cwd();
  for (let depth = 0; depth < 8; depth++) {
    for (const candidate of [join(directory, fromRepoRoot), join(directory, fromMobile)]) {
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error('Could not locate packages/mobile/public/wasm/board-render.worker.js from the working directory');
}

const WORKER_PATH = resolveWorkerPath();

// Extract the two render-limit constants + decodeRenderOutput from the static
// worker source and evaluate them in isolation. The block is pure (DataView /
// Uint8ClampedArray / Number only — no `self`, OffscreenCanvas, or imports), so
// it runs standalone. Anchoring on the constant declaration through the start of
// encodeRgbaToPng keeps it robust to edits inside the decode function itself.
function loadWorkerDecode(): {
  decodeRenderOutput: (bytes: Uint8Array) => { width: number; height: number; rgba: Uint8ClampedArray };
  MAX_RENDER_DIMENSION: number;
  MAX_RENDER_PIXELS: number;
} {
  const source = readFileSync(WORKER_PATH, 'utf8');
  const start = source.indexOf('const MAX_RENDER_DIMENSION');
  const end = source.indexOf('async function encodeRgbaToPng');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('board-render.worker.js layout changed — update the parity extraction markers');
  }
  const block = source.slice(start, end);
  // oxlint-disable-next-line typescript/no-implied-eval -- controlled evaluation of a pure, in-repo static asset for parity testing
  const factory = new Function(`${block}\nreturn { decodeRenderOutput, MAX_RENDER_DIMENSION, MAX_RENDER_PIXELS };`);
  return factory() as ReturnType<typeof loadWorkerDecode>;
}

function renderBytes(width: number, height: number, payloadLength = width * height * 4): Uint8Array {
  const bytes = new Uint8Array(8 + payloadLength);
  const header = new DataView(bytes.buffer);
  header.setUint32(0, width, true);
  header.setUint32(4, height, true);
  return bytes;
}

describe('board-render worker parity with the main-thread renderer', () => {
  const worker = loadWorkerDecode();
  const canonicalDecode = _webRendererForTests.decodeRenderOutput;

  it('pins the render-limit constants to the canonical values', () => {
    expect(worker.MAX_RENDER_DIMENSION).toBe(8192);
    expect(worker.MAX_RENDER_PIXELS).toBe(32 * 1024 * 1024);
  });

  it('decodes a valid RGBA response identically to the main thread', () => {
    const input = renderBytes(2, 3);
    const fromWorker = worker.decodeRenderOutput(input);
    const fromCanonical = canonicalDecode(renderBytes(2, 3));
    expect(fromWorker.width).toBe(fromCanonical.width);
    expect(fromWorker.height).toBe(fromCanonical.height);
    expect(Array.from(fromWorker.rgba)).toEqual(Array.from(fromCanonical.rgba));
  });

  it('rejects the same malformed inputs with the same messages as the main thread', () => {
    const cases: Array<[string, () => Uint8Array]> = [
      ['truncated header', () => new Uint8Array(7)],
      ['zero dimension', () => renderBytes(0, 2, 0)],
      ['oversized dimension', () => renderBytes(8193, 1, 0)],
      ['payload length mismatch', () => renderBytes(2, 2, 4)],
    ];
    for (const [, makeInput] of cases) {
      let canonicalError: string | undefined;
      try {
        canonicalDecode(makeInput());
      } catch (error) {
        canonicalError = error instanceof Error ? error.message : String(error);
      }
      expect(canonicalError, 'canonical decode should reject this input').toBeDefined();
      expect(() => worker.decodeRenderOutput(makeInput())).toThrow(canonicalError);
    }
  });
});
