import { describe, expect, it } from 'vite-plus/test';
import {
  transitionConsolidatedOwner,
  type ConsolidationTransitionJournal,
  type ConsolidationTransitionStore,
} from '../account-consolidation-transition';

const receipt = { mergeId: 'merge-test', fromUserId: 'source-test', toUserId: 'target-test' };
function fixture(userId = receipt.fromUserId, persisted: ConsolidationTransitionJournal | null = null) {
  const calls: string[] = [];
  let generation = 3;
  let journal = persisted;
  const store: ConsolidationTransitionStore = {
    captureOwner: () => ({ userId, generation }),
    advanceEpoch: (expected) => {
      if (expected !== generation) return null;
      calls.push('fence');
      return ++generation;
    },
    isCurrent: (expected) => expected === generation,
    pauseAndDrain: async () => {
      calls.push('pause');
      return true;
    },
    stageCredentials: async () => {
      calls.push('stage');
      return true;
    },
    readJournal: async () => journal,
    writeJournal: async (next) => {
      journal = next;
      calls.push(next.phase);
      return true;
    },
    publishCredentials: async () => {
      calls.push('credentials');
      return true;
    },
    commitLocalOwnership: async () => {
      calls.push('local-transaction');
      journal = null;
      return true;
    },
    resume: async () => {
      calls.push('resume');
    },
  };
  return {
    store,
    calls,
    journal: () => journal,
    supersede: () => {
      generation++;
    },
  };
}

describe('consolidation credential-owner transition', () => {
  it('fences before yielding and publishes credentials before changing local ownership', async () => {
    const state = fixture();
    const pending = transitionConsolidatedOwner(receipt, state.store);
    expect(state.calls).toEqual(['fence', 'pause']);
    await expect(pending).resolves.toBe('completed');
    expect(state.calls).toEqual([
      'fence',
      'pause',
      'stage',
      'prepared',
      'credentials',
      'credentials-published',
      'local-transaction',
      'resume',
    ]);
    expect(state.journal()).toBeNull();
  });
  it('repairs a partially published target credential bundle before changing local ownership', async () => {
    const state = fixture(receipt.toUserId, { ...receipt, phase: 'prepared' });
    await expect(transitionConsolidatedOwner(receipt, state.store)).resolves.toBe('completed');
    expect(state.calls).toContain('credentials');
    expect(state.calls.indexOf('credentials')).toBeLessThan(state.calls.indexOf('local-transaction'));
  });
  it('leaves a recovery journal and stays paused when local reconciliation fails', async () => {
    const state = fixture();
    state.store.commitLocalOwnership = async () => {
      throw new Error('database unavailable');
    };
    await expect(transitionConsolidatedOwner(receipt, state.store)).rejects.toThrow('database unavailable');
    expect(state.journal()?.phase).toBe('credentials-published');
    expect(state.calls).not.toContain('resume');
  });
  it('does not migrate or resume after a newer login supersedes publication', async () => {
    const state = fixture();
    state.store.publishCredentials = async () => {
      state.supersede();
      return false;
    };
    await expect(transitionConsolidatedOwner(receipt, state.store)).resolves.toBe('superseded');
    expect(state.calls).not.toContain('local-transaction');
    expect(state.calls).not.toContain('resume');
  });
  it('refuses a recovery journal for a different merge', async () => {
    const state = fixture(receipt.fromUserId, { ...receipt, mergeId: 'other-merge', phase: 'prepared' });
    await expect(transitionConsolidatedOwner(receipt, state.store)).rejects.toThrow('journal mismatch');
    expect(state.calls).not.toContain('credentials');
  });
  it('does not reassign old local data from an unjournaled canonical login', async () => {
    const state = fixture(receipt.toUserId);
    await expect(transitionConsolidatedOwner(receipt, state.store)).rejects.toThrow('journal missing');
  });
});
