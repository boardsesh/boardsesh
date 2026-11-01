/// <reference types="node" />

export { readMarketingVersion } from './mobile-release-policy.ts';
export const APP_CONFIG_PATH = 'packages/mobile/app.config.ts';
export const BOT_NAME = 'boardsesh-repo-bot[bot]';
export const BOT_EMAIL = 'boardsesh-repo-bot[bot]@users.noreply.github.com';

export function parseSemver(version: string): readonly [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`Expected a plain major.minor.patch version: ${version}`);
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) throw new Error('Version components must be safe integers.');
  return [parts[0]!, parts[1]!, parts[2]!];
}
