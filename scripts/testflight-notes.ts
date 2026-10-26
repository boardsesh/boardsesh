/// <reference types="node" />

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseTestflightBuildReceipt } from './lib/testflight-build';
import { createTestflightCommandRunner } from './lib/testflight-github';
import { generateTestflightNotes, type NotesCommandRunner } from './lib/testflight-notes';

export function main(
  arguments_: string[] = process.argv.slice(2),
  runner: NotesCommandRunner = createTestflightCommandRunner(),
): void {
  const options = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const argument = arguments_[index + 1];
    if (!['--receipt', '--output', '--plans-output'].includes(flag) || !argument || options.has(flag)) {
      throw new Error('Usage: testflight-notes.ts --receipt <json> --output <txt> --plans-output <json>');
    }
    options.set(flag, argument);
  }
  const receiptPath = options.get('--receipt');
  const outputPath = options.get('--output');
  const plansPath = options.get('--plans-output');
  if (!receiptPath || !outputPath || !plansPath)
    throw new Error('Receipt, notes output, and full-plans output paths are required.');
  const receipt = parseTestflightBuildReceipt(JSON.parse(readFileSync(receiptPath, 'utf8')) as unknown);
  const generated = generateTestflightNotes(receipt, runner, process.env.GITHUB_REPOSITORY ?? 'boardsesh/boardsesh');
  mkdirSync(dirname(resolve(outputPath)), { recursive: true });
  mkdirSync(dirname(resolve(plansPath)), { recursive: true });
  writeFileSync(outputPath, generated.notes);
  writeFileSync(plansPath, `${JSON.stringify({ receipt, ...generated }, null, 2)}\n`);
  console.log(
    `Prepared ${generated.includedPrNumbers.length} native test scenarios for ${receipt.version} (${receipt.buildNumber}).`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(`[testflight-notes] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
