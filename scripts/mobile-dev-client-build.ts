/// <reference types="node" />

/**
 * Triggers an EAS Build for the real-device iOS development client. Install
 * this shell on an iPhone once, then use More -> Metro Bundler to switch
 * between local Metro servers from different worktrees.
 */

import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MOBILE_DIR = resolve(ROOT_DIR, 'packages', 'mobile');
const EAS_ARGS = [
  'x',
  '-p',
  'eas-cli@16',
  'eas',
  'build',
  '--profile',
  'development-device',
  '--platform',
  'ios',
  '--non-interactive',
];

console.log('[mobile:dev-client-build] Profile:  development-device');
console.log('[mobile:dev-client-build] Platform: ios');
console.log('[mobile:dev-client-build] Distribution: internal');
console.log('[mobile:dev-client-build] Development client: true');
console.log('');
console.log('[mobile:dev-client-build] Install this build on the iPhone used for local Metro testing.');
console.log('[mobile:dev-client-build] After install, switch servers in More -> Metro Bundler.');
console.log('');
console.log(`[mobile:dev-client-build] Running: bun ${EAS_ARGS.join(' ')}`);
console.log('');

const result = spawnSync('bun', EAS_ARGS, {
  cwd: MOBILE_DIR,
  stdio: 'inherit',
  env: { ...process.env },
});

if (result.status !== 0) {
  console.error('');
  console.error('[mobile:dev-client-build] Build submission failed.');
  if (result.status === 1) {
    console.error('[mobile:dev-client-build] Make sure you are logged in: bun x -p eas-cli@16 eas login');
  }
  process.exit(result.status ?? 1);
}

console.log('');
console.log('[mobile:dev-client-build] Build submitted to EAS.');
console.log('[mobile:dev-client-build] Once complete, install the internal build on your iPhone.');
