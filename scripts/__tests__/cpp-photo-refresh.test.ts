import { getOperationAST, parse } from 'graphql';
import { describe, expect, it, vi } from 'vitest';
import { createCppPhotoRefreshDownloader, type CppPhotoRefreshOptions } from '../lib/cpp-photo-refresh';
import type { GraphqlFixtureFile } from '../lib/screenshot-fixtures';

const ACCOUNT = 'screenshot-account';
const WALL = '00000000-0000-4000-8000-000000000001';
const ORIGIN = 'https://private.example.r2.cloudflarestorage.com';
function photoUrl(filename: string, signature = 'fresh'): string {
  return `${ORIGIN}/spray-walls/${WALL}/${filename}?X-Amz-Signature=${signature}`;
}

function wallEntity() {
  const photo = { url: photoUrl('current.jpg'), thumbUrl: photoUrl('current-thumb.jpg') };
  return {
    uuid: WALL,
    layoutId: 42,
    board: { ownerId: ACCOUNT },
    currentVersion: { id: '100', number: 1, photo },
    versions: [
      { id: '100', number: 1, photo },
      { id: '101', number: 2, photo: { url: photoUrl('draft.jpg'), thumbUrl: photoUrl('draft-thumb.jpg') } },
    ],
  };
}

function draftFixture(version: number | null = 2): GraphqlFixtureFile {
  return {
    formatVersion: 1,
    operationName: 'GetSprayWallDraftRenderData',
    documentHash: 'recorded-document',
    variablesHash: 'recorded-variables',
    query: 'query GetSprayWallDraftRenderData { recorded }',
    variables: { uuid: WALL, version },
    response: {
      data: {
        sprayWallRenderData: {
          versionNumber: 2,
          photoFullUrl: photoUrl('draft-full.jpg', 'expired'),
          homography: [1, 0, 0, 0, 1, 0, 0, 0, 1],
          holds: [{ id: 5, cx: 12, cy: 42 }],
          wall: wallEntity(),
        },
      },
    },
    status: 200,
    recordedAt: '2026-10-11T12:00:00Z',
    upstream: 'https://ws.boardsesh.com',
  };
}

function harness(recordedFixtures: GraphqlFixtureFile[] = []) {
  const wall = wallEntity();
  const draft = { versionNumber: 2, photoFullUrl: photoUrl('draft-full.jpg'), wall };
  const operations: Array<{ name: string; variables: Record<string, unknown> }> = [];
  const download = vi.fn<typeof fetch>(async () => new Response('bytes'));
  const options: CppPhotoRefreshOptions = {
    accountUserId: ACCOUNT,
    authenticatedAccountUserId: ACCOUNT,
    authorizedWalls: [{ wallUuid: WALL, layoutId: 42 }],
    recordedFixtures,
    download,
    transport: {
      async request<T>(query: string, variables: Record<string, unknown>): Promise<T> {
        const operation = getOperationAST(parse(query));
        expect(operation?.operation).toBe('query');
        const name = operation?.name?.value ?? '';
        operations.push({ name, variables });
        if (name === 'GetSprayWallWithVersions') return { sprayWall: wall } as T;
        if (name === 'GetSprayWallDraftRenderData') return { sprayWallRenderData: draft } as T;
        throw new Error('Unexpected operation');
      },
    },
  };
  return { options, wall, draft, operations, download };
}

