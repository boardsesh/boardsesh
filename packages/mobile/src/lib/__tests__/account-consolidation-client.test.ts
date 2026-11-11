import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  generation: 1,
  stage: null as string | null,
  jwt: '',
  refreshToken: null as string | null,
  events: [] as string[],
  failLocal: false,
  failStage: false,
  supersedeOnStage: false,
  localOwner: 'source',
}));
const token = (sub: string) => `header.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.signature`;
vi.mock('@boardsesh/offline-sync', () => ({
  beginGlobalPurge: () => state.events.push('fence'),
  setSigningOut: (paused: boolean) => state.events.push(paused ? 'pause' : 'resume'),
}));
vi.mock('../../db', () => ({
  getDatabaseHandle: () => ({ getFirstAsync: async () => ({ value: state.localOwner }) }),
  clearUserData: async (
    _database: unknown,
    options: { fromUserId: string; toUserId: string; isCurrent(): boolean },
  ) => {
    expect(options).toMatchObject({ fromUserId: 'source', toUserId: 'target' });
    expect(options.isCurrent()).toBe(true);
    state.events.push('local-transaction');
    if (state.failLocal) throw new Error('disk unavailable');
  },
}));
vi.mock('../auth-store', () => ({
  captureAuthCredentialGeneration: () => state.generation,
  isAuthCredentialGenerationCurrent: (generation: number) => generation === state.generation,
  advanceAuthConsolidationEpoch: (generation: number) => (generation === state.generation ? ++state.generation : null),
  readConsolidationStage: async () => state.stage,
  getAuthToken: async () => state.jwt,
  writeConsolidationStageForGeneration: async (generation: number, contents: string) => {
    if (generation !== state.generation) return false;
    if (state.supersedeOnStage) state.generation += 1;
    if (state.failStage) throw new Error('secure storage unavailable');
    state.stage = contents;
    state.events.push('stage');
    return true;
  },
  storeTokensForGeneration: async (generation: number, jwt: string, refreshToken: string) => {
    if (generation !== state.generation) return false;
    expect(state.stage).not.toBeNull();
    state.jwt = jwt;
    state.refreshToken = refreshToken;
    state.events.push('publish');
    return true;
  },
  clearConsolidationStageForGeneration: async (generation: number) => {
    if (generation !== state.generation) return false;
    state.stage = null;
    state.events.push('clear-stage');
    return true;
  },
}));
import {
  acceptNativeAccountConsolidation,
  resumePendingAccountConsolidation,
  setOnAccountConsolidated,
} from '../account-consolidation-client';
const reply = () => ({
  jwt: token('target'),
  refreshToken: 'canonical-refresh',
  expiresAt: '2030-01-01T00:00:00Z',
  accountConsolidation: { mergeId: 'merge', fromUserId: 'source', toUserId: 'target' },
});
beforeEach(() => {
  state.generation = 1;
  state.stage = null;
  state.jwt = token('source');
  state.refreshToken = 'source-refresh';
  state.events = [];
  state.failLocal = false;
  state.failStage = false;
  state.supersedeOnStage = false;
  state.localOwner = 'source';
  setOnAccountConsolidated(null);
});
describe('native account consolidation adapter', () => {
  it('stages the full bundle before publishing and resumes only after local ownership commits', async () => {
    const completed = vi.fn();
    setOnAccountConsolidated(completed);
    expect(await acceptNativeAccountConsolidation(reply(), state.jwt, 1)).toBe(2);
    expect(state.events).toEqual([
      'fence',
      'pause',
      'stage',
      'stage',
      'publish',
      'stage',
      'local-transaction',
      'clear-stage',
      'resume',
    ]);
    expect(state.stage).toBeNull();
    expect(completed).toHaveBeenCalledOnce();
  });
  it('retains the journal after a local failure and recovers with already published canonical credentials', async () => {
    state.failLocal = true;
    await expect(acceptNativeAccountConsolidation(reply(), state.jwt, 1)).rejects.toThrow('disk unavailable');
    expect(state.stage).not.toBeNull();
    expect(state.events).not.toContain('resume');
    state.failLocal = false;
    state.events = [];
    await resumePendingAccountConsolidation();
    expect(state.events).toEqual(['fence', 'pause', 'publish', 'stage', 'local-transaction', 'clear-stage', 'resume']);
    expect(state.stage).toBeNull();
  });
  it('releases its own pause when staging fails before any credentials are published', async () => {
    state.failStage = true;
    const retry = vi.fn();
    setOnAccountConsolidated(retry);
    await expect(acceptNativeAccountConsolidation(reply(), state.jwt, 1)).rejects.toThrow('secure storage unavailable');
    expect(state.stage).toBeNull();
    expect(state.events).toEqual(['fence', 'pause', 'resume']);
    expect(retry).toHaveBeenCalledOnce();
  });
  it('never releases a newer login or signout pause when its stage write fails after supersession', async () => {
    state.failStage = true;
    state.supersedeOnStage = true;
    const retry = vi.fn();
    setOnAccountConsolidated(retry);
    await expect(acceptNativeAccountConsolidation(reply(), state.jwt, 1)).rejects.toThrow('secure storage unavailable');
    expect(state.events).toEqual(['fence', 'pause']);
    expect(retry).not.toHaveBeenCalled();
  });
  it('recovers a missing JWT from the complete stage and exact source local-owner stamp', async () => {
    state.failLocal = true;
    await expect(acceptNativeAccountConsolidation(reply(), state.jwt, 1)).rejects.toThrow('disk unavailable');
    state.jwt = '';
    state.failLocal = false;
    await resumePendingAccountConsolidation();
    expect(state.jwt).toBe(token('target'));
    expect(state.stage).toBeNull();
  });
  it('does not recover a missing JWT over another local owner', async () => {
    state.failLocal = true;
    await expect(acceptNativeAccountConsolidation(reply(), state.jwt, 1)).rejects.toThrow('disk unavailable');
    state.jwt = '';
    state.localOwner = 'unrelated';
    state.failLocal = false;
    await expect(resumePendingAccountConsolidation()).rejects.toThrow('owner unavailable');
    expect(state.stage).not.toBeNull();
  });
  it('republishes the complete staged bundle when recovery sees canonical JWT with a missing refresh token', async () => {
    state.failLocal = true;
    await expect(acceptNativeAccountConsolidation(reply(), state.jwt, 1)).rejects.toThrow('disk unavailable');
    state.refreshToken = null;
    state.failLocal = false;
    await resumePendingAccountConsolidation();
    expect(state.refreshToken).toBe('canonical-refresh');
    expect(state.stage).toBeNull();
  });
  it('never stages a stale response over a newer login', async () => {
    state.generation = 3;
    expect(await acceptNativeAccountConsolidation(reply(), token('source'), 1)).toBeNull();
    expect(state.events).toEqual([]);
  });
  it('rejects a mismatched receipt before advancing the epoch', async () => {
    const response = reply();
    response.accountConsolidation.toUserId = 'unrelated';
    await expect(acceptNativeAccountConsolidation(response, state.jwt, 1)).rejects.toThrow('owner mismatch');
    expect(state.generation).toBe(1);
    expect(state.events).toEqual([]);
  });
  it('rejects incomplete credentials before advancing the epoch', async () => {
    await expect(acceptNativeAccountConsolidation({ ...reply(), refreshToken: '' }, state.jwt, 1)).rejects.toThrow(
      'staged credentials',
    );
    expect(state.generation).toBe(1);
  });
});
