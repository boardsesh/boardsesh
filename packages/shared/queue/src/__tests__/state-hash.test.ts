import { describe, it, expect } from 'vitest';
import { fnv1aHash, computeQueueStateHash } from '../state-hash';

describe('state-hash', () => {
  describe('fnv1aHash', () => {
    it('returns a consistent hash for the same input', () => {
      expect(fnv1aHash('test-string')).toBe(fnv1aHash('test-string'));
    });

    it('returns different hashes for different inputs', () => {
      expect(fnv1aHash('input-1')).not.toBe(fnv1aHash('input-2'));
    });

    it('returns an 8-character hex string', () => {
      expect(fnv1aHash('test')).toMatch(/^[0-9a-f]{8}$/);
    });

    it('handles the empty string', () => {
      expect(fnv1aHash('')).toMatch(/^[0-9a-f]{8}$/);
    });
  });

  describe('computeQueueStateHash', () => {
    it('returns a consistent hash for the same queue state', () => {
      const queue = [{ uuid: 'item-1' }, { uuid: 'item-2' }];
      expect(computeQueueStateHash(queue, 'item-1')).toBe(computeQueueStateHash(queue, 'item-1'));
    });

    it('returns a different hash when the queue changes', () => {
      const queue1 = [{ uuid: 'item-1' }, { uuid: 'item-2' }];
      const queue2 = [{ uuid: 'item-1' }, { uuid: 'item-3' }];
      expect(computeQueueStateHash(queue1, 'item-1')).not.toBe(computeQueueStateHash(queue2, 'item-1'));
    });

    it('returns a different hash when currentItemUuid changes', () => {
      const queue = [{ uuid: 'item-1' }, { uuid: 'item-2' }];
      expect(computeQueueStateHash(queue, 'item-1')).not.toBe(computeQueueStateHash(queue, 'item-2'));
    });

    it('returns the same hash regardless of queue order (sorted internally)', () => {
      const queue1 = [{ uuid: 'item-1' }, { uuid: 'item-2' }];
      const queue2 = [{ uuid: 'item-2' }, { uuid: 'item-1' }];
      expect(computeQueueStateHash(queue1, 'item-1')).toBe(computeQueueStateHash(queue2, 'item-1'));
    });

    it('handles a null currentItemUuid', () => {
      expect(computeQueueStateHash([{ uuid: 'item-1' }], null)).toMatch(/^[0-9a-f]{8}$/);
    });

    it('handles an empty queue', () => {
      expect(computeQueueStateHash([], 'item-1')).toMatch(/^[0-9a-f]{8}$/);
    });

    it('handles an empty queue with a null currentItemUuid', () => {
      expect(computeQueueStateHash([], null)).toMatch(/^[0-9a-f]{8}$/);
    });

    describe('corruption handling', () => {
      it('filters out null items from the queue', () => {
        const withNull = computeQueueStateHash([{ uuid: 'item-1' }, null, { uuid: 'item-2' }], 'item-1');
        const clean = computeQueueStateHash([{ uuid: 'item-1' }, { uuid: 'item-2' }], 'item-1');
        expect(withNull).toBe(clean);
      });

      it('filters out undefined items from the queue', () => {
        const withUndefined = computeQueueStateHash([{ uuid: 'item-1' }, undefined, { uuid: 'item-2' }], 'item-1');
        const clean = computeQueueStateHash([{ uuid: 'item-1' }, { uuid: 'item-2' }], 'item-1');
        expect(withUndefined).toBe(clean);
      });

      it('filters out items with a null uuid', () => {
        const withNullUuid = computeQueueStateHash(
          [{ uuid: 'item-1' }, { uuid: null as unknown as string }, { uuid: 'item-2' }],
          'item-1',
        );
        const clean = computeQueueStateHash([{ uuid: 'item-1' }, { uuid: 'item-2' }], 'item-1');
        expect(withNullUuid).toBe(clean);
      });

      it('filters out items with an undefined uuid', () => {
        const withUndefinedUuid = computeQueueStateHash(
          [{ uuid: 'item-1' }, { uuid: undefined as unknown as string }, { uuid: 'item-2' }],
          'item-1',
        );
        const clean = computeQueueStateHash([{ uuid: 'item-1' }, { uuid: 'item-2' }], 'item-1');
        expect(withUndefinedUuid).toBe(clean);
      });

      it('treats an all-corrupt queue as empty', () => {
        const allCorrupt = computeQueueStateHash([null, undefined, { uuid: null as unknown as string }], 'item-1');
        expect(allCorrupt).toBe(computeQueueStateHash([], 'item-1'));
      });

      it('does not throw on mixed valid and corrupt items', () => {
        const queue = [
          null,
          { uuid: 'item-1' },
          undefined,
          { uuid: 'item-2' },
          { uuid: null as unknown as string },
          { uuid: 'item-3' },
        ];
        expect(() => computeQueueStateHash(queue, 'item-1')).not.toThrow();
        expect(computeQueueStateHash(queue, 'item-1')).toMatch(/^[0-9a-f]{8}$/);
      });
    });

    // Regression for issue #2359: a queue item with a valid climb but a
    // missing/null uuid survives the reducer's `climb != null` filter. The web
    // and backend hash functions used to diverge on it (web filtered, backend
    // did not), so the client watchdog disagreed with the server forever and
    // refired no-op resyncs. Now a single shared implementation makes the hash
    // of the malformed queue identical to the clean one — both sides agree.
    describe('issue #2359 — malformed-uuid drift regression', () => {
      it('hashes a queue with a missing-uuid item identically to the clean queue', () => {
        const malformed = [
          { uuid: 'climb-a' },
          { climb: { name: 'no uuid here' } } as unknown as { uuid: string },
          { uuid: 'climb-b' },
        ];
        const clean = [{ uuid: 'climb-a' }, { uuid: 'climb-b' }];
        expect(computeQueueStateHash(malformed, 'climb-a')).toBe(computeQueueStateHash(clean, 'climb-a'));
      });

      it('does not throw on a literal null entry (the pre-fix backend crash)', () => {
        expect(() => computeQueueStateHash([null, { uuid: 'climb-a' }], 'climb-a')).not.toThrow();
      });
    });
  });
});
