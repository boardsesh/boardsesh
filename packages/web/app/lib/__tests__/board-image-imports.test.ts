// @vitest-environment node
import { describe, expect, it } from 'vite-plus/test';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

// Use tsx's existing esbuild dependency, keeping this check independent of Next build/dev output.
const workspaceRequire = createRequire(resolve(import.meta.dirname, '../../../../../package.json'));
const { build } = createRequire(workspaceRequire.resolve('tsx/package.json'))('esbuild') as {
  build: (
    options: Record<string, unknown>,
  ) => Promise<{ outputFiles?: { text: string }[]; metafile?: { inputs: Record<string, unknown> } }>;
};

// Keep the factory observable so tree shaking cannot make an empty bundle pass.
describe('ordinary board-image client import graph', () => {
  it('bundles the real factory without hold placements, geometry builders, or renderer runtime', async () => {
    const result = await build({
      stdin: {
        contents:
          "import { getBoardImageDetailsForBoard } from './packages/web/app/lib/board-image-details'; globalThis.boardImageMetadata = getBoardImageDetailsForBoard;",
        resolveDir: resolve(import.meta.dirname, '../../../../../'),
        loader: 'ts',
      },
      bundle: true,
      platform: 'browser',
      format: 'esm',
      write: false,
      minify: true,
      metafile: true,
    });
    expect(result.outputFiles?.[0].text).toContain('boardImageMetadata');
    const inputs = Object.keys(result.metafile?.inputs ?? {});
    expect(inputs.length).toBeGreaterThan(1);
    expect(
      inputs.filter((path) =>
        /hole-placements|woods-hold-positions|board-details\.ts|\/pipeline\.ts|\.wasm$/.test(path),
      ),
    ).toEqual([]);
  });
});
