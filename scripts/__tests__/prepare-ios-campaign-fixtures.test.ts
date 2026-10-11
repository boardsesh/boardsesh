/// <reference types="node" />

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  prepareIosCampaignFixturesForWalls,
  authorizedCppWallsFromRecording,
  type AuthorizedCampaignWall,
} from '../prepare-ios-campaign-fixtures';
import {
  GET_SPRAY_WALL_WITH_VERSIONS,
  GET_SPRAY_WALL_DRAFT_RENDER_DATA,
  GET_SPRAY_WALL_RENDER_DATA,
  CREATE_SPRAY_WALL_VERSION,
} from '../../packages/shared/graphql/src/operations/spray-walls';
import { emptyManifest, type GraphqlFixtureFile, type ScreenshotFixtureManifest } from '../lib/screenshot-fixtures';

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));
const WALLS: AuthorizedCampaignWall[] = [1, 2, 3].map((layoutId) => ({
  layoutId,
  wallUuid: `00000000-0000-4000-8000-${String(layoutId).padStart(12, '0')}`,
}));

function recording(walls = WALLS, mismatchedRender = false): { input: string; output: string } {
  const directory = mkdtempSync(join(tmpdir(), 'cpp-wall-preparation-'));
  directories.push(directory);
  const input = join(directory, 'recording');
  const output = join(directory, 'candidate');
  const manifest = emptyManifest({
    recordedAt: '2026-10-11T12:00:00Z',
    frozenNow: '2026-10-11T12:00:00Z',
    upstream: 'https://ws.boardsesh.com',
    accountEmail: 'test@boardsesh.com',
    accountUserId: 'test-account',
    flow: 'app-store',
  });
  mkdirSync(join(input, 'graphql'), { recursive: true });
  for (const { wallUuid, layoutId } of walls) {
    const operationName = mismatchedRender ? 'GetSprayWallRenderData' : 'GetSprayWallByLayout';
    const photo = {
      url: `https://private.example.r2.cloudflarestorage.com/spray-walls/${wallUuid}/wall.jpg?X-Amz-Signature=private`,
      expiresAt: '2026-10-12T00:00:00Z',
    };
    const response = mismatchedRender
      ? { data: { sprayWallRenderData: { wall: { uuid: 'another-wall' }, photo } } }
      : { data: { sprayWallByLayout: { uuid: wallUuid, currentVersion: { photo, holds: [{ id: 'real-hold' }] } } } };
    const file = `graphql/${layoutId}.json`;
    const fixture: GraphqlFixtureFile = {
      formatVersion: 1,
      operationName,
      documentHash: 'recorded-document',
      variablesHash: `recorded-${layoutId}`,
      query: `query ${operationName} { recorded }`,
      variables: mismatchedRender ? { uuid: wallUuid } : { layoutId },
      response,
      status: 200,
      recordedAt: manifest.recordedAt,
      upstream: manifest.upstream,
    };
    writeFileSync(join(input, file), JSON.stringify(fixture));
    manifest.graphql.push({
      operationName,
      documentHash: fixture.documentHash,
      variablesHash: fixture.variablesHash,
      file,
    });
  }
  writeFileSync(join(input, 'manifest.json'), JSON.stringify(manifest));
  return { input, output };
}

async function imageDownloader(): Promise<typeof fetch> {
  const bytes = await sharp({ create: { width: 3, height: 3, channels: 3, background: '#83695e' } })
    .jpeg()
    .toBuffer();
  return vi.fn<typeof fetch>(async () => new Response(new Uint8Array(bytes), { status: 200 }));
}

