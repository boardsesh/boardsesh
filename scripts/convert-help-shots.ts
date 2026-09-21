import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import {
  assertPngBytes,
  DEFAULT_HELP_SHOT_DIR,
  HELP_WEBP_DIR,
  HELP_WEBP_ENCODE,
  HELP_WEBP_EXPECTED_MAX_BYTES,
  HELP_WEBP_RESIZE,
  parseHelpShotArgs,
  resolveHelpShotSet,
} from './lib/help-shots';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = `Usage: vp run help:convert-shots [-- [--input <dir>] [--dry-run]]

Converts the captured help-page PNGs into the webp assets the help page ships,
writing ${relative(REPO_ROOT, HELP_WEBP_DIR)}/<name>.webp.

  --input <dir>   Capture directory, also accepted as a bare positional
                  (default: ${DEFAULT_HELP_SHOT_DIR})
  --dry-run       List the conversions without writing any webp
  --help          Show this message

Encoder settings match the marketing captures exactly; see
docs/design/marketing-campaign-assets.md.`;

async function main(): Promise<void> {
  const { inputDir, dryRun, help } = parseHelpShotArgs(process.argv.slice(2));
  if (help) {
    console.log(USAGE);
    return;
  }

  // Throws naming every absent capture, before a single webp is written: a help
  // page missing one image is worse than a run that refused to start.
  const captures = resolveHelpShotSet(inputDir);
  if (dryRun) {
    for (const capture of captures) console.log(`[help:convert-shots] would write ${capture.asset}.webp`);
    return;
  }

  mkdirSync(HELP_WEBP_DIR, { recursive: true });
  let oversized = 0;
  for (const capture of captures) {
    const png = readFileSync(capture.filename);
    assertPngBytes(capture.filename, png);
    // Only proportional downsampling and webp encoding — no crops, no composited
    // chrome. Same call as the marketing assets so the two sets look like one set.
    const webp = await sharp(png).resize(HELP_WEBP_RESIZE).webp(HELP_WEBP_ENCODE).toBuffer();
    const target = resolve(HELP_WEBP_DIR, `${capture.asset}.webp`);
    writeFileSync(target, webp);
    const oversize = webp.length > HELP_WEBP_EXPECTED_MAX_BYTES ? '  <- larger than the marketing assets' : '';
    if (oversize) oversized += 1;
    console.log(`[help:convert-shots] ${capture.asset}.webp  ${webp.length.toLocaleString('en-US')} bytes${oversize}`);
  }
  if (oversized) {
    console.log(
      `[help:convert-shots] ${oversized} asset(s) over ${HELP_WEBP_EXPECTED_MAX_BYTES.toLocaleString('en-US')} bytes; ` +
        'check the capture device scale before committing',
    );
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Help screenshot conversion failed');
  process.exitCode = 1;
});
