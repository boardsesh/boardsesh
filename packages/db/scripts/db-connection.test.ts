import test from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import {
  assertDevelopmentAuthSeedTarget,
  describeDatabaseHost,
  isLocalDatabaseUrl,
  resolveScriptDatabaseUrl,
  scriptDatabaseConnectionOptions,
} from './db-connection.js';

const authSeedTargetError = 'Development authentication seeds require an unambiguous local development PostgreSQL URL';

void test('auth seeds accept the actual Docker image target and supported development hosts', () => {
  const targets = [
    'postgresql://postgres@localhost/main',
    'postgres://postgres:password@postgres:5432/main',
    'postgresql://user:p%40ss%2Fword@LOCALHOST:5432/main',
    'postgresql://user@127.0.1.1/main',
    'postgresql://user@127.255.255.255/main',
    'postgresql://user@localtest.me/main',
    'postgresql://user@app.localtest.me/main',
    'postgresql://user@dev-box.tailnet.ts.net/main',
    'postgresql://user@100.64.0.1/main',
    'postgresql://user@100.127.255.255/main',
    'postgresql://user@localhost/main?sslmode=disable',
    'postgresql://user@localhost/main?sslmode=verify-full&sslrootcert=system',
    'postgresql://user@localhost/main?application_name=dev-seed:local',
  ];
  for (const target of targets) assert.doesNotThrow(() => assertDevelopmentAuthSeedTarget(target, {}));
});

void test('auth seeds reject remote, ambiguous and startup-overridden targets with one safe error', () => {
  const targets = [
    '',
    'not a URL',
    'https://user:seed-secret@localhost/main',
    'postgresql://user:seed-secret@reserved.invalid/main',
    'postgresql://localhost:seed-secret@reserved.invalid/main',
    'postgresql://user:seed-secret@localhost.reserved.invalid/main',
    'postgresql:///main',
    'postgresql://user@localhost',
    'postgresql://user@localhost/',
    'postgresql://user@localhost/main/other',
    'postgresql://user@localhost/main#',
    'postgresql://user@localhost/main#seed-secret',
    'postgresql://user:seed-secret@localhost@localhost/main',
    'postgresql://user@reserved.invalid,localhost/main',
    'postgresql://user@reserved.invalid%2Clocalhost/main',
    'postgresql://user@%2Ftmp%2Fpostgres.localtest.me/main',
    'postgresql://user@[::1]/main',
    'postgresql://user@100.064.0.1/main',
    'postgresql://user@127.000.0.1/main',
    'postgresql://user@localhost:00001/main',
    'postgresql://user@localhost:65536/main',
    'postgresql://user:seed-secret@local\nhost/main',
    'postgresql://user:seed-secret@localhost/main ',
    'postgresql://user:%00seed-secret@localhost/main',
    'postgresql://user:%ZZseed-secret@localhost/main',
    'postgresql://user:%FFseed-secret@localhost/main',
    'postgresql://user@localhost/seed%00secret',
    'postgresql://user@localhost/main?host=reserved.invalid',
    'postgresql://user@localhost/main?%68ost=reserved.invalid',
    'postgresql://user@localhost/main?port=1',
    'postgresql://user@localhost/main?service=seed-secret',
    'postgresql://user@localhost/main?user=seed-secret',
    'postgresql://user@localhost/main?database=seed-secret',
    'postgresql://user@localhost/main?options=-csearch_path%3Dseed_secret',
    'postgresql://user@localhost/main?search_path=seed_secret',
    'postgresql://user@localhost/main?ssl=disable',
    'postgresql://user@localhost/main?sslmode=disable&sslmode=require',
    'postgresql://user@localhost/main?sslrootcert=system&sslrootcert=system',
    'postgresql://user@localhost/main?sslmode=unknown',
    'postgresql://user@localhost/main?sslrootcert=%2Fseed-secret',
    'postgresql://user@localhost/main?application_name=seed%00secret',
  ];
  for (const target of targets) {
    assert.throws(
      () => assertDevelopmentAuthSeedTarget(target, {}),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, authSeedTargetError);
        assert.equal(error.cause, undefined);
        assert.equal('input' in error, false);
        assert.equal(String(error).includes('seed-secret'), false);
        return true;
      },
    );
  }
});

