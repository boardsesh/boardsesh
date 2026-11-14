import type { CredentialWriterContract } from '@boardsesh/db/credential-writer-acl';

export type CredentialDatabaseEnvironment = Readonly<Record<string, string | undefined>>;
export const CREDENTIAL_WRITER_ROLE = 'boardsesh_identity_writer';

interface CredentialDatabaseConfiguration {
  readonly contract: CredentialWriterContract;
  readonly connectionString: string;
  readonly contentConnectionString: string;
  readonly contentRole: string;
  readonly databaseName: string;
}

function parseConnectionUrl(connectionString: string | undefined): URL {
  try {
    if (!connectionString) throw new Error();
    const parsed = new URL(connectionString);
    if (
      !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
      !parsed.hostname ||
      !parsed.username ||
      !parsed.password ||
      parsed.pathname.length < 2 ||
      parsed.hash
    )
      throw new Error();
    return parsed;
  } catch {
    throw new Error('CREDENTIAL_DATABASE_CONFIGURATION_REQUIRED');
  }
}

/** Capture the two targets before opening a connection. No default-URL fallback. */
export function credentialDatabaseConfiguration(
  environment: CredentialDatabaseEnvironment,
): CredentialDatabaseConfiguration {
  const writer = parseConnectionUrl(environment.AUTH_IDENTITY_DATABASE_URL);
  const content = parseConnectionUrl(environment.DATABASE_URL);
  try {
    const selectedContract = environment.AUTH_IDENTITY_DATABASE_CONTRACT;
    const contract = selectedContract === undefined || selectedContract === '' ? 'private-web-v1' : selectedContract;
    if (
      contract !== 'private-web-v1' &&
      contract !== 'private-browser-v1' &&
      contract !== 'private-provider-v1' &&
      contract !== 'private-first-password-v1' &&
      contract !== 'private-native-handoff-v1' &&
      contract !== 'private-browser-renewal-v1'
    )
      throw new Error();
    if (
      decodeURIComponent(writer.username) !== CREDENTIAL_WRITER_ROLE ||
      decodeURIComponent(writer.username) === decodeURIComponent(content.username) ||
      decodeURIComponent(writer.password) === decodeURIComponent(content.password) ||
      writer.hostname !== content.hostname ||
      (writer.port || '5432') !== (content.port || '5432') ||
      decodeURIComponent(writer.pathname) !== decodeURIComponent(content.pathname) ||
      [...writer.searchParams.keys()].some((name) => name !== 'sslmode') ||
      [...content.searchParams.keys()].some((name) => name !== 'sslmode') ||
      writer.searchParams.getAll('sslmode').length > 1 ||
      content.searchParams.getAll('sslmode').length > 1
    )
      throw new Error();
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(writer.hostname);
    if (!loopback && writer.searchParams.get('sslmode') !== 'verify-full') throw new Error();
    return Object.freeze({
      contract,
      connectionString: writer.href,
      contentConnectionString: content.href,
      contentRole: decodeURIComponent(content.username),
      databaseName: decodeURIComponent(writer.pathname.slice(1)),
    });
  } catch {
    throw new Error('CREDENTIAL_DATABASE_CONFIGURATION_REQUIRED');
  }
}
