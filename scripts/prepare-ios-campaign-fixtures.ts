/// <reference types="node" />
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readScreenshotFixtureManifest } from './lib/screenshot-backend';
import { captureFixturePhoto, type FixturePhoto, type CapturedFixtureAsset } from './lib/screenshot-fixture-assets';
import {
  type GraphqlFixtureFile,
  type ScreenshotFixtureManifest,
  sortManifestEntries,
} from './lib/screenshot-fixtures';
import { readCppPage, isCppTarget } from './lib/screenshot-cpp';
import { createCppPhotoRefreshDownloader } from './lib/cpp-photo-refresh';
import { createTransport, resolveBootstrapUpstream } from './bootstrap-cpp-scenario';
import { assertCppGradeCountProof } from './lib/cpp-grade-count';
import { withCppDetailCoverage, type CppDetailRecordingOptions } from './lib/cpp-detail-coverage';

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
  const heroAssets = new Map<string, { priority: number; asset: CapturedFixtureAsset }>();
  const selectedPhotoHashes = new Map<string, Set<string>>();
  const graphql = manifest.graphql.filter((entry) => entry.operationName !== 'CampaignRoster');
  for (const entry of graphql) {
    const fixture = JSON.parse(readFileSync(join(input, entry.file), 'utf8')) as GraphqlFixtureFile;
    const variables = fixture.variables as Record<string, unknown>;
    const response = fixture.response as { data?: Record<string, unknown> };
    const photoContainers: Array<{ container: Record<string, unknown>; priority: number; selected?: boolean }> = [];
    const renderOperations = ['GetSprayWallRenderData', 'GetSprayWallDraftRenderData'];
    const versionOperations = ['GetSprayWallWithVersions'];
    const createVersionInput = variables.input as { wallUuid?: string } | undefined;
    const authorizedWall = authorizedWalls.find(({ wallUuid, layoutId }) =>
      entry.operationName === 'GetSprayWallByLayout'
        ? variables.layoutId === layoutId
        : entry.operationName === 'CreateSprayWallVersion'
          ? createVersionInput?.wallUuid === wallUuid
          : [...renderOperations, ...versionOperations].includes(entry.operationName) && variables.uuid === wallUuid,
    );
    let fullPhotoContainer: Record<string, unknown> | undefined;
    if (
      (entry.operationName === 'GetSprayWallByLayout' || versionOperations.includes(entry.operationName)) &&
      authorizedWall
    ) {
      const wall = response.data?.[
        entry.operationName === 'GetSprayWallByLayout' ? 'sprayWallByLayout' : 'sprayWall'
      ] as
        | { uuid?: string; currentVersion?: Record<string, unknown>; versions?: Record<string, unknown>[] }
        | undefined;
      if (wall?.uuid !== authorizedWall.wallUuid)
        throw new Error('Recorded spray wall does not match the authorized wall');
      if (wall.currentVersion) photoContainers.push({ container: wall.currentVersion, priority: 3 });
      if (entry.operationName === 'GetSprayWallWithVersions') {
        for (const version of wall.versions ?? []) photoContainers.push({ container: version, priority: 0 });
      }
    } else if (renderOperations.includes(entry.operationName) && authorizedWall) {
      const render = response.data?.sprayWallRenderData as
        | (Record<string, unknown> & { wall?: { uuid?: string; currentVersion?: Record<string, unknown> } })
        | undefined;
      if (render?.wall?.uuid !== authorizedWall.wallUuid)
        throw new Error('Recorded spray wall does not match the authorized wall');
      const draft = entry.operationName === 'GetSprayWallDraftRenderData';
      const currentRender =
        !draft && (variables.version == null || variables.version === render.wall.currentVersion?.number);
      photoContainers.push({ container: render, priority: currentRender ? 2 : 0, selected: true });
      if (render.wall.currentVersion) photoContainers.push({ container: render.wall.currentVersion, priority: 3 });
      if (draft && render.photoFullUrl != null) fullPhotoContainer = render;
    } else if (entry.operationName === 'CreateSprayWallVersion' && authorizedWall) {
      const version = response.data?.createSprayWallVersion as Record<string, unknown> | undefined;
      if (version) photoContainers.push({ container: version, priority: 0, selected: true });
    }
    for (const { container, priority, selected } of photoContainers) {
      if (!container.photo || !authorizedWall) continue;
      const captured = await captureFixturePhoto(container.photo as FixturePhoto, authorizedWall.wallUuid, download);
      container.photo = captured.photo;
      capturedWalls.add(authorizedWall.wallUuid);
      for (const asset of captured.assets) assets.set(asset.path, asset);
      const photoAsset = captured.assets[0];
      if (selected) {
        const hashes = selectedPhotoHashes.get(authorizedWall.wallUuid) ?? new Set<string>();
        hashes.add(createHash('sha256').update(photoAsset.bytes).digest('hex'));
        selectedPhotoHashes.set(authorizedWall.wallUuid, hashes);
      }
      if (priority > 0) {
        const existing = heroAssets.get(authorizedWall.wallUuid);
        if (existing?.priority === priority && !existing.asset.bytes.equals(photoAsset.bytes))
          throw new Error('Conflicting current spray wall photo captures');
        if (!existing || priority > existing.priority)
          heroAssets.set(authorizedWall.wallUuid, { priority, asset: photoAsset });
      }
    }
    if (fullPhotoContainer && authorizedWall) {
      if (typeof fullPhotoContainer.photoFullUrl !== 'string') throw new Error('Invalid draft full-photo URL');
      const captured = await captureFixturePhoto(
        { url: fullPhotoContainer.photoFullUrl, expiresAt: manifest.frozenNow },
        authorizedWall.wallUuid,
        download,
      );
      fullPhotoContainer.photoFullUrl = captured.photo.url;
      for (const asset of captured.assets) assets.set(asset.path, asset);
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
  for (const authorizedWall of authorizedWalls) {
    const hero = heroAssets.get(authorizedWall.wallUuid);
    const selectedHashes = selectedPhotoHashes.get(authorizedWall.wallUuid);
    if (
      selectedHashes &&
      (!hero ||
        [...selectedHashes].some((hash) => hash !== createHash('sha256').update(hero.asset.bytes).digest('hex')))
    )
      throw new Error('Selected spray wall photo differs from the current native hero photo');
    if (authorizedWall.variantId && manifest.capture?.cpp) {
      if (!manifest.capture.cpp.boardReadyText[authorizedWall.variantId] || !hero)
        throw new Error('Authorized photo variant lacks current CPP hero coverage');
      manifest.capture.cpp.boardPhotoAssets = {
        ...manifest.capture.cpp.boardPhotoAssets,
        [authorizedWall.variantId]: {
          file: hero.asset.file,
          sha256: createHash('sha256').update(hero.asset.bytes).digest('hex'),
        },
      };
    }
  }

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

/** Resolve approved CPP walls from genuine recorded ownership and selector data. */
export function authorizedCppWallsFromRecording(
  manifest: ScreenshotFixtureManifest,
  fixtures: readonly GraphqlFixtureFile[],
): AuthorizedCampaignWall[] {
  const target = manifest.capture?.cpp?.target;
  if (!isCppTarget(target) || manifest.capture?.boards.length !== 6)
    throw new Error('CPP preparation requires the real six-board capture scenario');
  const page = readCppPage(target);
  const variants = [...page.heroBoards, ...page.otherBoards];
  const rows = fixtures
    .filter(({ operationName }) => operationName === 'GetMyBoards')
    .flatMap((fixture) => {
      const response = fixture.response as {
        data?: {
          myBoards?: {
            boards?: Array<{ uuid: string; name: string; ownerId: string; boardType: string; layoutId: number }>;
          };
        };
      };
      return response.data?.myBoards?.boards ?? [];
    });
  return variants.flatMap((variant, index) => {
    if (variant.family !== 'spray') return [];
    const selector = manifest.capture!.boards[index];
    const matches = new Map(
      rows
        .filter(
          (board) =>
            board.name === selector &&
            board.ownerId === manifest.accountUserId &&
            board.boardType === variant.boardType,
        )
        .map((board) => [board.uuid, board]),
    );
    if (matches.size !== 1) throw new Error(`CPP wall ${variant.id} lacks unique recorded ownership`);
    const wall = [...matches.values()][0];
    if (!wall.uuid || !Number.isSafeInteger(wall.layoutId) || wall.layoutId < 1)
      throw new Error(`CPP wall ${variant.id} lacks its actual layout identity`);
    return [{ wallUuid: wall.uuid, layoutId: wall.layoutId, variantId: variant.id }];
  });
}

/** Complete genuine native detail reads before either manufacturer copying or spray photo preparation. */
export async function prepareCppCampaignFixtures(
  input: string,
  output: string,
  options: CppDetailRecordingOptions,
  refreshPhotos = false,
): Promise<void> {
  if (existsSync(output)) throw new Error('Candidate output already exists; choose a new directory');
  await withCppDetailCoverage(input, options, async (recording) => {
    const manifest = readScreenshotFixtureManifest(recording);
    if (!manifest) throw new Error('CPP candidate recording manifest is missing');
    const fixtures = manifest.graphql.map(
      (entry) => JSON.parse(readFileSync(join(recording, entry.file), 'utf8')) as GraphqlFixtureFile,
    );
    assertCppGradeCountProof(manifest, fixtures);
    const authorizedWalls = authorizedCppWallsFromRecording(manifest, fixtures);
    if (authorizedWalls.length === 0) {
      cpSync(recording, output, { recursive: true, errorOnExist: true, force: false });
      console.log('Prepared manufacturer CPP candidate with verified native detail responses.');
      return;
    }
    let download: typeof fetch = fetch;
    if (refreshPhotos) {
      const { transport, accountUserId } = await createTransport(options.upstream, options.email, options.password);
      download = await createCppPhotoRefreshDownloader({
        accountUserId: manifest.accountUserId,
        authenticatedAccountUserId: accountUserId,
        authorizedWalls,
        recordedFixtures: fixtures,
        transport,
      });
    }
    await prepareIosCampaignFixturesForWalls(recording, output, authorizedWalls, download);
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((argument) => argument !== '--');
  const refresh = args.includes('--refresh-photo-urls');
  if (refresh) args.splice(args.indexOf('--refresh-photo-urls'), 1);
  const [input, output, wallSelection, layoutOrFile] = args;
  const cpp = wallSelection === '--cpp';
  if (!input || !output || (cpp ? args.length !== 3 : args.length !== 4))
    throw new Error(
      'Usage: vp exec node --import tsx scripts/prepare-ios-campaign-fixtures.ts <recording> <new-candidate> (--cpp | --walls <walls.json> | <wall-uuid> <layout-id>) [--refresh-photo-urls]',
    );
  const source = resolve(input);
  const destination = resolve(output);
  if (existsSync(destination)) throw new Error('Candidate output already exists; choose a new directory');
  if (cpp) {
    const email = process.env.SCREENSHOT_USER_EMAIL;
    const password = process.env.SCREENSHOT_USER_PASSWORD;
    if (!email || !password)
      throw new Error('CPP detail preparation requires the dedicated screenshot account credentials');
    await prepareCppCampaignFixtures(
      source,
      destination,
      {
        upstream: resolveBootstrapUpstream(),
        email,
        password,
        log: console.log,
      },
      refresh,
    );
    return;
  }
  const manifest = readScreenshotFixtureManifest(source);
  if (!manifest) throw new Error('Recording manifest is missing');
  const fixtures = manifest.graphql.map(
    (entry) => JSON.parse(readFileSync(join(source, entry.file), 'utf8')) as GraphqlFixtureFile,
  );
  assertCppGradeCountProof(manifest, fixtures);
  let authorizedWalls: AuthorizedCampaignWall[];
  if (wallSelection === '--walls') {
    const parsed: unknown = JSON.parse(readFileSync(resolve(layoutOrFile), 'utf8'));
    if (
      !Array.isArray(parsed) ||
      parsed.some(
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
    authorizedWalls = parsed as AuthorizedCampaignWall[];
  } else {
    if (!wallSelection || !/^\d+$/.test(layoutOrFile ?? ''))
      throw new Error('Authorized wall UUID and numeric layout ID required');
    authorizedWalls = [{ wallUuid: wallSelection, layoutId: Number(layoutOrFile) }];
  }
  let download: typeof fetch = fetch;
  if (refresh) {
    const email = process.env.SCREENSHOT_USER_EMAIL;
    const password = process.env.SCREENSHOT_USER_PASSWORD;
    if (!email || !password) throw new Error('Photo refresh requires the dedicated screenshot account credentials');
    const upstream = resolveBootstrapUpstream();
    if (upstream !== manifest.upstream.replace(/\/$/, ''))
      throw new Error('Photo refresh backend must match the recorded upstream');
    const { transport, accountUserId } = await createTransport(upstream, email, password);
    download = await createCppPhotoRefreshDownloader({
      accountUserId: manifest.accountUserId,
      authenticatedAccountUserId: accountUserId,
      authorizedWalls,
      recordedFixtures: fixtures,
      transport,
    });
  }
  await prepareIosCampaignFixturesForWalls(source, destination, authorizedWalls, download);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Could not prepare campaign fixture');
    process.exitCode = 1;
  });
