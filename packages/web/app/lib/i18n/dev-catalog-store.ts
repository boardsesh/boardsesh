import { readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_LOCALE, SEED_NAMESPACES, isSupportedLocale } from './config';
import { flattenTranslations, preservesTranslationFormat, type TranslationEntry } from './dev-editor';

export class CatalogEditError extends Error {
  constructor(public readonly status: number) {
    super('Catalog edit rejected');
  }
}

export function devCatalogDirectory(): string {
  // Next starts in packages/web; tests/tools may start at the monorepo root.
  return resolve(
    process.cwd(),
    process.cwd().endsWith('/packages/web') ? '../shared/i18n/locales' : 'packages/shared/i18n/locales',
  );
}

export async function readDevCatalog(
  locale: string,
  namespace: string,
  directory = devCatalogDirectory(),
): Promise<unknown> {
  if (!isSupportedLocale(locale) || !SEED_NAMESPACES.includes(namespace as (typeof SEED_NAMESPACES)[number])) {
    throw new CatalogEditError(400);
  }
  return JSON.parse(await readFile(resolve(directory, locale, `${namespace}.json`), 'utf8')) as unknown;
}

export async function readDevEntries(locale: string): Promise<TranslationEntry[]> {
  const namespaces = await Promise.all(
    SEED_NAMESPACES.map(async (namespace) => {
      const [catalog, fallback] = await Promise.all([
        readDevCatalog(locale, namespace),
        locale === DEFAULT_LOCALE ? Promise.resolve({}) : readDevCatalog(DEFAULT_LOCALE, namespace),
      ]);
      const merged = new Map(flattenTranslations(fallback).map((entry) => [entry.key, entry]));
      for (const entry of flattenTranslations(catalog)) merged.set(entry.key, entry);
      return [...merged.values()].map((entry) => ({ namespace, ...entry }));
    }),
  );
  return namespaces.flat();
}

// Serialize the read/compare/write cycle, including different keys in one file.
// Keep the queue through dev HMR so an older route module cannot race a new one.
const storeGlobal = globalThis as typeof globalThis & { boardseshCatalogWrite?: Promise<void> };

export async function saveDevTranslation(input: unknown, directory = devCatalogDirectory()): Promise<void> {
  if (!input || typeof input !== 'object') throw new CatalogEditError(400);
  const { locale, namespace, key, previous, replacement } = input as Record<string, unknown>;
  if (
    typeof locale !== 'string' ||
    typeof namespace !== 'string' ||
    typeof key !== 'string' ||
    typeof previous !== 'string' ||
    typeof replacement !== 'string' ||
    replacement.length > 20000
  ) {
    throw new CatalogEditError(400);
  }
  const segments = key.split('.');
  if (segments.some((segment) => !segment || ['__proto__', 'prototype', 'constructor'].includes(segment))) {
    throw new CatalogEditError(400);
  }
  const pending = (storeGlobal.boardseshCatalogWrite ?? Promise.resolve()).then(async () => {
    const catalog = await readDevCatalog(locale, namespace, directory);
    let parent: unknown = catalog;
    for (const segment of segments.slice(0, -1)) {
      if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, segment)) throw new CatalogEditError(400);
      parent = (parent as Record<string, unknown>)[segment];
    }
    const leaf = segments[segments.length - 1];
    if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, leaf)) throw new CatalogEditError(400);
    const record = parent as Record<string, unknown>;
    if (typeof record[leaf] !== 'string') throw new CatalogEditError(400);
    if (record[leaf] !== previous) throw new CatalogEditError(409);
    if (!preservesTranslationFormat(previous, replacement)) throw new CatalogEditError(422);
    record[leaf] = replacement;
    const filename = resolve(directory, locale, `${namespace}.json`);
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(catalog, null, 2)}\n`, { flag: 'wx' });
      await rename(temporary, filename);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  });
  storeGlobal.boardseshCatalogWrite = pending.catch(() => {});
  await pending;
}
