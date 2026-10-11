/// <reference types="node" />
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readScreenshotFixtureManifest } from './lib/screenshot-backend';
import { captureFixturePhoto, type FixturePhoto, type CapturedFixtureAsset } from './lib/screenshot-fixture-assets';
import { type GraphqlFixtureFile, sortManifestEntries } from './lib/screenshot-fixtures';

export interface AuthorizedCampaignWall {
  wallUuid: string;
  layoutId: number;
  variantId?: string;
}

/** Copy a recording into a portable candidate, replacing only the authorized spray wall's photo transport. */
export async function prepareIosCampaignFixtures(
  input: string,
  output: string,
  wallUuid: string,
  layoutId: number,
  download: typeof fetch = fetch,
): Promise<void> {
  return prepareIosCampaignFixturesForWalls(input, output, [{ wallUuid, layoutId }], download);
}

/** Each supplied wall must have a recorded photo; unrelated private photos remain forbidden. */
export async function prepareIosCampaignFixturesForWalls(
  input: string,
  output: string,
  authorizedWalls: readonly AuthorizedCampaignWall[],
  download: typeof fetch = fetch,
): Promise<void> {
  if (existsSync(output)) throw new Error('Candidate output already exists; choose a new directory');
  if (
    authorizedWalls.length === 0 ||
    authorizedWalls.some(({ wallUuid, layoutId }) => !wallUuid || !Number.isSafeInteger(layoutId) || layoutId < 1) ||
    new Set(authorizedWalls.map(({ wallUuid }) => wallUuid)).size !== authorizedWalls.length ||
    new Set(authorizedWalls.map(({ layoutId }) => layoutId)).size !== authorizedWalls.length
  ) {
    throw new Error('Authorized walls need unique UUIDs and positive, unique layout IDs');
  }
  const manifest = readScreenshotFixtureManifest(input);
  if (!manifest) throw new Error('Recording manifest is missing');
  const prepared = new Map<string, GraphqlFixtureFile>();
  const assets = new Map<string, CapturedFixtureAsset>();
  const capturedWalls = new Set<string>();
  const graphql = manifest.graphql.filter((entry) => entry.operationName !== 'CampaignRoster');
  for (const entry of graphql) {
    const fixture = JSON.parse(readFileSync(join(input, entry.file), 'utf8')) as GraphqlFixtureFile;
    const variables = fixture.variables as Record<string, unknown>;
    const response = fixture.response as { data?: Record<string, unknown> };
    const photoContainers: Record<string, unknown>[] = [];
    const authorizedWall = authorizedWalls.find(({ wallUuid, layoutId }) =>
      entry.operationName === 'GetSprayWallByLayout'
        ? variables.layoutId === layoutId
        : entry.operationName === 'GetSprayWallRenderData' && variables.uuid === wallUuid,
    );
    if (entry.operationName === 'GetSprayWallByLayout' && authorizedWall) {
      const wall = response.data?.sprayWallByLayout as
        | { uuid?: string; currentVersion?: Record<string, unknown> }
        | undefined;
      if (wall?.uuid !== authorizedWall.wallUuid)
        throw new Error('Recorded spray wall does not match the authorized wall');
      if (wall.currentVersion) photoContainers.push(wall.currentVersion);
    } else if (entry.operationName === 'GetSprayWallRenderData' && authorizedWall) {
      const render = response.data?.sprayWallRenderData as
        | (Record<string, unknown> & { wall?: { uuid?: string; currentVersion?: Record<string, unknown> } })
        | undefined;
      if (render?.wall && render.wall.uuid !== authorizedWall.wallUuid)
        throw new Error('Recorded spray wall does not match the authorized wall');
      if (render) photoContainers.push(render);
      if (render?.wall?.currentVersion) {
        if (render.wall.uuid !== authorizedWall.wallUuid)
          throw new Error('Recorded spray wall does not match the authorized wall');
        photoContainers.push(render.wall.currentVersion);
      }
    }
    for (const photoContainer of photoContainers) {
      if (!photoContainer.photo || !authorizedWall) continue;
      const captured = await captureFixturePhoto(
        photoContainer.photo as FixturePhoto,
        authorizedWall.wallUuid,
        download,
      );
      photoContainer.photo = captured.photo;
      capturedWalls.add(authorizedWall.wallUuid);
      for (const asset of captured.assets) assets.set(asset.path, asset);
      if (authorizedWall.variantId && manifest.capture?.cpp) {
        if (!manifest.capture.cpp.boardReadyText[authorizedWall.variantId])
          throw new Error('Authorized photo variant is absent from CPP capture coverage');
        const photoAsset = captured.assets[0];
        manifest.capture.cpp.boardPhotoAssets = {
          ...manifest.capture.cpp.boardPhotoAssets,
          [authorizedWall.variantId]: {
            file: photoAsset.file,
            sha256: createHash('sha256').update(photoAsset.bytes).digest('hex'),
          },
        };
      }
    }
    // Fail closed: no expired/signed fallback is allowed to reach the archive.
    if (/X-Amz-(?:Signature|Credential)|X-Goog-(?:Signature|Credential)/i.test(JSON.stringify(fixture))) {
      throw new Error(
        `Uncaptured signed photo URL remains in ${entry.operationName}; extend the explicit allowed photo fields before publishing`,
      );
    }
    prepared.set(entry.file, fixture);
  }
  if (authorizedWalls.some(({ wallUuid }) => !capturedWalls.has(wallUuid)))
    throw new Error('Recording is missing an authorized spray wall photo');
  mkdirSync(output, { recursive: true });
  for (const entry of manifest.static) {
    const target = join(output, entry.file);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(input, entry.file), target);
  }
  for (const [file, fixture] of prepared) {
    const target = join(output, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(fixture, null, 2)}\n`);
  }
  for (const asset of assets.values()) {
    const target = join(output, asset.file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, asset.bytes);
  }
  const candidate = sortManifestEntries({
    ...manifest,
    graphql,
    static: [
      ...manifest.static,
      ...[...assets.values()].map((asset) => ({
        path: asset.path,
        query: '',
        file: asset.file,
        contentType: asset.contentType,
        bytes: asset.bytes.length,
      })),
    ],
  });
  writeFileSync(join(output, 'manifest.json'), `${JSON.stringify(candidate, null, 2)}\n`);
  console.log(
    `Prepared campaign candidate: ${graphql.length} responses, ${candidate.static.length} bundled images; signed photo URLs removed.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, output, wallUuid, layoutId] = process.argv.slice(2).filter((arg) => arg !== '--');
  if (input && output && wallUuid === '--walls' && layoutId) {
    const authorizedWalls: unknown = JSON.parse(readFileSync(resolve(layoutId), 'utf8'));
    if (
      !Array.isArray(authorizedWalls) ||
      authorizedWalls.some(
        (wall: unknown) =>
          !wall ||
          typeof wall !== 'object' ||
          !('wallUuid' in wall) ||
          !('layoutId' in wall) ||
          typeof wall.wallUuid !== 'string' ||
          typeof wall.layoutId !== 'number',
      )
    )
      throw new Error('Wall list must contain objects with wallUuid and layoutId');
    prepareIosCampaignFixturesForWalls(
      resolve(input),
      resolve(output),
      authorizedWalls as AuthorizedCampaignWall[],
    ).catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : 'Could not prepare campaign fixture');
      process.exitCode = 1;
    });
  } else if (!input || !output || !wallUuid || !/^\d+$/.test(layoutId ?? '')) {
    console.error(
      'Usage: vp exec tsx scripts/prepare-ios-campaign-fixtures.ts <recording> <new-candidate> <authorized-wall-uuid> <layout-id> | <recording> <new-candidate> --walls <authorized-walls.json>',
    );
    process.exitCode = 1;
  } else {
    prepareIosCampaignFixtures(resolve(input), resolve(output), wallUuid, Number(layoutId)).catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : 'Could not prepare campaign fixture');
      process.exitCode = 1;
    });
  }
}
