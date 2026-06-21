/// <reference types="node" />

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Exercises scripts/check-16kb-alignment.sh end-to-end: pack .so files into an
// APK-shaped zip and assert the guard's exit code. The "good" fixture is the
// real committed FFI lib (already 16 KB aligned); the "bad" one is that lib with
// its ELF LOAD-segment alignment rewritten to 4 KB, so no compiler is needed.

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..', '..');
const guardScript = path.join(repoRoot, 'scripts', 'check-16kb-alignment.sh');
const alignedSo = path.join(
  repoRoot,
  'packages/mobile/modules/board-renderer/android/src/main/jniLibs/arm64-v8a/libboard_renderer_ffi.so',
);

function hasTool(name: string): boolean {
  try {
    execFileSync('sh', ['-c', `command -v ${name}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// The guard (and this test) shell out to these; skip on hosts without them, e.g.
// a macOS dev box without binutils. CI's Linux runner has them all.
const toolsPresent = ['bash', 'zip', 'unzip', 'readelf'].every(hasTool) && fs.existsSync(alignedSo);

// Forge a 4 KB-aligned copy of an ELF64 little-endian .so: set every PT_LOAD
// segment's p_align to 0x1000. ELF64 header has e_phoff @0x20 (u64), e_phentsize
// @0x36 (u16), e_phnum @0x38 (u16); p_align is the trailing u64 of each 56-byte
// program-header entry (offset 48).
function writeMisalignedCopy(sourceSo: string, destSo: string): void {
  const bytes = fs.readFileSync(sourceSo);
  const phOffset = Number(bytes.readBigUInt64LE(0x20));
  const entrySize = bytes.readUInt16LE(0x36);
  const entryCount = bytes.readUInt16LE(0x38);
  for (let index = 0; index < entryCount; index += 1) {
    const entry = phOffset + index * entrySize;
    if (bytes.readUInt32LE(entry) === 1) {
      bytes.writeBigUInt64LE(0x1000n, entry + 48);
    }
  }
  fs.writeFileSync(destSo, bytes);
}

// Run the guard; return its exit code (0 on success, the failure code otherwise).
function runGuard(...archives: string[]): number {
  try {
    execFileSync('bash', [guardScript, ...archives], { stdio: 'pipe' });
    return 0;
  } catch (error) {
    return (error as { status?: number }).status ?? 1;
  }
}

describe.skipIf(!toolsPresent)('check-16kb-alignment.sh', () => {
  let workdir: string;

  beforeAll(() => {
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'align-guard-'));
  });

  afterAll(() => {
    fs.rmSync(workdir, { recursive: true, force: true });
  });

  function newLibDir(name: string, abi = 'arm64-v8a'): string {
    const libDir = path.join(workdir, name, 'lib', abi);
    fs.mkdirSync(libDir, { recursive: true });
    return libDir;
  }

  function zipTopDir(name: string, topDir: string): string {
    const archive = path.join(workdir, `${name}.apk`);
    const cwd = path.join(workdir, name);
    execFileSync('zip', ['-qr', archive, topDir], { cwd });
    return archive;
  }

  it('passes when every bundled .so is 16 KB aligned', () => {
    const libDir = newLibDir('aligned');
    fs.copyFileSync(alignedSo, path.join(libDir, 'libboard_renderer_ffi.so'));
    expect(runGuard(zipTopDir('aligned', 'lib'))).toBe(0);
  });

  it('fails when a bundled .so is only 4 KB aligned', () => {
    const libDir = newLibDir('misaligned');
    writeMisalignedCopy(alignedSo, path.join(libDir, 'libforged.so'));
    expect(runGuard(zipTopDir('misaligned', 'lib'))).toBe(1);
  });

  it('skips a misaligned 32-bit lib but still checks the 64-bit ones (passes)', () => {
    // Mirrors a real AAB: aligned 64-bit libs alongside 4 KB-aligned 32-bit libs.
    // The 16 KB rule is 64-bit only, so the armeabi-v7a lib must be skipped, not
    // fail the release.
    const arm64 = newLibDir('mixed-abi', 'arm64-v8a');
    fs.copyFileSync(alignedSo, path.join(arm64, 'libboard_renderer_ffi.so'));
    const armeabi = newLibDir('mixed-abi', 'armeabi-v7a');
    writeMisalignedCopy(alignedSo, path.join(armeabi, 'libforged.so'));
    expect(runGuard(zipTopDir('mixed-abi', 'lib'))).toBe(0);
  });

  it('still fails a misaligned x86_64 lib (64-bit is not caught by the x86 skip)', () => {
    const x64 = newLibDir('x86_64-bad', 'x86_64');
    writeMisalignedCopy(alignedSo, path.join(x64, 'libforged.so'));
    expect(runGuard(zipTopDir('x86_64-bad', 'lib'))).toBe(1);
  });

  it('fails (not just warns) when an archive ships no native libraries', () => {
    const resDir = path.join(workdir, 'nolibs', 'res');
    fs.mkdirSync(resDir, { recursive: true });
    fs.writeFileSync(path.join(resDir, 'placeholder.txt'), 'x');
    expect(runGuard(zipTopDir('nolibs', 'res'))).toBe(1);
  });

  it('fails when an archive path does not exist', () => {
    expect(runGuard(path.join(workdir, 'missing.apk'))).toBe(1);
  });

  it('fails the run when any one of several archives is misaligned', () => {
    const goodDir = newLibDir('multi-good');
    fs.copyFileSync(alignedSo, path.join(goodDir, 'lib.so'));
    const good = zipTopDir('multi-good', 'lib');

    const badDir = newLibDir('multi-bad');
    writeMisalignedCopy(alignedSo, path.join(badDir, 'lib.so'));
    const bad = zipTopDir('multi-bad', 'lib');

    expect(runGuard(good, bad)).toBe(1);
  });
});