describe('read-only owned CPP photo signature refresh', () => {
  it('replaces only signatures for the exact recorded objects, preserving download guards', async () => {
    const { options, operations, download } = harness();
    const refresh = await createCppPhotoRefreshDownloader(options);
    const signal = AbortSignal.timeout(30_000);
    await refresh(photoUrl('current.jpg', 'expired'), { redirect: 'error', signal });
    await refresh(photoUrl('draft-thumb.jpg', 'expired'));
    expect(download.mock.calls).toEqual([
      [photoUrl('current.jpg'), { redirect: 'error', signal }],
      [photoUrl('draft-thumb.jpg'), undefined],
    ]);
    expect(operations).toEqual([{ name: 'GetSprayWallWithVersions', variables: { uuid: WALL } }]);
  });

  it('authenticates the exact recording account before querying or downloading', async () => {
    const { options, operations, download } = harness();
    options.authenticatedAccountUserId = 'different-account';
    await expect(createCppPhotoRefreshDownloader(options)).rejects.toThrow('recorded screenshot account');
    expect(operations).toEqual([]);
    expect(download).not.toHaveBeenCalled();
  });

  it.each(['owner', 'uuid', 'layout'] as const)(
    'rejects a changed wall %s before granting any download',
    async (field) => {
      const { options, wall, download } = harness();
      if (field === 'owner') wall.board.ownerId = 'another-owner';
      if (field === 'uuid') wall.uuid = 'another-wall';
      if (field === 'layout') wall.layoutId = 99;
      await expect(createCppPhotoRefreshDownloader(options)).rejects.toThrow('recorded owner and identity');
      expect(download).not.toHaveBeenCalled();
    },
  );

  it.each([
    photoUrl('unknown.jpg', 'expired'),
    photoUrl('current.jpg', 'expired').replace(ORIGIN, 'https://other.example.r2.cloudflarestorage.com'),
    photoUrl('current.jpg', 'expired').replace(ORIGIN, 'https://public.example.test'),
    photoUrl('current.jpg', 'expired').replace(WALL, 'another-wall'),
  ])('refuses an unmapped object without making a download request', async (source) => {
    const { options, download } = harness();
    const refresh = await createCppPhotoRefreshDownloader(options);
    await expect(refresh(source)).rejects.toThrow(/no matching fresh signature|not an authorized wall|private R2/);
    expect(download).not.toHaveBeenCalled();
  });

  it('rejects fresh photo signatures that escape the owned private R2 wall', async () => {
    const { options, wall } = harness();
    wall.versions[1].photo.url = photoUrl('draft.jpg').replace(WALL, 'another-wall');
    await expect(createCppPhotoRefreshDownloader(options)).rejects.toThrow('authorized private R2 wall');
  });

  it('refreshes full resolution only for exact recorded versions and leaves recorded geometry untouched', async () => {
    const fixture = draftFixture();
    const recordedBytes = JSON.stringify(fixture);
    const { options, operations, download } = harness([fixture, structuredClone(fixture)]);
    const refresh = await createCppPhotoRefreshDownloader(options);
    await refresh(photoUrl('draft-full.jpg', 'expired'));
    expect(operations).toEqual([
      { name: 'GetSprayWallWithVersions', variables: { uuid: WALL } },
      { name: 'GetSprayWallDraftRenderData', variables: { uuid: WALL, version: 2 } },
    ]);
    expect(download).toHaveBeenCalledWith(photoUrl('draft-full.jpg'), undefined);
    expect(JSON.stringify(fixture)).toBe(recordedBytes);
  });

  it('pins an originally default version read to its actual recorded version number', async () => {
    const { options, operations } = harness([draftFixture(null)]);
    await createCppPhotoRefreshDownloader(options);
    expect(operations[1].variables).toEqual({ uuid: WALL, version: 2 });
  });

  it('rejects a version number reused after its immutable row was replaced', async () => {
    const { options, wall, operations } = harness([draftFixture()]);
    wall.versions[1].id = 'replacement-row';
    await expect(createCppPhotoRefreshDownloader(options)).rejects.toThrow('version was removed or replaced');
    expect(operations).toHaveLength(1);
  });

  it('rejects full-resolution object substitution even when its wall and version still match', async () => {
    const { options, draft, download } = harness([draftFixture()]);
    draft.photoFullUrl = photoUrl('different-full.jpg');
    await expect(createCppPhotoRefreshDownloader(options)).rejects.toThrow('object or version does not match');
    expect(download).not.toHaveBeenCalled();
  });

  it('rechecks the owner and immutable version on the full-resolution response', async () => {
    const { options, draft } = harness([draftFixture()]);
    draft.wall = structuredClone(draft.wall);
    draft.wall.versions[1].id = 'replaced-between-queries';
    await expect(createCppPhotoRefreshDownloader(options)).rejects.toThrow('object or version does not match');
  });

  it('never replays recorded mutations or fetches draft payloads without a recorded full photo', async () => {
    const withoutFullPhoto = draftFixture();
    const response = withoutFullPhoto.response as { data: { sprayWallRenderData: { photoFullUrl: string | null } } };
    response.data.sprayWallRenderData.photoFullUrl = null;
    const mutation = { ...draftFixture(), operationName: 'CreateSprayWallVersion' };
    const { options, operations } = harness([withoutFullPhoto, mutation]);
    await createCppPhotoRefreshDownloader(options);
    expect(operations.map(({ name }) => name)).toEqual(['GetSprayWallWithVersions']);
  });
});
