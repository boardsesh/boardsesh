import { describe, expect, it, vi } from 'vitest';
import {
  prepareSprayHoldDraft,
  publishSprayHoldDraft,
  type PreparedSprayHoldDraft,
  type SprayHoldMaintenanceTransport,
  type SprayHoldMaintenanceWall,
} from '../spray-hold-maintenance';

const publishedVersion = { id: 'published-1', number: 1, status: 'PUBLISHED' as const };
const draftVersion = { id: 'draft-2', number: 2, status: 'DRAFT' as const };
const preparedDraft: PreparedSprayHoldDraft = {
  wallUuid: 'wall-1',
  layoutId: 42,
  versionId: draftVersion.id,
  versionNumber: 2,
  viewerCanEdit: true,
};

function wall(overrides: Partial<SprayHoldMaintenanceWall> = {}): SprayHoldMaintenanceWall {
  return {
    uuid: 'wall-1',
    layoutId: 42,
    viewerCanEdit: true,
    currentVersion: publishedVersion,
    versions: [publishedVersion],
    ...overrides,
  };
}

function transport() {
  return {
    fetchWall: vi.fn<SprayHoldMaintenanceTransport['fetchWall']>().mockResolvedValue(wall()),
    createDraft: vi.fn<SprayHoldMaintenanceTransport['createDraft']>().mockResolvedValue(draftVersion),
    publishDraft: vi.fn<SprayHoldMaintenanceTransport['publishDraft']>().mockResolvedValue({
      ...draftVersion,
      status: 'PUBLISHED',
    }),
  };
}

describe('prepareSprayHoldDraft', () => {
  it('creates from the published version with server wall identity and geometry', async () => {
    const requests = transport();
    await expect(prepareSprayHoldDraft('wall-1', requests)).resolves.toEqual(preparedDraft);
    expect(requests.createDraft).toHaveBeenCalledExactlyOnceWith({
      wallUuid: 'wall-1',
      sourceVersionId: 'published-1',
    });
  });

  it('resumes the one existing draft, including an unfinished first setup', async () => {
    const requests = transport();
    requests.fetchWall.mockResolvedValue(wall({ currentVersion: null, versions: [draftVersion] }));
    await expect(prepareSprayHoldDraft('wall-1', requests)).resolves.toEqual(preparedDraft);
    expect(requests.createDraft).not.toHaveBeenCalled();
  });

  it.each([null, wall({ viewerCanEdit: false }), wall({ uuid: 'different-wall' })])(
    'refuses missing, read-only or mismatched wall responses before a write',
    async (wallResponse) => {
      const requests = transport();
      requests.fetchWall.mockResolvedValue(wallResponse);
      await expect(prepareSprayHoldDraft('wall-1', requests)).rejects.toMatchObject({ reason: 'unavailable' });
      expect(requests.createDraft).not.toHaveBeenCalled();
    },
  );

  it('does not manufacture a version when the wall has no photograph', async () => {
    const requests = transport();
    requests.fetchWall.mockResolvedValue(wall({ currentVersion: null, versions: [] }));
    await expect(prepareSprayHoldDraft('wall-1', requests)).rejects.toMatchObject({ reason: 'nothingPublished' });
    expect(requests.createDraft).not.toHaveBeenCalled();
  });

  it.each(['lost create response', 'another editor won the wall lock'])(
    'finds the durable draft after %s instead of creating again',
    async (message) => {
      const requests = transport();
      requests.createDraft.mockRejectedValue(new Error(message));
      requests.fetchWall
        .mockResolvedValueOnce(wall())
        .mockResolvedValueOnce(wall({ versions: [publishedVersion, draftVersion] }));
      await expect(prepareSprayHoldDraft('wall-1', requests)).resolves.toEqual(preparedDraft);
      expect(requests.createDraft).toHaveBeenCalledTimes(1);
      expect(requests.fetchWall).toHaveBeenCalledTimes(2);
    },
  );

  it('keeps a create failure retryable when no draft actually landed', async () => {
    const requests = transport();
    const failure = new Error('offline');
    requests.createDraft.mockRejectedValue(failure);
    await expect(prepareSprayHoldDraft('wall-1', requests)).rejects.toBe(failure);
    expect(requests.createDraft).toHaveBeenCalledTimes(1);
  });

  it('checks permission again before adopting a racing draft', async () => {
    const requests = transport();
    requests.createDraft.mockRejectedValue(new Error('lost response'));
    requests.fetchWall
      .mockResolvedValueOnce(wall())
      .mockResolvedValueOnce(wall({ viewerCanEdit: false, versions: [draftVersion] }));
    await expect(prepareSprayHoldDraft('wall-1', requests)).rejects.toMatchObject({ reason: 'unavailable' });
  });

  it('preserves the create failure if the recovery read also fails', async () => {
    const requests = transport();
    const createFailure = new Error('create failed');
    requests.createDraft.mockRejectedValue(createFailure);
    requests.fetchWall.mockResolvedValueOnce(wall()).mockRejectedValueOnce(new Error('recovery offline'));
    await expect(prepareSprayHoldDraft('wall-1', requests)).rejects.toBe(createFailure);
    expect(requests.createDraft).toHaveBeenCalledTimes(1);
  });
});

