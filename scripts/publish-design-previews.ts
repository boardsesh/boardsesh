import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createDesignPreviewPublisher, DESIGN_ROOT } from './lib/design-previews';

async function main(): Promise<void> {
  const publish = createDesignPreviewPublisher();
  const previews = readdirSync(DESIGN_ROOT, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.png'))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
  if (!previews.length) throw new Error('No local design PNGs; run vp run design:mockups first');
  for (const preview of previews) console.log(`[design:publish] ${await publish(preview)}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Design preview publishing failed');
  process.exitCode = 1;
});