describe('authorized multiwall campaign preparation', () => {
  it('pins each CPP variant to its own bundled photo bytes while preserving the recording', async () => {
    const { input, output } = recording();
    const authorizedWalls = WALLS.map((wall, index) => ({
      ...wall,
      variantId: ['spray-liz', 'spray-cherry', 'spray-bowlo'][index],
    }));
    const manifest = JSON.parse(readFileSync(join(input, 'manifest.json'), 'utf8')) as ScreenshotFixtureManifest;
    manifest.capture = {
      sharedSessionId: '00000000-0000-4000-8000-000000000004',
      boards: ['Liz', 'Cherry', 'Bowlo', 'Kilter', 'Tension', 'MoonBoard'],
      cpp: {
        target: 'spray',
        boardReadyText: { 'spray-liz': 'Liz climb', 'spray-cherry': 'Cherry climb', 'spray-bowlo': 'Bowlo climb' },
        scenes: {},
      },
    };
    writeFileSync(join(input, 'manifest.json'), JSON.stringify(manifest));
    const originalManifest = readFileSync(join(input, 'manifest.json'));
    const photographs = await Promise.all(
      ['#123456', '#654321', '#aabbcc'].map((background) =>
        sharp({ create: { width: 3, height: 3, channels: 3, background } })
          .jpeg()
          .toBuffer(),
      ),
    );
    const download = vi.fn<typeof fetch>(async (request) => {
      const url = typeof request === 'string' ? request : request instanceof URL ? request.href : request.url;
      const wallIndex = authorizedWalls.findIndex(({ wallUuid }) => url.includes(wallUuid));
      if (wallIndex < 0) throw new Error('Unexpected photograph URL');
      return new Response(new Uint8Array(photographs[wallIndex]), { status: 200 });
    });
    await prepareIosCampaignFixturesForWalls(input, output, authorizedWalls, download);
    const prepared = JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8')) as ScreenshotFixtureManifest;
    const photoAssets = prepared.capture?.cpp?.boardPhotoAssets;
    expect(Object.keys(photoAssets ?? {}).sort()).toEqual(authorizedWalls.map(({ variantId }) => variantId).sort());
    for (const [index, { variantId, layoutId }] of authorizedWalls.entries()) {
      const asset = photoAssets?.[variantId];
      expect(asset).toBeDefined();
      const imageBytes = readFileSync(join(output, asset!.file));
      expect(imageBytes).toEqual(photographs[index]);
      expect(asset!.sha256).toBe(createHash('sha256').update(imageBytes).digest('hex'));
      const staticEntry = prepared.static.find(({ file }) => file === asset!.file);
      expect(staticEntry).toBeDefined();
      const fixture = JSON.parse(readFileSync(join(output, `graphql/${layoutId}.json`), 'utf8'));
      expect(new URL(fixture.response.data.sprayWallByLayout.currentVersion.photo.url).pathname).toBe(
        staticEntry!.path,
      );
    }
    expect(new Set(Object.values(photoAssets ?? {}).map(({ sha256 }) => sha256)).size).toBe(3);
    expect(readFileSync(join(input, 'manifest.json'))).toEqual(originalManifest);
  });

  it.each([false, true])(
    'captures real native version/draft transport while keeping the current hero pin, reverse order=%s',
    async (reverse) => {
      const authorized = { ...WALLS[0], variantId: 'spray-liz' };
      const { input, output } = recording([authorized]);
      const signed = (name: string) =>
        `https://private.example.r2.cloudflarestorage.com/spray-walls/${authorized.wallUuid}/${name}.jpg?X-Amz-Signature=private`;
      const currentPhoto = {
        url: signed('current'),
        thumbUrl: signed('thumb'),
        width: 2048,
        height: 1536,
        expiresAt: '2026-10-12T00:00:00Z',
      };
      const homography = [1, 0, 0, 0, 1, 0, 0, 0, 1];
      const current = { id: 'current-version', number: 2, status: 'PUBLISHED', homography, photo: currentPhoto };
      const old = {
        id: 'old-version',
        number: 1,
        status: 'PUBLISHED',
        homography,
        photo: { ...currentPhoto, url: signed('old'), thumbUrl: null },
      };
      const draft = { ...current, id: 'draft-version', number: 3, status: 'DRAFT' };
      appendNativeFixture(
        input,
        'GetSprayWallWithVersions',
        GET_SPRAY_WALL_WITH_VERSIONS,
        { uuid: authorized.wallUuid },
        {
          data: { sprayWall: { uuid: authorized.wallUuid, currentVersion: current, versions: [old, draft, current] } },
        },
      );
      appendNativeFixture(
        input,
        'GetSprayWallDraftRenderData',
        GET_SPRAY_WALL_DRAFT_RENDER_DATA,
        { uuid: authorized.wallUuid, version: 3 },
        {
          data: {
            sprayWallRenderData: {
              versionNumber: 3,
              homography,
              holds: [{ id: 'draft-hold', outline: [1, 0, 0, 1, -1, 0] }],
              photo: currentPhoto,
              photoFullUrl: signed('full'),
              wall: {
                uuid: authorized.wallUuid,
                currentVersion: current,
                versions: [{ id: 'draft-version', number: 3, status: 'DRAFT' }],
              },
            },
          },
        },
      );
      appendNativeFixture(
        input,
        'CreateSprayWallVersion',
        CREATE_SPRAY_WALL_VERSION,
        { input: { wallUuid: authorized.wallUuid, sourceVersionId: 'current-version' } },
        { data: { createSprayWallVersion: draft } },
      );
      const manifest = JSON.parse(readFileSync(join(input, 'manifest.json'), 'utf8')) as ScreenshotFixtureManifest;
      manifest.capture = {
        sharedSessionId: '00000000-0000-4000-8000-000000000004',
        boards: ['Liz', 'Kilter'],
        cpp: { target: 'spray', boardReadyText: { 'spray-liz': 'Liz' }, scenes: {} },
      };
      if (reverse) manifest.graphql.reverse();
      writeFileSync(join(input, 'manifest.json'), JSON.stringify(manifest));
      const originalFiles = new Map(manifest.graphql.map(({ file }) => [file, readFileSync(join(input, file))]));
      const colors = { current: '#112233', old: '#445566', full: '#778899', thumb: '#abcdef' };
      const photographs = Object.fromEntries(
        await Promise.all(
          Object.entries(colors).map(async ([name, background]) => [
            name,
            await sharp({ create: { width: 3, height: 3, channels: 3, background } })
              .jpeg()
              .toBuffer(),
          ]),
        ),
      );
      const download = vi.fn<typeof fetch>(async (request) => {
        const url = new URL(
          typeof request === 'string' ? request : request instanceof URL ? request.href : request.url,
        );
        const kind = url.pathname.split('/').at(-1)!.replace('.jpg', '');
        const bytes = photographs[kind === 'wall' ? 'current' : kind];
        if (!bytes) throw new Error('Unexpected photo');
        return new Response(new Uint8Array(bytes), { status: 200 });
      });
      await prepareIosCampaignFixturesForWalls(input, output, [authorized], download);
      const prepared = JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8')) as ScreenshotFixtureManifest;
      const hero = prepared.capture!.cpp!.boardPhotoAssets!['spray-liz'];
      expect(readFileSync(join(output, hero.file))).toEqual(photographs.current);
      expect(hero.sha256).toBe(createHash('sha256').update(photographs.current).digest('hex'));
      for (const [file, original] of originalFiles) expect(readFileSync(join(input, file))).toEqual(original);
      const versions = JSON.parse(readFileSync(join(output, 'graphql/GetSprayWallWithVersions.json'), 'utf8')).response
        .data.sprayWall;
      expect(versions.currentVersion.id).toBe('current-version');
      expect(versions.versions.map((version: { id: string }) => version.id)).toEqual([
        'old-version',
        'draft-version',
        'current-version',
      ]);
      expect(versions.currentVersion.homography).toEqual(homography);
      expect(versions.currentVersion.photo).toMatchObject({ width: 2048, height: 1536 });
      expect(versions.versions[0].photo.url).not.toBe(versions.currentVersion.photo.url);
      const render = JSON.parse(readFileSync(join(output, 'graphql/GetSprayWallDraftRenderData.json'), 'utf8')).response
        .data.sprayWallRenderData;
      expect(render.holds).toEqual([{ id: 'draft-hold', outline: [1, 0, 0, 1, -1, 0] }]);
      expect(render.homography).toEqual(homography);
      expect(render.photo.url).toBe(versions.currentVersion.photo.url);
      expect(render.photoFullUrl).not.toBe(render.photo.url);
      const fullEntry = prepared.static.find(({ path }) => path === new URL(render.photoFullUrl).pathname)!;
      expect(readFileSync(join(output, fullEntry.file))).toEqual(photographs.full);
      for (const { file } of prepared.graphql)
        expect(readFileSync(join(output, file), 'utf8')).not.toContain('X-Amz-Signature');
    },
  );

  it.each(['GetSprayWallWithVersions', 'GetSprayWallDraftRenderData'])(
    'refuses a mismatched native %s wall before downloading',
    async (operationName) => {
      const { input, output } = recording([WALLS[0]]);
      const response =
        operationName === 'GetSprayWallWithVersions'
          ? { data: { sprayWall: { uuid: 'unrelated-wall', currentVersion: {} } } }
          : {
              data: {
                sprayWallRenderData: {
                  wall: { uuid: 'unrelated-wall' },
                  photoFullUrl: 'https://private.example.r2.cloudflarestorage.com/other.jpg?X-Amz-Signature=secret',
                },
              },
            };
      appendNativeFixture(
        input,
        operationName,
        operationName === 'GetSprayWallWithVersions' ? GET_SPRAY_WALL_WITH_VERSIONS : GET_SPRAY_WALL_DRAFT_RENDER_DATA,
        { uuid: WALLS[0].wallUuid, version: 3 },
        response,
      );
      const manifest = JSON.parse(readFileSync(join(input, 'manifest.json'), 'utf8')) as ScreenshotFixtureManifest;
      manifest.graphql.reverse();
      writeFileSync(join(input, 'manifest.json'), JSON.stringify(manifest));
      const download = await imageDownloader();
      await expect(prepareIosCampaignFixturesForWalls(input, output, [WALLS[0]], download)).rejects.toThrow(
        'does not match',
      );
      expect(download).not.toHaveBeenCalled();
      expect(existsSync(output)).toBe(false);
    },
  );

  it.each(['GetSprayWallRenderData', 'GetSprayWallDraftRenderData'])(
    'refuses a selected %s photo that differs from the current native hero',
    async (operationName) => {
      const { input, output } = recording([WALLS[0]]);
      const signed = (name: string) =>
        `https://private.example.r2.cloudflarestorage.com/spray-walls/${WALLS[0].wallUuid}/${name}.jpg?X-Amz-Signature=private`;
      const currentPhoto = { url: signed('wall'), expiresAt: '2026-10-12T00:00:00Z' };
      appendNativeFixture(
        input,
        operationName,
        operationName === 'GetSprayWallRenderData' ? GET_SPRAY_WALL_RENDER_DATA : GET_SPRAY_WALL_DRAFT_RENDER_DATA,
        { uuid: WALLS[0].wallUuid, version: 1 },
        {
          data: {
            sprayWallRenderData: {
              versionNumber: 1,
              photo: { ...currentPhoto, url: signed('historical') },
              wall: {
                uuid: WALLS[0].wallUuid,
                currentVersion: { id: 'current-version', number: 2, photo: currentPhoto },
              },
            },
          },
        },
      );
      const current = await sharp({ create: { width: 3, height: 3, channels: 3, background: '#112233' } })
        .jpeg()
        .toBuffer();
      const old = await sharp({ create: { width: 3, height: 3, channels: 3, background: '#aabbcc' } })
        .jpeg()
        .toBuffer();
      const download = vi.fn<typeof fetch>(async (request) => {
        const url = typeof request === 'string' ? request : request instanceof URL ? request.href : request.url;
        return new Response(new Uint8Array(url.includes('historical') ? old : current), { status: 200 });
      });
      const original = readFileSync(join(input, `graphql/${operationName}.json`));
      await expect(prepareIosCampaignFixturesForWalls(input, output, [WALLS[0]], download)).rejects.toThrow(
        'differs from the current native hero',
      );
      expect(existsSync(output)).toBe(false);
      expect(readFileSync(join(input, `graphql/${operationName}.json`))).toEqual(original);
    },
  );

  it('keeps authorized historical render transport when its photo is the same current picture', async () => {
    const { input, output } = recording([WALLS[0]]);
    const photo = {
      url: `https://private.example.r2.cloudflarestorage.com/spray-walls/${WALLS[0].wallUuid}/wall.jpg?X-Amz-Signature=private`,
      expiresAt: '2026-10-12T00:00:00Z',
    };
    appendNativeFixture(
      input,
      'GetSprayWallRenderData',
      GET_SPRAY_WALL_RENDER_DATA,
      { uuid: WALLS[0].wallUuid, version: 1 },
      {
        data: {
          sprayWallRenderData: {
            versionNumber: 1,
            photo,
            wall: { uuid: WALLS[0].wallUuid, currentVersion: { id: 'current-version', number: 2, photo } },
          },
        },
      },
    );
    await expect(
      prepareIosCampaignFixturesForWalls(input, output, [WALLS[0]], await imageDownloader()),
    ).resolves.toBeUndefined();
    expect(existsSync(join(output, 'manifest.json'))).toBe(true);
  });

  it('refuses an unrelated draft creation input instead of allowing its signed photo', async () => {
    const { input, output } = recording([WALLS[0]]);
    appendNativeFixture(
      input,
      'CreateSprayWallVersion',
      CREATE_SPRAY_WALL_VERSION,
      { input: { wallUuid: 'unrelated-wall', sourceVersionId: 'old-version' } },
      {
        data: {
          createSprayWallVersion: {
            id: 'new-version',
            photo: {
              url: 'https://private.example.r2.cloudflarestorage.com/spray-walls/unrelated-wall/other.jpg?X-Amz-Signature=private',
              expiresAt: '2026-10-12T00:00:00Z',
            },
          },
        },
      },
    );
    const manifest = JSON.parse(readFileSync(join(input, 'manifest.json'), 'utf8')) as ScreenshotFixtureManifest;
    manifest.graphql.reverse();
    writeFileSync(join(input, 'manifest.json'), JSON.stringify(manifest));
    const download = await imageDownloader();
    await expect(prepareIosCampaignFixturesForWalls(input, output, [WALLS[0]], download)).rejects.toThrow(
      'Uncaptured signed photo URL',
    );
    expect(download).not.toHaveBeenCalled();
    expect(existsSync(output)).toBe(false);
  });

  it('bundles all three approved walls without changing native geometry or source recordings', async () => {
    const { input, output } = recording();
    const before = readFileSync(join(input, 'graphql/1.json'));
    await prepareIosCampaignFixturesForWalls(input, output, WALLS, await imageDownloader());
    expect(readFileSync(join(input, 'graphql/1.json'))).toEqual(before);
    for (const { layoutId } of WALLS) {
      const fixture = JSON.parse(readFileSync(join(output, `graphql/${layoutId}.json`), 'utf8'));
      expect(fixture.response.data.sprayWallByLayout.currentVersion.holds).toEqual([{ id: 'real-hold' }]);
      expect(fixture.response.data.sprayWallByLayout.currentVersion.photo.url).toContain(
        'screenshot-fixtures.boardsesh.invalid',
      );
      expect(JSON.stringify(fixture)).not.toContain('X-Amz-Signature');
    }
  });

  it('leaves the output absent when the recording is missing the third approved wall', async () => {
    const { input, output } = recording(WALLS.slice(0, 2));
    await expect(prepareIosCampaignFixturesForWalls(input, output, WALLS, await imageDownloader())).rejects.toThrow(
      'missing',
    );
    expect(existsSync(output)).toBe(false);
  });

  it('refuses an unrelated private photo instead of publishing its signed URL', async () => {
    const { input, output } = recording();
    await expect(
      prepareIosCampaignFixturesForWalls(input, output, WALLS.slice(0, 2), await imageDownloader()),
    ).rejects.toThrow('Uncaptured signed photo URL');
    expect(existsSync(output)).toBe(false);
  });

  it('rejects a mismatched render wall even when its currentVersion is absent', async () => {
    const { input, output } = recording(WALLS.slice(0, 1), true);
    const download = await imageDownloader();
    await expect(prepareIosCampaignFixturesForWalls(input, output, WALLS.slice(0, 1), download)).rejects.toThrow(
      'does not match',
    );
    expect(download).not.toHaveBeenCalled();
    expect(existsSync(output)).toBe(false);
  });

  it('rejects duplicate wall identities before downloading or creating output', async () => {
    const { input, output } = recording();
    const download = await imageDownloader();
    await expect(prepareIosCampaignFixturesForWalls(input, output, [WALLS[0], WALLS[0]], download)).rejects.toThrow(
      'unique',
    );
    expect(download).not.toHaveBeenCalled();
    expect(existsSync(output)).toBe(false);
  });
});