void test('auth seed guard accounts for the driver PGPORT fallback without changing explicit routes', () => {
  for (const port of ['1', '5432', '65535']) {
    assert.doesNotThrow(() => assertDevelopmentAuthSeedTarget('postgresql://user@localhost/main', { PGPORT: port }));
  }
  for (const port of ['0', '65536', '-1', '05432', '5432,5433', 'service', '5432\n']) {
    assert.throws(() => assertDevelopmentAuthSeedTarget('postgresql://user@localhost/main', { PGPORT: port }), {
      message: authSeedTargetError,
    });
  }
  assert.doesNotThrow(() =>
    assertDevelopmentAuthSeedTarget('postgresql://user@localhost:5432/main', {
      PGPORT: 'not-a-port',
      PGHOST: 'reserved.invalid',
      PGDATABASE: 'different_database',
    }),
  );
});

void test('the new auth seed boundary preserves the shared IPv6 classifier while refusing the current driver route', async () => {
  const target = 'postgresql://user@[::1]:5432/main';
  assert.equal(isLocalDatabaseUrl(target), true);
  const client = postgres(target, { max: 1 });
  try {
    // No query: inspect the installed driver parsing without opening a socket.
    assert.deepEqual(client.options.host, ['[']);
    assert.throws(() => assertDevelopmentAuthSeedTarget(target, {}), { message: authSeedTargetError });
  } finally {
    await client.end();
  }
});

void test('the installed driver keeps query host out of routing but forwards query identity and options to startup', async () => {
  const client = postgres(
    'postgresql://user@localhost/main?host=reserved.invalid&user=other&database=other&options=-csearch_path%3Dother',
    { max: 1 },
  );
  try {
    // These assertions do not run SQL. Unknown query fields are connection
    // startup parameters; user/database can override the selected identity.
    assert.deepEqual(client.options.host, ['localhost']);
    assert.equal(client.options.database, 'main');
    assert.equal(client.options.connection.host, 'reserved.invalid');
    assert.equal(client.options.connection.user, 'other');
    assert.equal(client.options.connection.database, 'other');
    assert.equal(client.options.connection.options, '-csearch_path=other');
  } finally {
    await client.end();
  }
});

void test('auth seed guard rejects an encoded multi-host route accepted by the broader hostname classifier', async () => {
  const target = 'postgresql://user@reserved.invalid%2Cbox.localtest.me/main';
  assert.equal(isLocalDatabaseUrl(target), true);
  const client = postgres(target, { max: 1 });
  try {
    assert.deepEqual(client.options.host, ['reserved.invalid', 'box.localtest.me']);
    assert.throws(() => assertDevelopmentAuthSeedTarget(target, {}), { message: authSeedTargetError });
  } finally {
    await client.end();
  }
});

// Real automation paths this must recognize as local, verified against the
// repo (see db-connection.ts's doc comment for the file:line evidence):
//   - Dockerfile.dev-db / setup-development-db.sh: postgresql://postgres@localhost/main
//   - docker-compose service name: postgresql://postgres:password@postgres:5432/main
//   - scripts/dev-db-discover.ts's Tailscale fallback: a MagicDNS *.ts.net name
//     or a 100.64.0.0/10 CGNAT address, used when local Docker isn't reachable.
void test('recognizes every real local/dev-tooling host shape as local', () => {
  assert.equal(isLocalDatabaseUrl('postgresql://postgres@localhost:5432/main'), true);
  assert.equal(isLocalDatabaseUrl('postgresql://postgres@127.0.0.1:5432/main'), true);
  assert.equal(isLocalDatabaseUrl('postgresql://postgres@[::1]:5432/main'), true);
  assert.equal(isLocalDatabaseUrl('postgresql://postgres:password@postgres:5432/main'), true);
  assert.equal(isLocalDatabaseUrl('postgresql://user:pass@foo.localtest.me:5432/db'), true);
  assert.equal(isLocalDatabaseUrl('postgresql://user:pass@localtest.me:5432/db'), true);
  assert.equal(isLocalDatabaseUrl('postgresql://user:pass@my-box.tailnet-name.ts.net:5432/db'), true);
  assert.equal(isLocalDatabaseUrl('postgresql://user:pass@100.64.0.1:5432/db'), true);
  assert.equal(isLocalDatabaseUrl('postgresql://user:pass@100.127.255.255:5432/db'), true);
});

void test('is case-insensitive on hostname', () => {
  assert.equal(isLocalDatabaseUrl('postgresql://postgres@LOCALHOST:5432/main'), true);
  assert.equal(isLocalDatabaseUrl('postgresql://user:pass@MY-BOX.TAILNET.TS.NET:5432/db'), true);
});

void test('refuses a real prod-shaped host (Railway proxy)', () => {
  assert.equal(
    isLocalDatabaseUrl('postgres://boardsesh_readonly:pw@tramway.proxy.rlwy.net:45638/railway?sslmode=require'),
    false,
  );
});

