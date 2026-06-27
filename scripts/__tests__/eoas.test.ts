import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bunxIsScriptShim, pathWithoutBrokenBunxShims } from '../lib/eoas';

const createdDirs: string[] = [];

/** Make a temp dir, optionally with a `bunx` file of the given contents. */
function makeDirWithBunx(content: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'eoas-'));
  createdDirs.push(dir);
  if (content !== null) writeFileSync(join(dir, 'bunx'), content);
  return dir;
}

afterEach(() => {
  while (createdDirs.length > 0) {
    rmSync(createdDirs.pop() as string, { recursive: true, force: true });
  }
});

describe('bunxIsScriptShim', () => {
  it('flags a `#!` script shim (vp’s broken bunx)', () => {
    expect(bunxIsScriptShim(makeDirWithBunx('#!/bin/sh\nexec bun "$@"\n'))).toBe(true);
  });

  it('treats a non-`#!` bunx as a real binary', () => {
    expect(bunxIsScriptShim(makeDirWithBunx('\x7fELF...not a script'))).toBe(false);
  });

  it('returns false when the dir has no bunx', () => {
    expect(bunxIsScriptShim(makeDirWithBunx(null))).toBe(false);
  });
});

describe('pathWithoutBrokenBunxShims', () => {
  it('drops only the dirs whose bunx is a `#!` shim', () => {
    const shimDir = makeDirWithBunx('#!/bin/sh\nexec bun "$@"\n');
    const realDir = makeDirWithBunx('\x7fELF...');
    const emptyDir = makeDirWithBunx(null);

    const result = pathWithoutBrokenBunxShims([shimDir, realDir, emptyDir].join(delimiter)).split(delimiter);

    expect(result).toContain(realDir);
    expect(result).toContain(emptyDir);
    expect(result).not.toContain(shimDir);
  });

  it('returns an empty string for an undefined PATH', () => {
    expect(pathWithoutBrokenBunxShims(undefined)).toBe('');
  });
});
