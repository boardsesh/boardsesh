import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Evidence, QaFailure, canonical, lease, until } from './evidence';

describe('physical QA evidence', () => {
  it('compares exact positions and colors independently of decoder order', () => {
    const first = [
      { position: 1, r: 0, g: 252, b: 255 },
      { position: 2, r: 252, g: 0, b: 255 },
    ];
    expect(canonical(first)).toBe(canonical([...first].reverse()));
    expect(canonical(first)).not.toBe(canonical([{ ...first[0], position: 3 }, first[1]]));
    expect(canonical(first)).not.toBe(canonical([{ ...first[0], g: 255 }, first[1]]));
  });
  it('redacts credentials, tokens and driver errors before writing artifacts', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'board-qa-evidence-'));
    try {
      const evidence = new Evidence(directory);
      evidence.secret('private-password');
      await expect(
        evidence.scenario('driver', [7025], async () => {
          throw new QaFailure('private-password Bearer abc.def.ghi', 'infrastructure');
        }),
      ).rejects.toThrow();
      const report = readFileSync(join(directory, 'report.json'), 'utf8');
      expect(report).not.toContain('private-password');
      expect(report).not.toContain('abc.def.ghi');
      expect(JSON.parse(report).results[0].verdict).toBe('infrastructure');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('rejects competing hardware leases and releases only its own locks', () => {
    const resource = `test-resource-${process.pid}-${Date.now()}`;
    const release = lease([resource]);
    expect(() => lease([resource])).toThrow('leased');
    release();
    lease([resource])();
  });
  it('times out rather than accepting a missing evidence signal', async () => {
    await expect(until(async () => false, Boolean, 0, 'missing command tail')).rejects.toThrow('missing command tail');
    await expect(
      until(
        async () => {
          throw new QaFailure('observer died', 'infrastructure');
        },
        Boolean,
        100,
        'observer',
      ),
    ).rejects.toMatchObject({ kind: 'infrastructure' });
  });
});
