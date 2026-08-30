import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const runNode = promisify(execFile);

describe('native Quantum zstd stream failures', () => {
  it.each(['missing', 'pre-aborted', 'abort-after-chunk'])(
    'rejects %s in a subprocess without an uncaught stream error',
    async (scenario) => {
      const decoderUrl = new URL('./zstd.ts', import.meta.url).href;
      const program = `
        import { nodeZstdStreamDecoder } from ${JSON.stringify(decoderUrl)};
        import { mkdtemp, writeFile, rm } from 'node:fs/promises';
        import { randomBytes } from 'node:crypto';
        import { tmpdir } from 'node:os';
        import { join } from 'node:path';
        import { zstdCompressSync } from 'node:zlib';
        const scenario = process.argv[1];
        const directory = await mkdtemp(join(tmpdir(), 'quantum-stream-test-'));
        const filePath = join(directory, 'snapshot.zst');
        const controller = new AbortController();
        try {
          if (scenario !== 'missing') await writeFile(filePath, zstdCompressSync(randomBytes(2 * 1024 * 1024)));
          if (scenario === 'pre-aborted') controller.abort();
          let rejected = false;
          try {
            for await (const chunk of nodeZstdStreamDecoder(filePath, controller.signal)) {
              if (scenario === 'abort-after-chunk') controller.abort();
            }
          } catch (error) {
            if (scenario === 'missing' ? error.code !== 'ENOENT' : error.name !== 'AbortError') throw error;
            rejected = true;
          }
          if (!rejected) throw new Error('Expected the stream to reject');
          await new Promise((resolve) => setImmediate(resolve));
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      `;
      const result = await runNode(process.execPath, [
        '--import',
        'tsx',
        '--input-type=module',
        '--eval',
        program,
        scenario,
      ]);
      expect(result.stdout).toBe('');
    },
  );
});
