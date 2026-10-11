/// <reference types="node" />

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareIosCampaignFixturesForWalls, type AuthorizedCampaignWall } from '../prepare-ios-campaign-fixtures';
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