describe('publishSprayHoldDraft', () => {
  it('publishes exactly the prepared draft after a fresh permission read', async () => {
    const requests = transport();
    requests.fetchWall.mockResolvedValue(wall({ versions: [publishedVersion, draftVersion] }));
    await expect(publishSprayHoldDraft(preparedDraft, requests)).resolves.toBeUndefined();
    expect(requests.publishDraft).toHaveBeenCalledExactlyOnceWith('draft-2');
  });

  it.each(['PUBLISHED', 'SUPERSEDED'] as const)('does not republish a %s version', async (status) => {
    const requests = transport();
    requests.fetchWall.mockResolvedValue(wall({ versions: [{ ...draftVersion, status }] }));
    await expect(publishSprayHoldDraft(preparedDraft, requests)).resolves.toBeUndefined();
    expect(requests.publishDraft).not.toHaveBeenCalled();
  });

  it('reconciles a publish that committed before its response disappeared', async () => {
    const requests = transport();
    requests.fetchWall
      .mockResolvedValueOnce(wall({ versions: [draftVersion] }))
      .mockResolvedValueOnce(wall({ versions: [{ ...draftVersion, status: 'PUBLISHED' }] }));
    requests.publishDraft.mockRejectedValue(new Error('lost publish response'));
    await expect(publishSprayHoldDraft(preparedDraft, requests)).resolves.toBeUndefined();
    expect(requests.publishDraft).toHaveBeenCalledTimes(1);
  });

  it('retains a failed publish for retry when the exact version is still a draft', async () => {
    const requests = transport();
    const failure = new Error('offline');
    requests.fetchWall.mockResolvedValue(wall({ versions: [draftVersion] }));
    requests.publishDraft.mockRejectedValue(failure);
    await expect(publishSprayHoldDraft(preparedDraft, requests)).rejects.toBe(failure);
    expect(requests.publishDraft).toHaveBeenCalledTimes(1);
  });

  it('preserves the publish failure if the recovery read also fails', async () => {
    const requests = transport();
    const publishFailure = new Error('publish failed');
    requests.publishDraft.mockRejectedValue(publishFailure);
    requests.fetchWall
      .mockResolvedValueOnce(wall({ versions: [draftVersion] }))
      .mockRejectedValueOnce(new Error('recovery offline'));
    await expect(publishSprayHoldDraft(preparedDraft, requests)).rejects.toBe(publishFailure);
    expect(requests.publishDraft).toHaveBeenCalledTimes(1);
  });

  it('reports revoked access when recovery finds a published but no longer editable wall', async () => {
    const requests = transport();
    requests.publishDraft.mockRejectedValue(new Error('lost publish response'));
    requests.fetchWall
      .mockResolvedValueOnce(wall({ versions: [draftVersion] }))
      .mockResolvedValueOnce(wall({ viewerCanEdit: false, versions: [{ ...draftVersion, status: 'PUBLISHED' }] }));
    await expect(publishSprayHoldDraft(preparedDraft, requests)).rejects.toMatchObject({ reason: 'unavailable' });
    expect(requests.publishDraft).toHaveBeenCalledTimes(1);
  });

  it.each([
    wall({ versions: [] }),
    wall({ versions: [{ ...draftVersion, number: 3 }] }),
    wall({ layoutId: 99, versions: [draftVersion] }),
  ])('never switches to a replacement draft or layout', async (wallResponse) => {
    const requests = transport();
    requests.fetchWall.mockResolvedValue(wallResponse);
    await expect(publishSprayHoldDraft(preparedDraft, requests)).rejects.toMatchObject({ reason: 'draftUnavailable' });
    expect(requests.publishDraft).not.toHaveBeenCalled();
  });

  it('refuses publication if edit access was revoked after saving', async () => {
    const requests = transport();
    requests.fetchWall.mockResolvedValue(wall({ viewerCanEdit: false, versions: [draftVersion] }));
    await expect(publishSprayHoldDraft(preparedDraft, requests)).rejects.toMatchObject({ reason: 'unavailable' });
    expect(requests.publishDraft).not.toHaveBeenCalled();
  });
});
