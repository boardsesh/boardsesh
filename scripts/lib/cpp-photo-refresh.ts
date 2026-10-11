import {
  GET_SPRAY_WALL_WITH_VERSIONS,
  GET_SPRAY_WALL_DRAFT_RENDER_DATA,
} from '../../packages/shared/graphql/src/operations/spray-walls';
import type { GraphqlFixtureFile } from './screenshot-fixtures';

interface RefreshWall {
  wallUuid: string;
  layoutId: number;
}

interface RefreshVersion {
  id?: string;
  number?: number;
  photo?: { url: string; thumbUrl?: string | null } | null;
}

interface RefreshWallEntity {
  uuid: string;
  layoutId: number;
  board: { ownerId: string };
  currentVersion?: RefreshVersion | null;
  versions?: RefreshVersion[];
}

export interface CppPhotoRefreshOptions {
  accountUserId: string;
  authenticatedAccountUserId: string;
  authorizedWalls: readonly RefreshWall[];
  recordedFixtures: readonly GraphqlFixtureFile[];
  transport: {
    request<T>(query: string, variables: Record<string, unknown>): Promise<T>;
  };
  download?: typeof fetch;
}

/** Signatures may change; private R2 origin and object pathname must not. */
function photoObjectKey(source: string, wallUuid: string): string {
  let parsed: URL;
  try {
    parsed = new URL(source);
  } catch {
    throw new Error('Invalid spray photo refresh URL');
  }
  if (
    parsed.protocol !== 'https:' ||
    !/^[a-z0-9.-]+\.r2\.cloudflarestorage\.com$/.test(parsed.hostname) ||
    !parsed.pathname.startsWith(`/spray-walls/${wallUuid}/`) ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  )
    throw new Error('Spray photo refresh is not the authorized private R2 wall');
  return `${parsed.origin}${parsed.pathname}`;
}

function versions(wall: RefreshWallEntity): RefreshVersion[] {
  return [...(wall.currentVersion ? [wall.currentVersion] : []), ...(wall.versions ?? [])];
}

function verifyWall(wall: RefreshWallEntity | null | undefined, expected: RefreshWall, accountUserId: string): void {
  if (
    !wall ||
    wall.uuid !== expected.wallUuid ||
    wall.layoutId !== expected.layoutId ||
    wall.board?.ownerId !== accountUserId
  )
    throw new Error('Spray photo refresh wall does not match the recorded owner and identity');
}

/**
 * Read fresh signatures for owned walls without replaying recorded mutations.
 * The returned downloader changes only the URL used for transport: recorded
 * responses, version IDs, photo dimensions and homographies remain untouched.
 */
export async function createCppPhotoRefreshDownloader(options: CppPhotoRefreshOptions): Promise<typeof fetch> {
  const { accountUserId, authenticatedAccountUserId, authorizedWalls, recordedFixtures, transport } = options;
  if (!accountUserId || authenticatedAccountUserId !== accountUserId)
    throw new Error('Spray photo refresh requires the recorded screenshot account');
  if (
    !authorizedWalls.length ||
    authorizedWalls.some(({ wallUuid, layoutId }) => !wallUuid || !Number.isSafeInteger(layoutId) || layoutId < 1) ||
    new Set(authorizedWalls.map(({ wallUuid }) => wallUuid)).size !== authorizedWalls.length
  )
    throw new Error('Spray photo refresh requires distinct authorized wall identities');

  const freshUrls = new Map<string, string>();
  function addPhoto(version: RefreshVersion, wallUuid: string): void {
    if (!version.photo) return;
    for (const source of [version.photo.url, version.photo.thumbUrl]) {
      if (source) freshUrls.set(photoObjectKey(source, wallUuid), source);
    }
  }
  for (const expectedWall of authorizedWalls) {
    const result = await transport.request<{ sprayWall: RefreshWallEntity | null }>(GET_SPRAY_WALL_WITH_VERSIONS, {
      uuid: expectedWall.wallUuid,
    });
    verifyWall(result.sprayWall, expectedWall, accountUserId);
    const liveWall = result.sprayWall!;
    for (const version of versions(liveWall)) addPhoto(version, expectedWall.wallUuid);

    const refreshedDrafts = new Set<string>();
    for (const fixture of recordedFixtures) {
      if (fixture.operationName !== 'GetSprayWallDraftRenderData') continue;
      const variables = fixture.variables as { uuid?: string; version?: number | null };
      if (variables.uuid !== expectedWall.wallUuid) continue;
      const recorded = (
        fixture.response as {
          data?: {
            sprayWallRenderData?: {
              versionNumber?: number;
              photoFullUrl?: string | null;
              wall?: RefreshWallEntity;
            };
          };
        }
      ).data?.sprayWallRenderData;
      if (!recorded?.photoFullUrl) continue;
      if (recorded.wall?.uuid !== expectedWall.wallUuid)
        throw new Error('Recorded full-photo refresh wall identity does not match');
      const versionNumber = variables.version ?? recorded.versionNumber;
      if (!Number.isSafeInteger(versionNumber) || (versionNumber ?? 0) < 1 || recorded.versionNumber !== versionNumber)
        throw new Error('Recorded full-photo refresh requires an exact version number');
      const recordedVersion = versions(recorded.wall).find((version) => version.number === versionNumber);
      const liveVersion = versions(liveWall).find((version) => version.number === versionNumber);
      if (!liveVersion || (recordedVersion?.id && liveVersion.id !== recordedVersion.id))
        throw new Error('Recorded full-photo refresh version was removed or replaced');
      const recordedObject = photoObjectKey(recorded.photoFullUrl, expectedWall.wallUuid);
      if (refreshedDrafts.has(recordedObject)) continue;
      const draftResult = await transport.request<{
        sprayWallRenderData: {
          versionNumber: number;
          photoFullUrl?: string | null;
          wall: RefreshWallEntity;
        } | null;
      }>(GET_SPRAY_WALL_DRAFT_RENDER_DATA, { uuid: expectedWall.wallUuid, version: versionNumber });
      const draft = draftResult.sprayWallRenderData;
      verifyWall(draft?.wall, expectedWall, accountUserId);
      const draftVersion = draft ? versions(draft.wall).find((version) => version.number === versionNumber) : undefined;
      if (
        !draft ||
        draft.versionNumber !== versionNumber ||
        (liveVersion.id && draftVersion?.id !== liveVersion.id) ||
        !draft.photoFullUrl ||
        photoObjectKey(draft.photoFullUrl, expectedWall.wallUuid) !== recordedObject
      )
        throw new Error('Refreshed full-photo object or version does not match the recording');
      freshUrls.set(recordedObject, draft.photoFullUrl);
      refreshedDrafts.add(recordedObject);
    }
  }

  const download = options.download ?? fetch;
  return async (input, init) => {
    const source = input instanceof Request ? input.url : String(input);
    // Match the whole immutable object identity, never a filename or URL query.
    const expectedWall = authorizedWalls.find(({ wallUuid }) => {
      try {
        return new URL(source).pathname.startsWith(`/spray-walls/${wallUuid}/`);
      } catch {
        return false;
      }
    });
    if (!expectedWall) throw new Error('Spray photo refresh download is not an authorized wall');
    const fresh = freshUrls.get(photoObjectKey(source, expectedWall.wallUuid));
    if (!fresh) throw new Error('Recorded spray photo object has no matching fresh signature');
    return download(fresh, init);
  };
}
