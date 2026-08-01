import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { AUDIT_SCAN_QUERY, runDatabaseAudit, type ArtifactSink } from './audit-legacy-tick-timestamps.js';
import { assertPrivacySafeRecord, type AuditPolicy } from './legacy-timestamp-audit-core.js';

const DATABASE_URL = process.env.LEGACY_TIMESTAMP_AUDIT_DB_URL;

function isExplicitLocalDatabase(databaseUrl: string): boolean {
  try {
    return ['localhost', '127.0.0.1', '::1', 'postgres'].includes(
      new URL(databaseUrl).hostname.replace(/^\[|\]$/g, ''),
    );
  } catch {
    return false;
  }
}

const policy: AuditPolicy = {
  policyId: 'integration-test-policy',
  liveOldCodeActiveThroughEpochSeconds: Date.parse('2026-07-08T00:00:00Z') / 1000,
  liveFixedCodeActiveFromEpochSeconds: Date.parse('2026-07-08T01:00:00Z') / 1000,
  jsonOldCodeActiveThroughEpochSeconds: Date.parse('2026-07-08T00:00:00Z') / 1000,
  jsonFixedCodeActiveFromEpochSeconds: Date.parse('2026-07-08T01:00:00Z') / 1000,
  originWritersActiveFromEpochSeconds: Date.parse('2026-07-08T01:00:00Z') / 1000,
  nativeSafeGenerationActiveFromEpochSeconds: Date.parse('2026-07-08T01:00:00Z') / 1000,
};

if (!DATABASE_URL || !isExplicitLocalDatabase(DATABASE_URL)) {
  void describe('legacy timestamp audit PostgreSQL contract', () => {
    void it(
      'skipped — set LEGACY_TIMESTAMP_AUDIT_DB_URL to an explicitly local, migrated PostgreSQL database',
      { skip: true },
      () => {},
    );
  });
} else {
  void describe('legacy timestamp audit PostgreSQL contract', () => {
    void it('scans a real schema in a serializable, read-only, deferrable UTC snapshot', async () => {
      let emittedRecords = 0;
      let metadataVerified = false;
      const sink: ArtifactSink = {
        async writeCanonicalRecord(record) {
          assert.equal(metadataVerified, true, 'metadata callback must run before evidence is emitted');
          assertPrivacySafeRecord(record);
          emittedRecords += 1;
        },
      };
      const { counters, metadata } = await runDatabaseAudit(DATABASE_URL, policy, sink, randomBytes(32), async () => {
        metadataVerified = true;
      });
      assert.equal(metadataVerified, true);
      assert.equal(metadata.transactionIsolation, 'serializable');
      assert.equal(metadata.transactionReadOnly, 'on');
      assert.equal(metadata.transactionDeferrable, 'on');
      assert.equal(metadata.timeZone, 'UTC');
      assert.match(metadata.schemaSha256, /^[a-f0-9]{64}$/);
      assert.ok(counters.scannedRows >= emittedRecords);
    });

    void it('has a read-only EXPLAIN shape with no modifying plan nodes', async () => {
      const client = postgres(DATABASE_URL, { max: 1, prepare: false });
      try {
        const rows = await client.unsafe(`EXPLAIN (FORMAT JSON, COSTS true) ${AUDIT_SCAN_QUERY}`);
        const planText = JSON.stringify(rows[0]?.['QUERY PLAN']);
        assert.match(planText, /boardsesh_ticks/);
        assert.doesNotMatch(planText, /ModifyTable|Insert|Update|Delete/);
      } finally {
        await client.end();
      }
    });
  });
}
