import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createHelpShotPublisher,
  DEFAULT_HELP_SHOT_DIR,
  helpCaptureName,
  helpShotAsset,
  HELP_SHOTS,
  parseHelpShotArgs,
} from './lib/help-shots';

const USAGE = `Usage: vp run help:publish-shots [-- [--input <dir>] [--dry-run]]

Uploads the captured help-page PNGs to the public dev bucket, then rewrites
docs/help-screenshots.json and docs/help-screenshots.md.

  --input <dir>   Capture directory, also accepted as a bare positional
                  (default: ${DEFAULT_HELP_SHOT_DIR})
  --dry-run       List what would be uploaded; reads no credentials, writes no index
  --help          Show this message

Credentials come from the repository root's ignored .env.local; see
.env.dev-artifacts.example. Only DEV_* variables are used.`;

function capturesIn(inputDir: string): string[] {
  if (!existsSync(inputDir)) {
    throw new Error(`No capture directory at ${inputDir}; run the help Maestro flow first`);
  }
  const captures = readdirSync(inputDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.png'))
    .map((entry) => resolve(inputDir, entry.name))
    .sort();
  if (!captures.length) throw new Error(`No PNGs in ${inputDir}; run the help Maestro flow first`);
  // Reject an unpublishable name before the first upload, so a rejected file can
  // never leave the bucket holding half a batch the index does not describe.
  for (const capture of captures) helpCaptureName(capture);
  return captures;
}

async function main(): Promise<void> {
  const { inputDir, dryRun, help } = parseHelpShotArgs(process.argv.slice(2));
  if (help) {
    console.log(USAGE);
    return;
  }

  const captures = capturesIn(inputDir);
  // Neither of these is fatal here: a reviewer often wants to look at one extra or
  // one re-shot screen. Only help:convert-shots insists on the complete set, because
  // only it writes the assets the help page loads.
  const unmapped = captures.filter((capture) => !helpShotAsset(helpCaptureName(capture)));
  const absent = HELP_SHOTS.filter((shot) => !captures.some((capture) => helpCaptureName(capture) === shot.capture));
  for (const capture of unmapped) console.log(`[help:publish-shots] not in the shipped set: ${capture}`);
  if (absent.length) {
    console.log(`[help:publish-shots] absent from this batch: ${absent.map((shot) => shot.capture).join(', ')}`);
  }

  if (dryRun) {
    for (const capture of captures) console.log(`[help:publish-shots] would publish ${capture}`);
    console.log(`[help:publish-shots] dry run: ${captures.length} capture(s), nothing uploaded, index untouched`);
    return;
  }

  const { publish, finish } = createHelpShotPublisher();
  for (const capture of captures) console.log(`[help:publish-shots] ${await publish(capture)}`);
  // Prunes links whose source PNG has gone; written only now that every upload and
  // its public checksum re-check has succeeded.
  finish(captures);
  console.log(`[help:publish-shots] indexed ${captures.length} capture(s) in docs/help-screenshots.md`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Help screenshot publishing failed');
  process.exitCode = 1;
});
