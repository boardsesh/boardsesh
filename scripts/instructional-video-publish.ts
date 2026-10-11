import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { publishTutorialBundle } from './lib/instructional-video/publish';

export function parseTutorialPublishArgs(args: readonly string[]): { bundleDirectory: string; dryRun: boolean } {
  let directory: string | undefined;
  let dryRun = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--') continue;
    if (argument === '--dry-run') dryRun = true;
    else if (argument === '--bundle-dir') {
      directory = args[++index];
      if (!directory || directory.startsWith('--')) throw new Error('--bundle-dir needs a directory');
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!directory)
    throw new Error('Usage: vp run video:tutorial:publish -- --bundle-dir <rendered-directory> [--dry-run]');
  return { bundleDirectory: resolve(directory), dryRun };
}

async function main(): Promise<void> {
  const { bundleDirectory, dryRun } = parseTutorialPublishArgs(process.argv.slice(2));
  const plan = await publishTutorialBundle(bundleDirectory, { dryRun });
  console.info(`${dryRun ? 'Dry run' : 'Published'}: ${plan.bundle.episodeId}, ${plan.assets.length} verified assets`);
  for (const asset of plan.assets.filter((asset) => asset.kind === 'video'))
    console.info(`${asset.filename}: ${asset.url}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