function appendNativeFixture(
  input: string,
  operationName: string,
  query: string,
  variables: Record<string, unknown>,
  response: Record<string, unknown>,
) {
  const manifest = JSON.parse(readFileSync(join(input, 'manifest.json'), 'utf8')) as ScreenshotFixtureManifest;
  const file = `graphql/${operationName}.json`;
  const fixture: GraphqlFixtureFile = {
    formatVersion: 1,
    operationName,
    documentHash: createHash('sha256').update(query).digest('hex'),
    variablesHash: createHash('sha256').update(JSON.stringify(variables)).digest('hex'),
    query,
    variables,
    response,
    status: 200,
    recordedAt: manifest.recordedAt,
    upstream: manifest.upstream,
  };
  writeFileSync(join(input, file), JSON.stringify(fixture));
  manifest.graphql.push({
    operationName,
    documentHash: fixture.documentHash,
    variablesHash: fixture.variablesHash,
    file,
  });
  writeFileSync(join(input, 'manifest.json'), JSON.stringify(manifest));
}

describe('CPP recorded wall selection', () => {
  function source() {
    const { input } = recording();
    const manifest = JSON.parse(readFileSync(join(input, 'manifest.json'), 'utf8')) as ReturnType<typeof emptyManifest>;
    manifest.capture = {
      sharedSessionId: WALLS[0].wallUuid,
      boards: ['Actual Liz', 'Actual Cherry', 'Actual Bowlo', 'Kilter', 'Tension', 'MoonBoard'],
      cpp: { target: 'spray', boardReadyText: {}, scenes: {} },
    };
    const roster = {
      formatVersion: 1,
      operationName: 'GetMyBoards',
      documentHash: 'actual-roster-document',
      variablesHash: 'actual-roster-variables',
      query: 'query GetMyBoards { myBoards { boards { uuid } } }',
      variables: {},
      response: {
        data: {
          myBoards: {
            boards: WALLS.map((wall, index) => ({
              uuid: wall.wallUuid,
              layoutId: wall.layoutId,
              name: manifest.capture!.boards[index],
              ownerId: manifest.accountUserId,
              boardType: 'spray',
            })),
          },
        },
      },
      status: 200,
      recordedAt: manifest.recordedAt,
      upstream: manifest.upstream,
    } satisfies GraphqlFixtureFile;
    return { manifest, roster };
  }
  it('derives variant identities from actual recorded owner and selectors, deduplicating paginated rows', () => {
    const { manifest, roster } = source();
    expect(authorizedCppWallsFromRecording(manifest, [roster, roster])).toEqual(
      WALLS.map((wall, index) => ({
        ...wall,
        variantId: ['spray-liz', 'spray-cherry', 'spray-bowlo'][index],
      })),
    );
  });
  it('refuses a same-name wall owned by another account', () => {
    const { manifest, roster } = source();
    roster.response.data.myBoards.boards[2].ownerId = 'another-account';
    expect(() => authorizedCppWallsFromRecording(manifest, [roster])).toThrow('unique recorded ownership');
  });
  it('refuses ambiguous selectors rather than choosing an arbitrary wall', () => {
    const { manifest, roster } = source();
    roster.response.data.myBoards.boards.push({ ...roster.response.data.myBoards.boards[0], uuid: 'another-wall' });
    expect(() => authorizedCppWallsFromRecording(manifest, [roster])).toThrow('unique recorded ownership');
  });
});
