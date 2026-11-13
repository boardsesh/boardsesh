import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vite-plus/test';
const helperUrl = new URL('../runtime-context.mjs', import.meta.url).href;
const { copyBuildFile } = (await import(helperUrl)) as { copyBuildFile: (source: string, destination: string) => void };
it('refuses a symlinked Dockerfile before copying any contents', () => {
  const directory = mkdtempSync(join(tmpdir(), 'owned-auth-build-input-'));
  try {
    const actual = join(directory, 'regular-input');
    const link = join(directory, 'Dockerfile');
    const destination = join(directory, 'copied');
    writeFileSync(actual, 'FROM scratch\n');
    symlinkSync(actual, link);
    expect(() => copyBuildFile(link, destination)).toThrow('REHEARSAL_BUILD_INPUT_REFUSED');
    expect(existsSync(destination)).toBe(false);
    copyBuildFile(actual, destination);
    expect(existsSync(destination)).toBe(true);
  } finally {
    rmSync(directory, { recursive: true });
  }
});
