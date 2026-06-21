import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { climbCountForPlaylist, MIN_CLIMBS_PER_PLAYLIST, MAX_CLIMBS_PER_PLAYLIST } from './seed-playlist-climbs.js';

// The dev DB is a pre-built image, so the playlist seed must be byte-stable
// across rebuilds. `climbCountForPlaylist` is the deterministic core of that
// invariant — these guard it directly (the DB-touching selection is covered by
// the live-DB validation in the PR).
void describe('climbCountForPlaylist', () => {
  void it('is deterministic — same id always yields the same count', () => {
    for (const id of [1n, 7n, 42n, 1000n, 9007199254740993n]) {
      assert.equal(climbCountForPlaylist(id), climbCountForPlaylist(id));
    }
  });

  void it('always returns a count within [MIN, MAX] inclusive', () => {
    for (let id = 0n; id < 200n; id++) {
      const count = climbCountForPlaylist(id);
      assert.ok(
        count >= MIN_CLIMBS_PER_PLAYLIST && count <= MAX_CLIMBS_PER_PLAYLIST,
        `climbCountForPlaylist(${id}) = ${count} is outside [${MIN_CLIMBS_PER_PLAYLIST}, ${MAX_CLIMBS_PER_PLAYLIST}]`,
      );
    }
  });

  void it('stays in range for ids beyond Number.MAX_SAFE_INTEGER (bigint, no precision loss)', () => {
    const big = 123456789012345678901234567890n;
    const count = climbCountForPlaylist(big);
    assert.ok(count >= MIN_CLIMBS_PER_PLAYLIST && count <= MAX_CLIMBS_PER_PLAYLIST);
  });

  void it('maps consecutive ids across the full span (varied playlist sizes)', () => {
    const span = MAX_CLIMBS_PER_PLAYLIST - MIN_CLIMBS_PER_PLAYLIST + 1;
    const seen = new Set<number>();
    for (let id = 0n; id < BigInt(span); id++) {
      seen.add(climbCountForPlaylist(id));
    }
    // One full span of consecutive ids should hit every count exactly once.
    assert.equal(seen.size, span);
    assert.equal(Math.min(...seen), MIN_CLIMBS_PER_PLAYLIST);
    assert.equal(Math.max(...seen), MAX_CLIMBS_PER_PLAYLIST);
  });
});
