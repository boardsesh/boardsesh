// Run with: node --test mobile/scripts/version-utils.test.mjs

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { bumpPatch, compareVersions, highestVersion, normalize, pickNextVersion } from './version-utils.mjs';

describe('normalize', () => {
  it('pads 2-segment versions to 3 segments', () => {
    assert.equal(normalize('1.2'), '1.2.0');
  });

  it('passes 3-segment versions through unchanged', () => {
    assert.equal(normalize('1.2.3'), '1.2.3');
  });

  it('truncates extra segments', () => {
    assert.equal(normalize('1.2.3.4'), '1.2.3');
  });

  it('treats non-numeric segments as zero', () => {
    assert.equal(normalize('1.x.3'), '1.0.3');
  });

  it('handles leading/trailing whitespace', () => {
    assert.equal(normalize('  1.2  '), '1.2.0');
  });
});

describe('compareVersions', () => {
  it('orders by numeric value, not lexicographically', () => {
    assert.ok(compareVersions('1.10.0', '1.9.0') > 0, '1.10.0 should rank higher than 1.9.0');
    assert.ok(compareVersions('1.2.10', '1.2.9') > 0, '1.2.10 should rank higher than 1.2.9');
  });

  it('returns 0 for equal versions', () => {
    assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  });

  it('compares major before minor before patch', () => {
    assert.ok(compareVersions('2.0.0', '1.99.99') > 0);
    assert.ok(compareVersions('1.5.0', '1.4.99') > 0);
  });
});

describe('bumpPatch', () => {
  it('increments only the patch segment', () => {
    assert.equal(bumpPatch('1.2.3'), '1.2.4');
    assert.equal(bumpPatch('1.0.0'), '1.0.1');
  });
});

describe('highestVersion', () => {
  it('returns null for empty input', () => {
    assert.equal(highestVersion([]), null);
  });

  it('filters out non-string values', () => {
    assert.equal(highestVersion([null, undefined, '']), null);
  });

  it('picks the highest version after normalisation', () => {
    assert.equal(highestVersion(['1.2', '1.10.0', '1.9.0']), '1.10.0');
  });
});

describe('pickNextVersion', () => {
  it('returns source unchanged when the store has no release', () => {
    assert.equal(pickNextVersion('1.2.0', null), '1.2.0');
  });

  it('bumps patch when source matches store (cold start)', () => {
    assert.equal(pickNextVersion('1.2.0', '1.2.0'), '1.2.1');
  });

  it('respects source when it is ahead of store', () => {
    assert.equal(pickNextVersion('2.0.0', '1.2.0'), '2.0.0');
  });

  it('bumps from store when store has skipped ahead', () => {
    assert.equal(pickNextVersion('1.2.0', '1.3.0'), '1.3.1');
  });

  it('keeps idempotent next-version across reruns until store moves', () => {
    // First run: source 1.2.0, store 1.2.0 -> 1.2.1
    const first = pickNextVersion('1.2.0', '1.2.0');
    // Re-run before promotion: store still 1.2.0, source still 1.2.0 -> 1.2.1 again
    const second = pickNextVersion('1.2.0', '1.2.0');
    assert.equal(first, second);
  });

  it('handles double-digit version segments correctly', () => {
    assert.equal(pickNextVersion('1.9.0', '1.10.0'), '1.10.1');
  });
});
