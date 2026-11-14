import { createDbOnPool, createDedicatedPoolFromUrl, type DbInstance } from '@boardsesh/db/client';
import type { CredentialWriterContract, CredentialWriterReceipt } from '@boardsesh/db/credential-writer-acl';

import {
  CREDENTIAL_WRITER_ROLE,
  credentialDatabaseConfiguration,
  type CredentialDatabaseEnvironment,
} from './credential-database-configuration';
import { assertSameCredentialDatabaseTarget } from './credential-database-identity';

export interface CredentialDatabase {
  readonly database: DbInstance;
  readonly receipt: CredentialWriterReceipt;
  close(): Promise<void>;
}

/** A distinct authenticated principal; SET ROLE and the content pool are never used. */
export async function createCredentialDatabase(
  environment: CredentialDatabaseEnvironment,
): Promise<CredentialDatabase> {
  const configuration = credentialDatabaseConfiguration(environment);
  const { qualifyCredentialWriter } = await import('@boardsesh/db/credential-writer-acl');
  const pool = createDedicatedPoolFromUrl(configuration.connectionString, 2, {
    connect_timeout: 2,
    connection: {
      application_name: 'boardsesh-credential-writer',
      statement_timeout: 10_000,
      idle_in_transaction_session_timeout: 10_000,
    },
  });
  try {
    // Auth statements contain passwords, recovery links and opaque credentials.
    // They must remain private even when the content pool's DEBUG_SQL is enabled.
    const database = createDbOnPool(pool, { logger: false });
    const receipt = await qualifyCredentialWriter(pool, {
      expectedRole: CREDENTIAL_WRITER_ROLE,
      expectedDatabase: configuration.databaseName,
      contract: configuration.contract,
    });
    if (receipt.contract !== configuration.contract) throw new Error('CREDENTIAL_DATABASE_CONTRACT_MISMATCH');
    await assertSameCredentialDatabaseTarget(pool, configuration.contentConnectionString, {
      writerRole: CREDENTIAL_WRITER_ROLE,
      contentRole: configuration.contentRole,
      database: configuration.databaseName,
    });
    return Object.freeze({ database, receipt, close: () => pool.end({ timeout: 5 }) });
  } catch (error) {
    await pool.end({ timeout: 5 });
    throw error;
  }
}

let credentialDatabase: Promise<CredentialDatabase> | undefined;
let credentialConnectionIdentity: string | undefined;
const reviewedCapabilities: Readonly<Record<CredentialWriterContract, readonly CredentialWriterContract[]>> =
  Object.freeze({
    'private-web-v1': Object.freeze(['private-web-v1'] as const),
    'private-browser-v1': Object.freeze(['private-web-v1', 'private-browser-v1'] as const),
    'private-provider-v1': Object.freeze(['private-web-v1', 'private-browser-v1', 'private-provider-v1'] as const),
    'private-first-password-v1': Object.freeze([
      'private-web-v1',
      'private-browser-v1',
      'private-provider-v1',
      'private-first-password-v1',
    ] as const),
    'private-native-handoff-v1': Object.freeze([
      'private-web-v1',
      'private-browser-v1',
      'private-provider-v1',
      'private-first-password-v1',
      'private-native-handoff-v1',
    ] as const),
    'private-browser-renewal-v1': Object.freeze([
      'private-web-v1',
      'private-browser-v1',
      'private-provider-v1',
      'private-first-password-v1',
      'private-native-handoff-v1',
      'private-browser-renewal-v1',
    ] as const),
  });

/** Called only after a private command has passed transport and input checks. */
export async function getCredentialDatabase(requiredContract?: CredentialWriterContract): Promise<DbInstance> {
  const configuration = credentialDatabaseConfiguration(process.env);
  if (requiredContract !== undefined && !reviewedCapabilities[configuration.contract].includes(requiredContract))
    throw new Error('CREDENTIAL_DATABASE_CAPABILITY_REQUIRED');
  const connectionIdentity = `${configuration.contract}\0${configuration.connectionString}\0${configuration.contentConnectionString}`;
  if (credentialDatabase && credentialConnectionIdentity !== connectionIdentity) {
    throw new Error('CREDENTIAL_DATABASE_CONFIGURATION_CHANGED');
  }
  if (!credentialDatabase) {
    const pending = createCredentialDatabase(process.env);
    credentialDatabase = pending;
    credentialConnectionIdentity = connectionIdentity;
    void pending.catch(() => {
      if (credentialDatabase === pending) {
        credentialDatabase = undefined;
        credentialConnectionIdentity = undefined;
      }
    });
  }
  return (await credentialDatabase).database;
}

/** Requests have drained before process shutdown releases this bounded pool. */
export async function closeCredentialDatabase(): Promise<void> {
  const pending = credentialDatabase;
  credentialDatabase = undefined;
  credentialConnectionIdentity = undefined;
  if (pending) await (await pending.catch(() => undefined))?.close();
}
