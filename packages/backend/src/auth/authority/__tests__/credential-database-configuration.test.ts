import { describe, expect, it } from 'vite-plus/test';
import { credentialDatabaseConfiguration } from '../../credential-database-configuration';

const contentUrl = 'postgresql://boardsesh_runtime:content-secret@127.0.0.1:55475/owned_fixture';
const writerUrl = 'postgresql://boardsesh_identity_writer:writer-secret@127.0.0.1:55475/owned_fixture';

describe('credential database target binding', () => {
  it('requires explicit, distinct writer credentials for the same database', () => {
    expect(
      credentialDatabaseConfiguration({ DATABASE_URL: contentUrl, AUTH_IDENTITY_DATABASE_URL: writerUrl }),
    ).toEqual({
      contract: 'private-web-v1',
      connectionString: writerUrl,
      contentConnectionString: contentUrl,
      contentRole: 'boardsesh_runtime',
      databaseName: 'owned_fixture',
    });
  });

  it.each([
    {},
    { DATABASE_URL: contentUrl },
    { AUTH_IDENTITY_DATABASE_URL: writerUrl },
    { DATABASE_URL: contentUrl, AUTH_IDENTITY_DATABASE_URL: contentUrl },
    { DATABASE_URL: writerUrl, AUTH_IDENTITY_DATABASE_URL: writerUrl },
    { DATABASE_URL: contentUrl, AUTH_IDENTITY_DATABASE_URL: writerUrl.replace('writer-secret', 'content-secret') },
    { DATABASE_URL: contentUrl, AUTH_IDENTITY_DATABASE_URL: writerUrl.replace('writer-secret', '') },
    { DATABASE_URL: contentUrl, AUTH_IDENTITY_DATABASE_URL: writerUrl.replace('owned_fixture', 'another_database') },
    { DATABASE_URL: contentUrl, AUTH_IDENTITY_DATABASE_URL: writerUrl.replace('55475', '55476') },
    { DATABASE_URL: contentUrl, AUTH_IDENTITY_DATABASE_URL: writerUrl.replace('127.0.0.1', 'localhost') },
    { DATABASE_URL: contentUrl, AUTH_IDENTITY_DATABASE_URL: `${writerUrl}?user=boardsesh_runtime` },
    { DATABASE_URL: `${contentUrl}?user=boardsesh_identity_writer`, AUTH_IDENTITY_DATABASE_URL: writerUrl },
    { DATABASE_URL: contentUrl, AUTH_IDENTITY_DATABASE_URL: `${writerUrl}?options=-c%20role%3Dpostgres` },
    { DATABASE_URL: contentUrl, AUTH_IDENTITY_DATABASE_URL: `${writerUrl}?sslmode=verify-full&sslmode=disable` },
    { DATABASE_URL: `${contentUrl}?sslmode=require&sslmode=disable`, AUTH_IDENTITY_DATABASE_URL: writerUrl },
    { DATABASE_URL: contentUrl, AUTH_IDENTITY_DATABASE_URL: `${writerUrl}#hidden-target` },
    { DATABASE_URL: contentUrl, AUTH_IDENTITY_DATABASE_URL: 'invalid-private-connection-secret' },
    { DATABASE_URL: contentUrl, AUTH_IDENTITY_DATABASE_URL: writerUrl.replace('postgresql:', 'https:') },
    { DATABASE_URL: contentUrl, AUTH_IDENTITY_DATABASE_URL: writerUrl.replace('owned_fixture', '%ZZ') },
    {
      DATABASE_URL: contentUrl,
      AUTH_IDENTITY_DATABASE_URL: writerUrl,
      AUTH_IDENTITY_DATABASE_CONTRACT: 'owner-attested',
    },
  ])(
    'refuses missing, reused or differently routed credentials without exposing connection strings: %#',
    (environment) => {
      expect(() => credentialDatabaseConfiguration(environment)).toThrow('CREDENTIAL_DATABASE_CONFIGURATION_REQUIRED');
      try {
        credentialDatabaseConfiguration(environment);
      } catch (error) {
        expect(String(error)).not.toMatch(/secret|postgresql|127\.0\.0\.1|55475/);
      }
    },
  );

  it('requires verified TLS for a non-loopback writer target', () => {
    const content = contentUrl.replace('127.0.0.1', 'db.example.test');
    const writer = writerUrl.replace('127.0.0.1', 'db.example.test');
    for (const suffix of ['', '?sslmode=require', '?sslmode=disable']) {
      expect(() =>
        credentialDatabaseConfiguration({ DATABASE_URL: content, AUTH_IDENTITY_DATABASE_URL: writer + suffix }),
      ).toThrow('CREDENTIAL_DATABASE_CONFIGURATION_REQUIRED');
    }
    expect(
      credentialDatabaseConfiguration({
        DATABASE_URL: content,
        AUTH_IDENTITY_DATABASE_URL: `${writer}?sslmode=verify-full`,
      }),
    ).toEqual({
      contract: 'private-web-v1',
      connectionString: `${writer}?sslmode=verify-full`,
      contentConnectionString: content,
      contentRole: 'boardsesh_runtime',
      databaseName: 'owned_fixture',
    });
  });

  it.each([
    'private-browser-v1',
    'private-provider-v1',
    'private-first-password-v1',
    'private-native-handoff-v1',
    'private-browser-renewal-v1',
  ] as const)('selects explicit reviewed %s without changing targets', (contract) => {
    expect(
      credentialDatabaseConfiguration({
        DATABASE_URL: contentUrl,
        AUTH_IDENTITY_DATABASE_URL: writerUrl,
        AUTH_IDENTITY_DATABASE_CONTRACT: contract,
      }),
    ).toMatchObject({
      contract,
      connectionString: writerUrl,
      contentConnectionString: contentUrl,
    });
  });
});
