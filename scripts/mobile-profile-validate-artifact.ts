/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { exportedIdentity } from './lib/mobile-profile-harness';
import type { PreparedProfile } from './lib/mobile-profile-prepare';

export function validateProfileArtifact(runDirectory: string, appPath: string) {
  const prepared = JSON.parse(readFileSync(join(runDirectory, 'prepare.json'), 'utf8')) as PreparedProfile;
  return exportedIdentity(prepared, appPath);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [directory, appPath] = process.argv.slice(2);
  if (!directory || !appPath)
    throw new Error(
      'Usage: vp exec tsx scripts/mobile-profile-validate-artifact.ts <prepare-directory> <Release.app|Release.apk>',
    );
  console.log(
    JSON.stringify(
      {
        validEmbeddedIdentity: true,
        identity: validateProfileArtifact(resolve(directory), resolve(appPath)),
        scope: 'Embedded ASCII identity gate; native physical Release HELLO is still mandatory.',
      },
      null,
      2,
    ),
  );
}
