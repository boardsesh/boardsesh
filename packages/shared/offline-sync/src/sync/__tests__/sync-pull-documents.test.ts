// `listSyncPullDocuments` is the only way anything outside pull-client.ts can
// enumerate the sync operations, because the documents are BUILT from
// TABLE_CONFIGS at runtime rather than written out. The App Store screenshot
// recorder keys fixtures by operation name, so a table config that gains an
// operation nobody recorded has to be visible from here.

import { describe, expect, it } from 'vitest';
import { listSyncPullDocuments } from '../pull-client';
import { TABLE_CONFIGS } from '../table-config';

/** The operation name a document declares, e.g. `query SyncTicks(...)` -> `SyncTicks`. */
function declaredOperationName(document: string): string | null {
  const declared = document.match(/\b(query|mutation|subscription)\s+([A-Za-z_]\w*)/);
  return declared ? declared[2] : null;
}

describe('listSyncPullDocuments', () => {
  it('returns one document per table config plus the deletions query', () => {
    const documents = listSyncPullDocuments();
    expect(documents).toHaveLength(Object.keys(TABLE_CONFIGS).length + 1);
    expect(documents.map((entry) => entry.operationName)).toContain('SyncDeletions');
  });

  it('names every table config query exactly once', () => {
    const names = listSyncPullDocuments().map((entry) => entry.operationName);
    expect(new Set(names).size).toBe(names.length);
    for (const config of Object.values(TABLE_CONFIGS)) {
      const expectedName = `${config.queryName[0].toUpperCase()}${config.queryName.slice(1)}`;
      expect(names).toContain(expectedName);
    }
  });

  it('gives every document a named operation matching its reported name', () => {
    for (const { operationName, document } of listSyncPullDocuments()) {
      expect(declaredOperationName(document), `${operationName} has no named operation`).toBe(operationName);
    }
  });

  it('scopes only the per-board queries to a board', () => {
    const documentsByName = new Map(listSyncPullDocuments().map((entry) => [entry.operationName, entry.document]));
    for (const config of Object.values(TABLE_CONFIGS)) {
      const expectedName = `${config.queryName[0].toUpperCase()}${config.queryName.slice(1)}`;
      const document = documentsByName.get(expectedName) ?? '';
      expect(document.includes('$boardType: String!'), `${expectedName} board scoping`).toBe(config.isPerBoard);
    }
  });
});
