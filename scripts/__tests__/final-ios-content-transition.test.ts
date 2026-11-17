import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as gate from '../assert-screenshot-content';
import { assertReviewedTransition, type ReviewedTransition } from '../final-ios-content-transition';

const approved = JSON.parse(readFileSync('scripts/final-ios-content-transition.json', 'utf8')) as ReviewedTransition;
function fixture() {
  const review = structuredClone(approved);
  const candidates = review.inventory.map((relativePath) => ({ relativePath, size: 1000000 }));
  const baseline = new Map(review.inventory.map((path) => [path, 1000000]));
  const currentHashes = new Map<string, string>();
  const baselineHashes = new Map<string, string>();
  for (const record of review.exceptions) {
    candidates.find((file) => file.relativePath === record.path)!.size = record.currentRawBytes;
    baseline.set(record.path, record.baselineRawBytes);
    currentHashes.set(record.path, record.currentSha256);
    baselineHashes.set(record.path, record.baselineSha256);
  }
  const check = () => assertReviewedTransition(candidates, baseline, currentHashes, baselineHashes, review, gate);
  return { review, candidates, baseline, currentHashes, baselineHashes, check };
}

describe('reviewed frozen campaign content transition', () => {
  it('permits exactly the 40 reviewed ratios through the original classifier', () => {
    fixture().check();
  });
  it('rejects extra offenders and missing baseline/current paths', () => {
    const extra = fixture();
    const ordinary = extra.candidates.find((file) => !extra.currentHashes.has(file.relativePath))!;
    ordinary.size = 100000;
    expect(extra.check).toThrow('Unexpected ratio');
    const missing = fixture();
    missing.baseline.delete(missing.review.inventory[0]);
    expect(missing.check).toThrow('Baseline must contain');
    const missingCurrent = fixture();
    missingCurrent.candidates.pop();
    expect(missingCurrent.check).toThrow('Current inventory');
  });
  it('never exempts an absolute-floor failure on a reviewed path', () => {
    const subject = fixture();
    subject.candidates.find((file) => file.relativePath === subject.review.exceptions[0].path)!.size =
      gate.DEFAULT_MIN_BYTES - 1;
    expect(subject.check).toThrow('Absolute content floor');
  });
  it('rejects changed image hashes, raw measurements, swapped paths and duplicate records', () => {
    for (const which of ['currentHashes', 'baselineHashes'] as const) {
      const subject = fixture();
      subject[which].set(subject.review.exceptions[0].path, 'f'.repeat(64));
      expect(subject.check).toThrow('Unreviewed image bytes');
    }
    const raw = fixture();
    raw.candidates.find((file) => file.relativePath === raw.review.exceptions[0].path)!.size += 1;
    expect(raw.check).toThrow('Unreviewed raw measurement');
    const swapped = fixture();
    [swapped.review.exceptions[0].path, swapped.review.exceptions[1].path] = [
      swapped.review.exceptions[1].path,
      swapped.review.exceptions[0].path,
    ];
    expect(swapped.check).toThrow('Unreviewed image bytes');
    const duplicate = fixture();
    duplicate.review.exceptions[0] = duplicate.review.exceptions[1];
    expect(duplicate.check).toThrow('40 unique');
  });
  it('uses the original reader to reject a changed frame or corrupt sidecar', () => {
    const directory = mkdtempSync(join(tmpdir(), 'presentation-guard-'));
    const frame = Buffer.from('frame bytes');
    const manifest = {
      version: 1,
      locale: 'en-US',
      files: {
        '00-test.png': {
          rawBytes: 100000,
          rawSha256: 'a'.repeat(64),
          framedSha256: createHash('sha256').update(frame).digest('hex'),
        },
      },
    };
    try {
      writeFileSync(join(directory, '00-test.png'), frame);
      writeFileSync(join(directory, 'presentation.json'), JSON.stringify(manifest));
      expect(gate.readPngSizesRecursively(directory)[0].size).toBe(100000);
      writeFileSync(join(directory, '00-test.png'), 'changed');
      expect(() => gate.readPngSizesRecursively(directory)).toThrow('does not match');
      manifest.files['00-test.png'].rawBytes = 0;
      writeFileSync(join(directory, 'presentation.json'), JSON.stringify(manifest));
      expect(() => gate.readPngSizesRecursively(directory)).toThrow('Invalid screenshot presentation');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