void test('refuses other plausible remote hosts', () => {
  assert.equal(isLocalDatabaseUrl('postgresql://user:pass@my-neon-project.neon.tech:5432/db'), false);
  assert.equal(isLocalDatabaseUrl('postgresql://user:pass@10.0.0.5:5432/db'), false);
  assert.equal(isLocalDatabaseUrl('postgresql://user:pass@192.168.1.20:5432/db'), false);
  assert.equal(isLocalDatabaseUrl('postgresql://user:pass@ts.net.attacker.example:5432/db'), false);
});

void test('rejects addresses just outside the Tailscale CGNAT range', () => {
  assert.equal(isLocalDatabaseUrl('postgresql://user:pass@100.63.255.255:5432/db'), false);
  assert.equal(isLocalDatabaseUrl('postgresql://user:pass@100.128.0.0:5432/db'), false);
});

void test('rejects octets that only look numeric to a loose parser (scientific notation, signs)', () => {
  // `Number('1e2')` is 100 — without a strict digit check, this would parse
  // as 100.100.0.1 and wrongly match the CGNAT range.
  assert.equal(isLocalDatabaseUrl('postgresql://user:pass@100.1e2.0.1:5432/db'), false);
  assert.equal(isLocalDatabaseUrl('postgresql://user:pass@+100.64.0.1:5432/db'), false);
});

void test('recognizes the whole 127.0.0.0/8 loopback block, not just 127.0.0.1', () => {
  // Linux commonly resolves the machine's own hostname to 127.0.1.1.
  assert.equal(isLocalDatabaseUrl('postgresql://user:pass@127.0.1.1:5432/db'), true);
  assert.equal(isLocalDatabaseUrl('postgresql://user:pass@127.0.0.2:5432/db'), true);
  assert.equal(isLocalDatabaseUrl('postgresql://user:pass@127.255.255.255:5432/db'), true);
});

void test('rejects addresses just outside the loopback block', () => {
  assert.equal(isLocalDatabaseUrl('postgresql://user:pass@126.255.255.255:5432/db'), false);
  assert.equal(isLocalDatabaseUrl('postgresql://user:pass@128.0.0.0:5432/db'), false);
});

void test('fails closed on malformed or empty URLs', () => {
  assert.equal(isLocalDatabaseUrl('not a url at all'), false);
  assert.equal(isLocalDatabaseUrl(''), false);
  assert.equal(isLocalDatabaseUrl('postgresql://'), false);
});

void test('forces TLS for remote scripts even when the URL requests plaintext', async () => {
  const plaintextUrl = 'postgresql://user:pass@direct.example:5432/db?sslmode=disable';
  const options = scriptDatabaseConnectionOptions(plaintextUrl);
  const client = postgres(plaintextUrl, options);
  assert.deepEqual(options, {
    max: 1,
    ssl: 'require',
  });
  assert.equal(client.options.ssl, 'require');
  await client.end();
  assert.deepEqual(scriptDatabaseConnectionOptions('postgresql://postgres@localhost:5432/main'), { max: 1 });
});

void test('preserves remote certificate verification instead of downgrading it', async () => {
  const verifiedUrl = 'postgresql://user:pass@direct.example:5432/db?sslmode=verify-full';
  const options = scriptDatabaseConnectionOptions(verifiedUrl);
  const client = postgres(verifiedUrl, options);
  assert.deepEqual(options, { max: 1, ssl: { rejectUnauthorized: true } });
  assert.deepEqual(client.options.ssl, { rejectUnauthorized: true });
  await client.end();
});

void test('preserves the case-sensitive system trust option', async () => {
  const uppercaseRootUrl = 'postgresql://user:pass@direct.example:5432/db?sslmode=disable&sslrootcert=SYSTEM';
  const uppercaseRootClient = postgres(uppercaseRootUrl, scriptDatabaseConnectionOptions(uppercaseRootUrl));
  assert.equal(uppercaseRootClient.options.ssl, 'require');
  await uppercaseRootClient.end();

  const systemRootUrl = 'postgresql://user:pass@direct.example:5432/db?sslmode=disable&sslrootcert=system';
  const systemRootClient = postgres(systemRootUrl, scriptDatabaseConnectionOptions(systemRootUrl));
  assert.deepEqual(systemRootClient.options.ssl, { rejectUnauthorized: true });
  await systemRootClient.end();
});

