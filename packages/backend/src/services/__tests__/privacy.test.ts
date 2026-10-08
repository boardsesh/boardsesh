import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
const mocks = vi.hoisted(() => {
  vi.resetModules();
  const results: unknown[][] = [];
  const select = vi.fn(() => {
    const rows = results.shift() ?? [];
    const chain = { from: () => chain, where: () => chain, limit: async () => rows, for: async () => rows };
    return chain;
  });
  const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  const values = vi.fn(() => ({ onConflictDoUpdate }));
  const insert = vi.fn(() => ({ values }));
  return { results, select, insert, values, onConflictDoUpdate };
});
vi.mock('../../db/client', () => ({ db: { select: mocks.select, insert: mocks.insert } }));
import {
  canAccessResource,
  canViewContent,
  canViewResourceLocation,
  contentVisibilityCondition,
  resourceAccessCondition,
  setContentPrivacy,
  type PrivacyExecutor,
} from '../privacy';
const executor = { select: mocks.select, insert: mocks.insert } as unknown as PrivacyExecutor;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.results.length = 0;
  vi.stubEnv('BOARDSESH_PRIVACY_ENABLED', '1');
});

describe('privacy publication consent', () => {
  it('rejects a stale queued public publication before it writes', async () => {
    mocks.results.push([{ id: 'owner' }], [{ revision: 4 }]);
    await expect(setContentPrivacy(executor, 'owner', 'tick', 'tick-id', 'public', 3)).rejects.toMatchObject({
      extensions: { code: 'PRIVACY_REVISION_CONFLICT' },
    });
    expect(mocks.insert).not.toHaveBeenCalled();
  });
  it('records current explicit public consent inside the caller transaction', async () => {
    mocks.results.push([{ id: 'owner' }], [{ revision: 4 }]);
    await setContentPrivacy(executor, 'owner', 'tick', 'tick-id', 'public', 4);
    expect(mocks.values).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'owner', entityId: 'tick-id', audience: 'public', publicConsentRevision: 4 }),
    );
  });
  it('accepts a restrictive queued publication despite a privacy revision change', async () => {
    mocks.results.push([{ id: 'owner' }], [{ revision: 4 }]);
    await setContentPrivacy(executor, 'owner', 'tick', 'tick-id', 'only_me', 3);
    expect(mocks.values).toHaveBeenCalledWith(
      expect.objectContaining({ audience: 'only_me', publicConsentRevision: null }),
    );
  });
  it('does not expose writable controls before enforcement rollout', async () => {
    vi.stubEnv('BOARDSESH_PRIVACY_ENABLED', '0');
    await expect(setContentPrivacy(executor, 'owner', 'tick', 'tick-id', 'public', 0)).rejects.toMatchObject({
      extensions: { code: 'PRIVACY_UNAVAILABLE' },
    });
    expect(mocks.select).not.toHaveBeenCalled();
  });
  it('fails closed when content still references a deleted author', async () => {
    mocks.results.push([], []);
    expect(await canViewContent('viewer', 'tick', 'tick-id', 'missing-owner')).toBe(false);
  });
});

describe('resource access compatibility and revocation', () => {
  it('keeps direct unlisted spray links readable without public discovery', async () => {
    mocks.results.push([{ ownerId: 'owner', isPublic: false, isUnlisted: true, hideLocation: true }], []);
    expect(await canAccessResource('board', 'wall', null)).toBe(true);
  });
  it('preserves anonymous system-shared catalogue access', async () => {
    mocks.results.push(
      [{ ownerId: '00000000-0000-0000-0000-000000000000', isPublic: false, isUnlisted: false, hideLocation: true }],
      [],
    );
    expect(await canAccessResource('board', 'shared', null)).toBe(true);
  });
  it('retains legacy private session participants until explicit revocation', async () => {
    mocks.results.push(
      [{ createdByUserId: 'host', isPublic: false }],
      [],
      [],
      [{ userId: 'viewer' }],
      [],
      [{ id: 'legacy-session' }],
    );
    expect(await canAccessResource('session', 'legacy-session', 'viewer')).toBe(true);
    mocks.results.push(
      [{ createdByUserId: 'host', isPublic: false }],
      [],
      [{ status: 'revoked' }],
      [{ userId: 'viewer' }],
      [],
    );
    expect(await canAccessResource('session', 'legacy-session', 'viewer')).toBe(false);
  });
  it('never uses durable participation after explicit resource privacy is installed', async () => {
    mocks.results.push([{ createdByUserId: 'host', isPublic: false }], [{ audience: 'invite_only' }], [], []);
    expect(await canAccessResource('session', 'managed-session', 'viewer')).toBe(false);
    expect(mocks.select).toHaveBeenCalledTimes(4);
  });
  it('does not widen an inaccessible parent board with a public session', async () => {
    mocks.results.push([{ createdByUserId: 'host', isPublic: true }], [], []);
    expect(await canAccessResource('session', 'public-session', null)).toBe(false);
  });
  it('hides private location even when the public board is readable', async () => {
    mocks.results.push([{ ownerId: 'owner', isPublic: true, isUnlisted: false, hideLocation: true }], []);
    expect(await canViewResourceLocation('home-wall', null)).toBe(false);
  });
});

describe('SQL policy entrypoints', () => {
  const dialect = new PgDialect();
  it('binds viewer identifiers and correlates public exceptions to the owner revision', () => {
    const compiled = dialect.sqlToQuery(
      contentVisibilityCondition('tick', sql`tick.uuid`, sql`tick.user_id`, "viewer' OR true --"),
    );
    expect(compiled.sql).not.toContain("viewer' OR true --");
    expect(compiled.params).toContain("viewer' OR true --");
    expect(compiled.sql).toContain('privacy_content.public_consent_revision = privacy_profile.privacy_revision');
    expect(compiled.sql).toContain('tick.user_id IS NULL');
  });
  it('keeps revoked grants ahead of legacy participants and follower inheritance', () => {
    const compiled = dialect.sqlToQuery(resourceAccessCondition('session', sql`tick.session_id`, 'viewer'));
    expect(compiled.sql).toContain("COALESCE(privacy_grant.status, 'pending') <> 'revoked'");
    expect(compiled.sql).toContain('privacy_override.resource_id IS NULL');
    expect(compiled.sql).toContain('legacy_participant.session_id = privacy_resource.id');
  });
});
