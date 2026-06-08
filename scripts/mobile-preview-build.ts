/// <reference types="node" />

/**
 * Triggers an EAS Build for the "preview" profile. Testers install this build
 * once — it contains the native runtime and can receive OTA updates from any
 * EAS Update branch via `vp run mobile:publish`.
 *
 * Usage:
 *   vp run mobile:preview-build                    # iOS + Android
 *   vp run mobile:preview-build -- --platform ios  # iOS only
 *   vp run mobile:preview-build -- --platform android
 */

import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MOBILE_DIR = resolve(ROOT_DIR, 'packages', 'mobile');

function parseArgs(args: string[]): { platform: string } {
  let platform = 'all';

  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--') continue;

    if (argument === '--platform' || argument === '-p') {
      platform = args[++index] ?? 'all';
      continue;
    }
    if (argument.startsWith('--platform=')) {
      platform = argument.slice('--platform='.length);
      continue;
    }
  }

  return { platform };
}

const VALID_PLATFORMS = ['ios', 'android', 'all'] as const;

const { platform } = parseArgs(process.argv.slice(2));

if (!VALID_PLATFORMS.includes(platform as (typeof VALID_PLATFORMS)[number])) {
  console.error(`[mobile:preview-build] Invalid platform "${platform}". Must be one of: ${VALID_PLATFORMS.join(', ')}`);
  process.exit(1);
}

console.log(`[mobile:preview-build] Profile:  preview`);
console.log(`[mobile:preview-build] Platform: ${platform}`);
console.log(`[mobile:preview-build] Distribution: internal (ad-hoc / APK)`);
console.log('');
console.log('[mobile:preview-build] This build is the "shell" that testers install once.');
console.log('[mobile:preview-build] After install, they receive JS updates via `vp run mobile:publish`.');
console.log('');

const easArgs = [
  'x',
  '-p',
  'eas-cli@16',
  'eas',
  'build',
  '--profile',
  'preview',
  '--platform',
  platform,
  '--non-interactive',
];

console.log(`[mobile:preview-build] Running: bun ${easArgs.join(' ')}`);
console.log('');

const result = spawnSync('bun', easArgs, {
  cwd: MOBILE_DIR,
  stdio: 'inherit',
  env: { ...process.env },
});

if (result.status !== 0) {
  console.error('');
  console.error('[mobile:preview-build] Build submission failed.');
  if (result.status === 1) {
    console.error('[mobile:preview-build] Make sure you are logged in: bun x -p eas-cli@16 eas login');
  }
  process.exit(result.status ?? 1);
}

console.log('');
console.log('[mobile:preview-build] Build submitted to EAS.');
console.log('[mobile:preview-build] Once complete, share the install link from the EAS dashboard');
console.log('[mobile:preview-build] or run: bun x -p eas-cli@16 eas build:list --profile preview --status finished');