for (const hostname of ['direct.example', 'localhost']) {
  void test(`enforces explicit verify-full in the actual script driver for ${hostname}`, async () => {
    const url = `postgresql://user:pass@${hostname}:5432/db?sslmode=verify-full`;
    const client = postgres(url, scriptDatabaseConnectionOptions(url));
    try {
      assert.deepEqual(client.options.ssl, { rejectUnauthorized: true });
    } finally {
      await client.end();
    }
  });
}

void test('rejects repeated script TLS modes before constructing a connection', () => {
  for (const hostname of ['direct.example', 'localhost']) {
    assert.throws(
      () =>
        scriptDatabaseConnectionOptions(`postgresql://user:pass@${hostname}/db?sslmode=verify-full&sslmode=disable`),
      /must not repeat sslmode/,
    );
  }
});

void test('describeDatabaseHost reports host:port for a normal connection string', () => {
  assert.equal(describeDatabaseHost('postgresql://postgres:password@localhost:5432/main'), 'localhost:5432');
  assert.equal(
    describeDatabaseHost('postgres://boardsesh_readonly:pw@tramway.proxy.rlwy.net:45638/railway?sslmode=require'),
    'tramway.proxy.rlwy.net:45638',
  );
});

void test('describeDatabaseHost is not confused by "@" or "/" inside the password', () => {
  // A naive `split('@')[1]?.split('/')[0]` would stop at the password's own
  // "@"/"/" and report a garbage or wrong host; new URL() handles encoding.
  assert.equal(
    describeDatabaseHost('postgresql://user:p%40ss%2Fword@realhost.example:5432/db'),
    'realhost.example:5432',
  );
});

void test('describeDatabaseHost fails closed to "unknown" on a malformed URL', () => {
  assert.equal(describeDatabaseHost('not a url at all'), 'unknown');
  assert.equal(describeDatabaseHost(''), 'unknown');
});

// resolveScriptDatabaseUrl is getScriptDatabaseUrl's THROW-instead-of-exit
// twin, for a caller (the MoonBoard catalog importer) that needs to run its
// own cleanup before the process ends. Every case here mirrors one of
// getScriptDatabaseUrl's own conditions, so the two can never silently drift.
void test('resolveScriptDatabaseUrl and its env-var precedence / Vercel guard', async (t) => {
  const savedEnv = {
    DB_URL: process.env.DB_URL,
    DATABASE_URL: process.env.DATABASE_URL,
    POSTGRES_URL: process.env.POSTGRES_URL,
    VERCEL: process.env.VERCEL,
  };
  const clearDbEnv = () => {
    delete process.env.DB_URL;
    delete process.env.DATABASE_URL;
    delete process.env.POSTGRES_URL;
    delete process.env.VERCEL;
  };
  t.after(() => {
    clearDbEnv();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value !== undefined) process.env[key] = value;
    }
  });

  await t.test('throws rather than exiting when no URL env var is set', () => {
    clearDbEnv();
    assert.throws(() => resolveScriptDatabaseUrl(), /DATABASE_URL, POSTGRES_URL, or DB_URL is not set/);
  });

  await t.test('DB_URL wins over DATABASE_URL and POSTGRES_URL', () => {
    clearDbEnv();
    process.env.DB_URL = 'postgresql://user:pass@db-url.example/db';
    process.env.DATABASE_URL = 'postgresql://user:pass@database-url.example/db';
    process.env.POSTGRES_URL = 'postgresql://user:pass@postgres-url.example/db';
    assert.equal(resolveScriptDatabaseUrl(), 'postgresql://user:pass@db-url.example/db');
  });

  await t.test('DATABASE_URL is used when DB_URL is unset', () => {
    clearDbEnv();
    process.env.DATABASE_URL = 'postgresql://user:pass@database-url.example/db';
    assert.equal(resolveScriptDatabaseUrl(), 'postgresql://user:pass@database-url.example/db');
  });

  await t.test('throws when VERCEL is set and the resolved URL is local', () => {
    clearDbEnv();
    process.env.DB_URL = 'postgresql://user:pass@localhost:5432/db';
    process.env.VERCEL = '1';
    assert.throws(() => resolveScriptDatabaseUrl(), /Refusing to run with local DATABASE_URL in Vercel build/);
  });

  await t.test('does not throw when VERCEL is set but the resolved URL is remote', () => {
    clearDbEnv();
    process.env.DB_URL = 'postgresql://user:pass@direct.example:5432/db';
    process.env.VERCEL = '1';
    assert.equal(resolveScriptDatabaseUrl(), 'postgresql://user:pass@direct.example:5432/db');
  });
});
