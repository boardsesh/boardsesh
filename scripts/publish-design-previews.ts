import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createDesignPreviewPublisher, designPreviewFiles, DESIGN_ROOT } from './lib/design-previews';

async function main(): Promise<void> {
  const { publish, finish } = createDesignPreviewPublisher();
  const htmlFiles = readdirSync(DESIGN_ROOT, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.html'))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
  const completeSet = designPreviewFiles(htmlFiles);
  const previews = completeSet.filter((filename) => existsSync(filename));
  if (completeSet.length && !previews.length) throw new Error('No local design PNGs; run vp run design:mockups first');
  for (const preview of previews) console.log(`[design:publish] ${await publish(preview)}`);
  finish(completeSet);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Design preview publishing failed');
  process.exitCode = 1;
});
