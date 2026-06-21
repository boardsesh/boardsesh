import { createHash } from 'node:crypto';

export const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';
export const SYSTEM_USER_EMAIL = 'system@boardsesh.com';

export function deterministicUuid(key: string): string {
  const hash = createHash('sha256').update(key).digest('hex');
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `4${hash.slice(13, 16)}`,
    `${((parseInt(hash[16] ?? '0', 16) & 0x3) | 0x8).toString(16)}${hash.slice(17, 20)}`,
    hash.slice(20, 32),
  ].join('-');
}

export function slugifyLocationName(name: string, uniqueSuffixSource: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  const suffix = uniqueSuffixSource.replace(/-/g, '').slice(-8);
  return `${base || 'board'}-${suffix}`;
}

export function shortHash(value: string): string {
  return createHash('md5').update(value).digest('hex').slice(0, 6);
}

export function gymUuidForSource(sourceKey: string): string {
  return deterministicUuid(`gym:${sourceKey}`);
}

export function boardUuidForSource(sourceKey: string): string {
  return deterministicUuid(sourceKey);
}
