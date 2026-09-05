// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Marco de Jongh

/** Raw overlay render result: dimensions parsed from the 8-byte WASM header. */
export type OverlayRenderResult = {
  width: number;
  height: number;
  /** Raw RGBA pixels (the WASM output with its 8-byte dimension header stripped). */
  rgba: Uint8Array;
};

export type OverlayRenderer = {
  /** Eagerly initialise the WASM module (used at backend boot). Idempotent. */
  ensureInitialized: () => Promise<void>;
  /** True once the WASM module is initialised and ready to render. */
  isReady: () => boolean;
  /** Render an overlay for a config JSON string, returning parsed dimensions + RGBA. */
  render: (configJson: string) => Promise<OverlayRenderResult>;
};

/**
 * Create an overlay renderer backed by the `@boardsesh/board-renderer-wasm`
 * module. Byte loading is injected (`loadWasmBytes`) so each host resolves the
 * `.wasm` file however it must — web probes its Vercel file-traced candidates,
 * the backend resolves the package deterministically. Init is promise-locked to
 * prevent a thundering-herd double-init under concurrent first requests.
 */
export function createOverlayRenderer(loadWasmBytes: () => Promise<Uint8Array | Buffer>): OverlayRenderer {
  let renderOverlay: ((configJson: string) => Uint8Array) | null = null;
  let initPromise: Promise<void> | null = null;

  async function ensureInitialized(): Promise<void> {
    if (renderOverlay) return;
    if (!initPromise) {
      initPromise = (async () => {
        const wasmModule = await import('@boardsesh/board-renderer-wasm');
        const wasmBytes = await loadWasmBytes();
        wasmModule.initSync({ module: wasmBytes });
        renderOverlay = wasmModule.render_overlay;
      })().catch((initError: unknown) => {
        // Clear the lock so a transient failure (e.g. I/O) can be retried by a
        // later call instead of pinning every caller to the same rejection.
        initPromise = null;
        throw initError;
      });
    }
    await initPromise;
  }

  return {
    ensureInitialized,
    isReady: () => renderOverlay !== null,
    async render(configJson: string): Promise<OverlayRenderResult> {
      await ensureInitialized();
      if (!renderOverlay) {
        throw new Error('WASM renderer failed to initialize');
      }
      const rawBytes = renderOverlay(configJson);
      // Dimension header: first 8 bytes are width + height as u32 LE.
      const view = new DataView(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength);
      const width = view.getUint32(0, true);
      const height = view.getUint32(4, true);
      const rgba = rawBytes.subarray(8);
      return { width, height, rgba };
    },
  };
}
