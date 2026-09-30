import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { USER_EXPORT_LIFECYCLE_RULE, desiredR2Buckets, type R2LifecycleRule } from '../infra/cloudflare/config';
import { diffR2Bucket, mergeR2LifecycleRule, type LiveR2Bucket } from '../infra/cloudflare/plan';
import { applyR2LifecycleRule } from './cloudflare-apply';

const privateBucket = desiredR2Buckets.find((bucket) => bucket.name === 'boardsesh-user-private')!;
const foreignRule: R2LifecycleRule = {
  id: 'abort-uploads',
  enabled: true,
  conditions: { prefix: '' },
  abortMultipartUploadsTransition: { condition: { type: 'Age', maxAge: 86_400 } },
};
const foreignDeletionRule: R2LifecycleRule = {
  id: 'external-expiry',
  enabled: true,
  conditions: { prefix: 'user-data-exports/' },
  deleteObjectsTransition: { condition: { type: 'Age', maxAge: 86_400 } },
};

function liveBucket(lifecycleRules: R2LifecycleRule[] | null): LiveR2Bucket {
  return {
    name: privateBucket.name,
    exists: true,
    customDomains: [],
    r2DevDomainEnabled: false,
    cors: null,
    lifecycleRules,
  };
}

function envelope(result: unknown): Response {
  return new Response(JSON.stringify({ success: true, result }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('generated export retention', () => {
  it('expires only export copies and preserves foreign lifecycle transitions verbatim', () => {
    expect(mergeR2LifecycleRule([foreignRule], USER_EXPORT_LIFECYCLE_RULE)).toEqual([
      foreignRule,
      {
        id: 'boardsesh-user-data-exports-14d',
        enabled: true,
        conditions: { prefix: 'user-data-exports/' },
        deleteObjectsTransition: { condition: { type: 'Age', maxAge: 1_209_600 } },
      },
    ]);
    expect(privateBucket.customDomain).toBeNull();
    expect(privateBucket.r2DevDomainEnabled).toBe(false);
  });

  it('plans retention for a private bucket and converges without disturbing unrelated rules', () => {
    expect(diffR2Bucket(privateBucket, liveBucket([foreignRule]))).toEqual([
      expect.objectContaining({ resource: 'r2-bucket', blocked: false }),
    ]);
    expect(diffR2Bucket(privateBucket, liveBucket([foreignRule, USER_EXPORT_LIFECYCLE_RULE]))).toEqual([]);
  });

  it('blocks unreadable, duplicated, or conflicting rule ownership', () => {
    const conflicting = { ...USER_EXPORT_LIFECYCLE_RULE, conditions: { prefix: 'spray-walls/' } };
    for (const rules of [null, [conflicting], [USER_EXPORT_LIFECYCLE_RULE, USER_EXPORT_LIFECYCLE_RULE]]) {
      expect(diffR2Bucket(privateBucket, liveBucket(rules))).toEqual([expect.objectContaining({ blocked: true })]);
    }
  });

  it.each(['', 'user-data-', 'user-data-exports/', 'user-data-exports/climber/'])(
    'blocks enabled foreign deletion on an overlapping prefix %j, including an already matching owned rule',
    (prefix) => {
      const overlappingRule = { ...foreignDeletionRule, conditions: { prefix } };
      for (const rules of [[overlappingRule], [USER_EXPORT_LIFECYCLE_RULE, overlappingRule]]) {
        expect(() => mergeR2LifecycleRule(rules, USER_EXPORT_LIFECYCLE_RULE)).toThrow('overlaps');
        expect(diffR2Bucket(privateBucket, liveBucket(rules))).toEqual([
          expect.objectContaining({ blocked: true, detail: expect.stringContaining('external-expiry') }),
        ]);
      }
    },
  );

  it('preserves disabled deletion and unrelated foreign deletion rules verbatim', () => {
    const preserved = [
      foreignRule,
      { ...foreignDeletionRule, enabled: false },
      { ...foreignDeletionRule, id: 'avatar-expiry', conditions: { prefix: 'avatars/' } },
      { ...foreignDeletionRule, id: 'backup-expiry', conditions: { prefix: 'user-data-exports-backup/' } },
    ];
    expect(mergeR2LifecycleRule(preserved, USER_EXPORT_LIFECYCLE_RULE)).toEqual([
      ...preserved,
      USER_EXPORT_LIFECYCLE_RULE,
    ]);
  });

  it('re-reads the live policy and preserves every unrelated rule in the API PUT', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(envelope({ rules: [foreignRule] }))
      .mockResolvedValueOnce(envelope({}));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await applyR2LifecycleRule('test-token', 'test-account', privateBucket.name, USER_EXPORT_LIFECYCLE_RULE);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1]).toMatchObject({
      method: 'PUT',
      body: JSON.stringify({ rules: [foreignRule, USER_EXPORT_LIFECYCLE_RULE] }),
    });
  });

  it('adds retention when Cloudflare omits the optional rules list', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(envelope({})).mockResolvedValueOnce(envelope({}));
    vi.stubGlobal('fetch', fetchMock);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await applyR2LifecycleRule('test-token', 'test-account', privateBucket.name, USER_EXPORT_LIFECYCLE_RULE);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1]).toMatchObject({
      method: 'PUT',
      body: JSON.stringify({ rules: [USER_EXPORT_LIFECYCLE_RULE] }),
    });
    expect(log).toHaveBeenCalledWith(
      `[cf-apply] set lifecycle rule ${USER_EXPORT_LIFECYCLE_RULE.id} on R2 bucket ${privateBucket.name}`,
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it('preserves a bucket-wide multipart rule whose legacy response omits conditions', async () => {
    const legacyMultipartRule = {
      id: 'abort-incomplete-multipart-uploads',
      enabled: true,
      abortMultipartUploadsTransition: { condition: { type: 'Age', maxAge: 604_800 } },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(envelope({ rules: [legacyMultipartRule] }))
      .mockResolvedValueOnce(envelope({}));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await applyR2LifecycleRule('test-token', 'test-account', privateBucket.name, USER_EXPORT_LIFECYCLE_RULE);

    expect(fetchMock.mock.calls[1][1]).toMatchObject({
      method: 'PUT',
      body: JSON.stringify({
        rules: [{ ...legacyMultipartRule, conditions: { prefix: '' } }, USER_EXPORT_LIFECYCLE_RULE],
      }),
    });
  });

  it('never replaces lifecycle rules after an authorization failure', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: false }), { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(
      applyR2LifecycleRule('test-token', 'test-account', privateBucket.name, USER_EXPORT_LIFECYCLE_RULE),
    ).rejects.toThrow('refusing to replace');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(`[cf-apply] R2 lifecycle GET for ${privateBucket.name} was denied by Cloudflare`);
  });

  it('does not write an already matching policy', async () => {
    const fetchMock = vi.fn().mockResolvedValue(envelope({ rules: [foreignRule, USER_EXPORT_LIFECYCLE_RULE] }));
    vi.stubGlobal('fetch', fetchMock);
    await applyR2LifecycleRule('test-token', 'test-account', privateBucket.name, USER_EXPORT_LIFECYCLE_RULE);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('re-checks foreign deletion on the fresh read even when the owned rule already matches', async () => {
    const fetchMock = vi.fn().mockResolvedValue(envelope({ rules: [USER_EXPORT_LIFECYCLE_RULE, foreignDeletionRule] }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      applyR2LifecycleRule('test-token', 'test-account', privateBucket.name, USER_EXPORT_LIFECYCLE_RULE),
    ).rejects.toThrow('overlaps');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'GET' });
  });

  it('refuses malformed successful reads instead of clearing unknown lifecycle rules', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const result of [
      { rules: null },
      { rules: [{}] },
      { rules: [{ id: 'legacy', enabled: true, conditions: null }] },
      { rules: [{ id: 'legacy', enabled: true, conditions: { prefix: null } }] },
    ]) {
      const fetchMock = vi.fn().mockResolvedValue(envelope(result));
      vi.stubGlobal('fetch', fetchMock);
      await expect(
        applyR2LifecycleRule('test-token', 'test-account', privateBucket.name, USER_EXPORT_LIFECYCLE_RULE),
      ).rejects.toThrow('refusing to replace');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
    expect(warn).toHaveBeenCalledWith(
      `[cf-apply] R2 lifecycle GET for ${privateBucket.name} returned a non-array rules value`,
    );
    expect(warn).toHaveBeenCalledWith(
      `[cf-apply] R2 lifecycle GET for ${privateBucket.name} returned malformed rule #0` +
        ' (id: undefined, enabled: undefined, prefix: undefined)',
    );
  });
});
