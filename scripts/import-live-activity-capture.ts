/// <reference types="node" />
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { extractLiveActivityExterior } from './lib/screenshot-live-activity-exterior';
import { CAPTION_LOCALES } from './lib/screenshot-presentation';
import {
  LIVE_ACTIVITY_FIXTURE_ROOT,
  LIVE_ACTIVITY_MANIFEST,
  nativeCaptureSha256,
  readLiveActivityManifest,
  validateLiveActivityFixture,
  type LiveActivityBoardFamily,
  type LiveActivityFixtureManifest,
} from './lib/screenshot-live-activity';

/** Preserve whole native PNGs; legacy cards only crop and extract exterior alpha. */
export async function importLiveActivityCapture(
  input: string,
  provenancePath: string,
  root = LIVE_ACTIVITY_FIXTURE_ROOT,
): Promise<string> {
  const supplied: unknown = JSON.parse(readFileSync(provenancePath, 'utf8'));
  if (typeof supplied !== 'object' || supplied === null || Array.isArray(supplied))
    throw new Error('Native capture provenance must be an object');
  const provenance = supplied as Record<string, unknown>;
  if (
    !['kilter', 'tension', 'moonboard'].includes(String(provenance.boardFamily)) ||
    !CAPTION_LOCALES.some((locale) => locale === provenance.appLocale)
  )
    throw new Error('Native capture must identify a supported board family and actual app locale');
  const boardFamily = provenance.boardFamily as LiveActivityBoardFamily;
  const locale = provenance.appLocale as (typeof CAPTION_LOCALES)[number];
  const source = readFileSync(input);
  const sourcePngSha256 = nativeCaptureSha256(source);
  const file = `${boardFamily}-${locale}${provenance.captureFraming === 'full-screen' ? `-${String(provenance.captureSurface)}` : ''}.png`;
  const checked = validateLiveActivityFixture(
    { ...provenance, file, sha256: sourcePngSha256, sourcePngSha256 },
    boardFamily,
    locale,
  );
  const metadata = await sharp(source).metadata();
  if (
    metadata.format !== 'png' ||
    metadata.width !== checked.nativePixels.width ||
    metadata.height !== checked.nativePixels.height
  )
    throw new Error('Source PNG dimensions do not match the physical capture provenance');
  const pixels =
    checked.captureFraming === 'full-screen'
      ? source
      : await sharp(source)
          .keepIccProfile()
          .extract({
            left: checked.cropRect.x,
            top: checked.cropRect.y,
            width: checked.cropRect.width,
            height: checked.cropRect.height,
          })
          .png()
          .toBuffer();
  const extracted = checked.captureFraming === 'full-screen' ? undefined : await extractLiveActivityExterior(pixels);
  const fixturePixels = extracted?.pixels ?? pixels;
  const fixture = {
    ...checked,
    sha256: nativeCaptureSha256(fixturePixels),
    ...(extracted ? { extraction: extracted.extraction } : {}),
  };
  const manifestPath = join(root, LIVE_ACTIVITY_MANIFEST);
  const manifest: LiveActivityFixtureManifest = existsSync(manifestPath)
    ? readLiveActivityManifest(root)
    : { version: 1, fixtures: {} };
  manifest.fixtures[`${boardFamily}/${locale}`] = fixture;
  mkdirSync(root, { recursive: true });
  // Full screens must be reviewed and cleared of unrelated notifications first.
  writeFileSync(join(root, `${file}.pending`), fixturePixels);
  renameSync(join(root, `${file}.pending`), join(root, file));
  writeFileSync(`${manifestPath}.pending`, `${JSON.stringify(manifest, null, 2)}\n`);
  renameSync(`${manifestPath}.pending`, manifestPath);
  return join(root, file);
}

export async function main(arguments_: readonly string[] = process.argv.slice(2)): Promise<number> {
  let input: string | undefined;
  let provenance: string | undefined;
  let root = LIVE_ACTIVITY_FIXTURE_ROOT;
  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index];
    if (argument === '--input') input = arguments_[++index];
    else if (argument === '--provenance') provenance = arguments_[++index];
    else if (argument === '--output-root') root = arguments_[++index] ?? '';
    else throw new Error(`Unknown option ${argument}`);
  }
  if (!input || !provenance || !root)
    throw new Error(
      'Usage: vp exec tsx scripts/import-live-activity-capture.ts --input <native.png> --provenance <reviewed.json> [--output-root <directory>]',
    );
  const pathname = await importLiveActivityCapture(resolve(input), resolve(provenance), resolve(root));
  console.log(`[live-activity:capture] Wrote reviewed native capture ${basename(pathname)}; source file unchanged.`);
  return 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
