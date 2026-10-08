/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { decodeFixtureSnapshot, snapshotHash } from './screenshot-fixture-snapshot';
import {
  findSensitiveVariableKeys,
  findUnpseudonymisedPersonFields,
  validateScreenshotFixtureManifest,
  type GraphqlFixtureFile,
} from './screenshot-fixtures';

/** Packages only manifest-listed, sanitized recordings for either storage provider. */
export function createFixtureSnapshotArchive(directory: string) {
  const manifestBytes = readFileSync(join(directory, 'manifest.json'));
  const validation = validateScreenshotFixtureManifest(JSON.parse(manifestBytes.toString('utf8')));
  if (!validation.ok) throw new Error(`Invalid fixture manifest: ${validation.reason}`);
  const manifest = validation.manifest;
  const files: Record<string, string> = { 'manifest.json': manifestBytes.toString('base64') };
  for (const entry of [...manifest.graphql, ...manifest.static]) {
    if (!/^(graphql|static)\/[\w./-]+$/.test(entry.file) || entry.file.split('/').some((part) => part === '..')) {
      throw new Error(`Invalid fixture path: ${entry.file}`);
    }
    const bytes = readFileSync(join(directory, entry.file));
    if (entry.file.startsWith('graphql/')) {
      const fixture = JSON.parse(bytes.toString('utf8')) as GraphqlFixtureFile;
      if (
        findSensitiveVariableKeys(fixture.variables).length ||
        findUnpseudonymisedPersonFields(fixture.response, {
          ownUserId: manifest.accountUserId,
          approvedTestUserIds: manifest.approvedTestUserIds,
        }).length
      ) {
        throw new Error(`Refusing to publish unsanitized fixture: ${entry.file}`);
      }
    }
    files[entry.file] = bytes.toString('base64');
  }
  const compressed = gzipSync(JSON.stringify({ version: 1, files }), { level: 9 });
  const reference = {
    version: 1 as const,
    url: '',
    sha256: snapshotHash(compressed),
    bytes: compressed.length,
    files: Object.keys(files).length,
  };
  decodeFixtureSnapshot(compressed, reference);
  return { compressed, reference, graphqlCount: manifest.graphql.length };
}
