/* Preserve Metro's Debug ID while composing the native Hermes map. */
const { execFileSync } = require('node:child_process');
const { readFileSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');
const args = process.argv.slice(2);
const outputIndex = args.indexOf('-o');
if (outputIndex < 0 || !args[outputIndex + 1]) throw new Error('Composed source map output is required.');
const packagerMap = JSON.parse(readFileSync(args[0], 'utf8'));
const debugId = packagerMap.debugId ?? packagerMap.debug_id;
if (typeof debugId !== 'string') throw new Error('Metro source map has no Debug ID.');
execFileSync(
  process.execPath,
  [resolve(__dirname, '../packages/mobile/node_modules/react-native/scripts/compose-source-maps.js'), ...args],
  { stdio: 'inherit' },
);
const outputPath = args[outputIndex + 1];
const composedMap = JSON.parse(readFileSync(outputPath, 'utf8'));
writeFileSync(outputPath, JSON.stringify({ ...composedMap, debug_id: debugId, debugId }));
