import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createDevObjectPublisher } from './lib/dev-object-store';
import { FIXTURE_SNAPSHOT_REFERENCE, decodeFixtureSnapshot, snapshotHash } from './lib/screenshot-fixture-snapshot';
import {
  DEFAULT_SCREENSHOT_FIXTURES_DIR,
  findSensitiveVariableKeys,
  findUnpseudonymisedPersonFields,
  validateScreenshotFixtureManifest,
  type GraphqlFixtureFile,
} from './lib/screenshot-fixtures';

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((argument) => argument !== '--');
  if (args.length > 1) throw new Error('Usage: vp run mobile:screenshot-fixtures-publish -- [recording-directory]');
  const directory = resolve(args[0] ?? DEFAULT_SCREENSHOT_FIXTURES_DIR);
  const manifestBytes = readFileSync(join(directory, 'manifest.json'));
  const validation = validateScreenshotFixtureManifest(JSON.parse(manifestBytes.toString('utf8')));
  if (!validation.ok) throw new Error(`Invalid fixture manifest: ${validation.reason}`);
  const manifest = validation.manifest;
  const files: Record<string, string> = { 'manifest.json': manifestBytes.toString('base64') };
  // Build the bundle solely from the manifest; credentials and local side files
  // can never enter it through an indiscriminate directory archive.
  for (const entry of [...manifest.graphql, ...manifest.static]) {
    if (!/^(graphql|static)\/[\w./-]+$/.test(entry.file) || entry.file.split('/').some((part) => part === '..')) {
      throw new Error(`Invalid fixture path: ${entry.file}`);
    }
    const bytes = readFileSync(join(directory, entry.file));
    if (entry.file.startsWith('graphql/')) {
      const fixture = JSON.parse(bytes.toString('utf8')) as GraphqlFixtureFile;
      if (
        findSensitiveVariableKeys(fixture.variables).length ||
        findUnpseudonymisedPersonFields(fixture.response, { ownUserId: manifest.accountUserId }).length
      ) {
        throw new Error(`Refusing to publish unsanitized fixture: ${entry.file}`);
      }
    }
    files[entry.file] = bytes.toString('base64');
  }
  const compressed = gzipSync(JSON.stringify({ version: 1, files }), { level: 9 });
  const sha256 = snapshotHash(compressed);
  const publish = createDevObjectPublisher();
  const key = `screenshot-fixtures/${sha256}.json.gz`;
  const reference = {
    version: 1 as const,
    url: '',
    sha256,
    bytes: compressed.length,
    files: Object.keys(files).length,
  };
  decodeFixtureSnapshot(compressed, reference);
  reference.url = await publish(key, compressed, 'application/gzip');
  writeFileSync(FIXTURE_SNAPSHOT_REFERENCE, `${JSON.stringify(reference, null, 2)}\n`);
  console.log(`[screenshot-fixtures] Published ${manifest.graphql.length} GraphQL fixtures: ${reference.url}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Fixture snapshot publishing failed');
  process.exitCode = 1;
});
