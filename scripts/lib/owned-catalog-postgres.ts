import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type postgres from 'postgres';

const MAXIMUM_OUTPUT = 1024 * 1024;
const LABEL = 'org.boardsesh.catalog-proof';

export class CatalogCommandFailure extends Error {
  readonly sqlState: string | null;
  constructor(
    readonly exitCode: number | null,
    readonly groupDrained: boolean,
    stderr: string,
  ) {
    super('Owned catalog command failed.');
    this.sqlState = /ERROR:\s+([0-9A-Z]{5})(?:\s|$)/m.exec(stderr)?.[1] ?? null;
  }
}

export function requireCatalog(condition: unknown): asserts condition {
  if (!condition) throw new Error('Owned catalog proof rejected.');
}

const EMPTY_IMAGE_COUNTS = [
  'relations',
  'extraRoles',
  'extraDatabases',
  'extraExtensions',
  'routines',
  'types',
  'namespaces',
  'eventTriggers',
  'defaultPrivileges',
  'policies',
  'foreignServers',
  'foreignWrappers',
  'publications',
  'subscriptions',
  'extraLanguages',
] as const;

export function readEmptyCatalogIdentity(observed: unknown): { systemIdentifier: string; databaseOid: number } {
  requireCatalog(typeof observed === 'object' && observed !== null && !Array.isArray(observed));
  const row = observed as Record<string, unknown>;
  const keys = ['version', 'systemIdentifier', 'databaseOid', 'recovery', ...EMPTY_IMAGE_COUNTS];
  requireCatalog(Object.keys(row).length === keys.length && keys.every((key) => Object.hasOwn(row, key)));
  requireCatalog(row.version === '180006' && row.recovery === false);
  requireCatalog(typeof row.systemIdentifier === 'string' && /^[1-9][0-9]{0,19}$/.test(row.systemIdentifier));
  requireCatalog(typeof row.databaseOid === 'number' && Number.isSafeInteger(row.databaseOid) && row.databaseOid > 0);
  requireCatalog(EMPTY_IMAGE_COUNTS.every((key) => row[key] === 0));
  return { systemIdentifier: row.systemIdentifier, databaseOid: row.databaseOid };
}

export function digest(contents: string | Buffer): string {
  return createHash('sha256').update(contents).digest('hex');
}

export function regularFile(path: string): Buffer {
  const metadata = lstatSync(path);
  requireCatalog(metadata.isFile() && !metadata.isSymbolicLink() && metadata.size <= 32 * 1024 * 1024);
  return readFileSync(path);
}

export function savePrivateJson(path: string, contents: unknown): void {
  const descriptor = openSync(path, 'wx', 0o600);
  try {
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, `${JSON.stringify(contents, null, 2)}\n`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/** Every child has bounded output, its own process group and an observed close. */
export async function runCatalogCommand(
  executable: string,
  arguments_: readonly string[],
  options: {
    cwd?: string;
    input?: string | Buffer;
    signal?: AbortSignal;
    timeoutMs?: number;
    maximumOutputBytes?: number;
  } = {},
): Promise<string> {
  requireCatalog(!options.signal?.aborted);
  const maximumOutput = options.maximumOutputBytes ?? MAXIMUM_OUTPUT;
  requireCatalog(Number.isSafeInteger(maximumOutput) && maximumOutput > 0 && maximumOutput <= 8 * 1024 * 1024);
  const child = spawn(executable, [...arguments_], {
    cwd: options.cwd,
    env: {
      PATH: process.env.PATH,
      LANG: 'C',
      TZ: 'UTC',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    },
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let failed = false;
  let received = 0;
  const output: Buffer[] = [];
  const errors: Buffer[] = [];
  let escalation: ReturnType<typeof setTimeout> | undefined;
  const signalGroup = (signal: NodeJS.Signals) => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      // The actual close event below decides completion, never this signal acknowledgement.
    }
  };
  const stop = () => {
    if (failed) return;
    failed = true;
    signalGroup('SIGTERM');
    escalation = setTimeout(() => signalGroup('SIGKILL'), 2000);
  };
  const capture = (chunk: Buffer, stdout: boolean) => {
    received += chunk.length;
    if (received > maximumOutput) return stop();
    if (stdout) output.push(chunk);
    else errors.push(chunk);
  };
  child.stdout.on('data', (chunk: Buffer) => capture(chunk, true));
  child.stderr.on('data', (chunk: Buffer) => capture(chunk, false));
  child.stdin.on('error', stop);
  child.once('error', stop);
  options.signal?.addEventListener('abort', stop);
  const timeout = setTimeout(stop, options.timeoutMs ?? 60_000);
  if (options.signal?.aborted) stop();
  child.stdin.end(options.input);
  const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((settle) => {
    child.once('close', (code, signal) => settle({ code, signal }));
  });
  clearTimeout(timeout);
  // A closed leader alone does not establish that its detached process group drained.
  const groupAlive = () => {
    if (!child.pid) return false;
    const processes = execFileSync('ps', ['-eo', 'pgid=,stat='], {
      env: { PATH: process.env.PATH, LANG: 'C' },
      encoding: 'utf8',
      timeout: 1000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return processes.split('\n').some((line) => {
      const [group, state] = line.trim().split(/\s+/);
      return Number(group) === child.pid && !state?.startsWith('Z');
    });
  };
  let drained = false;
  try {
    if (groupAlive()) {
      stop();
      const drainDeadline = performance.now() + 4000;
      while (groupAlive() && performance.now() < drainDeadline) await new Promise((settle) => setTimeout(settle, 50));
    }
    drained = !groupAlive();
  } finally {
    if (!drained) signalGroup('SIGKILL');
    clearTimeout(escalation);
    options.signal?.removeEventListener('abort', stop);
  }
  if (!drained || failed || outcome.code !== 0 || outcome.signal !== null)
    throw new CatalogCommandFailure(outcome.code, drained, Buffer.concat(errors).toString());
  return Buffer.concat(output).toString('utf8').trim();
}

export interface SourceSnapshot {
  root: string;
  head: string;
  files: Record<string, string>;
  sha256: string;
}

export async function requireCatalogSourceHead(source: SourceSnapshot): Promise<void> {
  requireCatalog(
    (await runCatalogCommand('git', ['--no-optional-locks', 'rev-parse', 'HEAD'], { cwd: source.root })) ===
      source.head,
  );
  requireCatalog(
    (await runCatalogCommand('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', 'status', '--porcelain'], {
      cwd: source.root,
    })) === '',
  );
  await requireOrdinaryGitIndex(source.root);
}

async function requireOrdinaryGitIndex(root: string): Promise<void> {
  const records = await runCatalogCommand('git', ['ls-files', '-v', '-z'], {
    cwd: root,
    maximumOutputBytes: 8 * 1024 * 1024,
  });
  requireCatalog(
    records
      .split('\0')
      .filter(Boolean)
      .every((entry) => entry.startsWith('H ')),
  );
}

export async function snapshotCatalogSource(rootInput: string, expectedHead: string): Promise<SourceSnapshot> {
  const root = realpathSync(rootInput);
  requireCatalog(/^[a-f0-9]{40}$/.test(expectedHead));
  const head = await runCatalogCommand('git', ['--no-optional-locks', 'rev-parse', 'HEAD'], { cwd: root });
  requireCatalog(head === expectedHead);
  requireCatalog(
    (await runCatalogCommand('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', 'status', '--porcelain'], {
      cwd: root,
    })) === '',
  );
  await requireOrdinaryGitIndex(root);
  const tracked = await runCatalogCommand('git', ['ls-tree', '-r', '-z', '--full-tree', expectedHead], {
    cwd: root,
    maximumOutputBytes: 8 * 1024 * 1024,
  });
  const files: Record<string, string> = {};
  for (const entry of tracked.split('\0').filter(Boolean).sort()) {
    const separator = entry.indexOf('\t');
    requireCatalog(separator > 0);
    const [mode, kind, blob] = entry.slice(0, separator).split(' ');
    const name = entry.slice(separator + 1);
    // Native fixtures are outside this Node proof.
    if (name.startsWith('embedded/')) continue;
    if (!/\.(?:[cm]?[jt]sx?|json|sql|sh|ya?ml|toml|patch)$/.test(name) && name !== 'pnpm-lock.yaml') continue;
    // Private environment files are never read.
    if (name.split('/').some((part) => /^\.env(?:\.|$)/.test(part))) continue;
    const path = join(root, name);
    requireCatalog(realpathSync(path) === path);
    requireCatalog(kind === 'blob' && ['100644', '100755'].includes(mode) && /^[a-f0-9]{40}$/.test(blob));
    const contents = regularFile(path);
    const gitBlob = createHash('sha1').update(`blob ${contents.length}\0`).update(contents).digest('hex');
    requireCatalog(gitBlob === blob && ((lstatSync(path).mode & 0o111) !== 0) === (mode === '100755'));
    files[path] = digest(contents);
  }
  requireCatalog(Object.keys(files).length > 0);
  return { root, head, files, sha256: digest(JSON.stringify(files)) };
}

/** Abort cannot leave a pending callback holding the proof open or publish a late success. */
export async function waitForCatalogWork<Result>(
  work: () => Promise<Result>,
  signal: AbortSignal,
  abortCleanup: () => Promise<unknown>,
  onSettled: () => void,
  settlementMs = 1000,
): Promise<Result> {
  requireCatalog(Number.isSafeInteger(settlementMs) && settlementMs > 0 && settlementMs <= 1000);
  let finishAbort: (() => void) | undefined;
  let cleanup: Promise<unknown> | undefined;
  const aborted = new Promise<null>((settle) => {
    finishAbort = () => settle(null);
  });
  const abort = () => {
    // Attach rejection handling immediately: cleanup is also awaited below.
    cleanup ??= Promise.resolve()
      .then(abortCleanup)
      .then(
        () => undefined,
        () => undefined,
      );
    finishAbort?.();
  };
  signal.addEventListener('abort', abort);
  if (signal.aborted) abort();
  const operation = Promise.resolve()
    .then(async () => {
      requireCatalog(!signal.aborted);
      return await work();
    })
    .then(
      (result) => {
        onSettled();
        return { ok: true as const, result };
      },
      (error: unknown) => {
        onSettled();
        return { ok: false as const, error };
      },
    );
  try {
    const outcome = await Promise.race([operation, aborted]);
    if (outcome === null || signal.aborted) {
      abort();
      await cleanup;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        // A callback that ignores a closed client may remain pending. It can
        // only produce incomplete evidence after owned resource cleanup.
        await Promise.race([
          operation,
          new Promise<null>((settle) => {
            deadline = setTimeout(() => settle(null), settlementMs);
          }),
        ]);
      } finally {
        clearTimeout(deadline);
      }
      throw new Error('Owned catalog operation aborted.');
    }
    if (!outcome.ok) throw outcome.error;
    return outcome.result;
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

export interface OwnedCatalogIdentity {
  nonce: string;
  container: string;
  volume: string;
  socketDirectory: string;
  database: string;
  image: string;
  systemIdentifier: string;
  databaseOid: number;
}

export class OwnedCatalogPostgres {
  readonly nonce = randomUUID().replaceAll('-', '');
  readonly directory = mkdtempSync(join(tmpdir(), 'boardsesh-catalog-'));
  readonly socketDirectory = join(this.directory, 'socket');
  readonly volume = `boardsesh-catalog-${this.nonce}`;
  readonly name = `boardsesh-catalog-${this.nonce}`;
  readonly database = `boardsesh_catalog_${this.nonce}`;
  private container: string | undefined;
  private identity: OwnedCatalogIdentity | undefined;
  private stopped = false;
  private connectionClosed = false;
  private operationSettled = false;
  private stopPromise: Promise<void> | undefined;
  private readonly socketInode: number;
  private readonly socketDevice: number;
  private socketAfterInitialization: { uid: number; gid: number; mode: number } | undefined;
  private socketFileIdentity: { ino: number; dev: number; uid: number } | undefined;

  constructor(
    private readonly signal: AbortSignal,
    private readonly sourceRoot: string,
    readonly image: string,
  ) {
    requireCatalog(/^sha256:[a-f0-9]{64}$/.test(image));
    chmodSync(this.directory, 0o700);
    mkdirSync(this.socketDirectory, { mode: 0o777 });
    chmodSync(this.socketDirectory, 0o777);
    const socket = lstatSync(this.socketDirectory);
    this.socketInode = socket.ino;
    this.socketDevice = socket.dev;
    mkdirSync(join(this.directory, 'docker-config'), { mode: 0o700 });
    savePrivateJson(join(this.directory, 'claim.json'), {
      nonce: this.nonce,
      volume: this.volume,
      containerName: this.name,
      createdAt: new Date().toISOString(),
    });
  }

  resourceEvidence(): Record<string, unknown> {
    return {
      nonce: this.nonce,
      container: this.container ?? null,
      volume: this.volume,
      directory: this.directory,
      database: this.database,
      image: this.image,
      physical: this.identity ?? null,
      containerStopped: this.stopped,
      connectionClosed: this.connectionClosed,
      operationSettled: this.operationSettled,
      resourcesRetained: true,
    };
  }

  private docker(arguments_: readonly string[], options: { input?: string; cleanup?: boolean } = {}): Promise<string> {
    return runCatalogCommand(
      'docker',
      ['--config', join(this.directory, 'docker-config'), '--host', 'unix:///var/run/docker.sock', ...arguments_],
      {
        input: options.input,
        signal: options.cleanup ? undefined : this.signal,
      },
    );
  }

  private async requireOwnership(): Promise<void> {
    requireCatalog(this.container);
    const inspected = JSON.parse(
      await this.docker(['container', 'inspect', this.container, '--format', '{{json .}}'], { cleanup: true }),
    ) as {
      Id: string;
      Image: string;
      Config: { Labels: Record<string, string> };
      HostConfig: { NetworkMode: string; PortBindings: unknown };
      Mounts: { Type: string; Name?: string; Source: string; Destination: string }[];
    };
    requireCatalog(
      inspected.Id === this.container &&
        inspected.Image === this.image &&
        inspected.Config.Labels[LABEL] === this.nonce,
    );
    requireCatalog(
      inspected.HostConfig.NetworkMode === 'none' && Object.keys(inspected.HostConfig.PortBindings ?? {}).length === 0,
    );
    requireCatalog(
      inspected.Mounts.length === 2 &&
        inspected.Mounts.some(
          (mount) =>
            mount.Type === 'volume' && mount.Name === this.volume && mount.Destination === '/var/lib/postgresql',
        ),
    );
    requireCatalog(
      inspected.Mounts.some(
        (mount) =>
          mount.Type === 'bind' && mount.Source === this.socketDirectory && mount.Destination === '/var/run/postgresql',
      ),
    );
    const volume = JSON.parse(
      await this.docker(['volume', 'inspect', this.volume, '--format', '{{json .}}'], { cleanup: true }),
    ) as { Name: string; Labels: Record<string, string> };
    requireCatalog(volume.Name === this.volume && volume.Labels[LABEL] === this.nonce);
    const parent = lstatSync(this.directory),
      socket = lstatSync(this.socketDirectory);
    requireCatalog(
      parent.isDirectory() &&
        !parent.isSymbolicLink() &&
        parent.uid === process.getuid?.() &&
        (parent.mode & 0o777) === 0o700,
    );
    requireCatalog(
      socket.isDirectory() &&
        !socket.isSymbolicLink() &&
        socket.ino === this.socketInode &&
        socket.dev === this.socketDevice,
    );
    // The official entrypoint may chown/chmod its new socket directory. The host
    // parent stays private; after initialization the observed directory is pinned.
    if (this.socketAfterInitialization)
      requireCatalog(
        socket.uid === this.socketAfterInitialization.uid &&
          socket.gid === this.socketAfterInitialization.gid &&
          socket.mode === this.socketAfterInitialization.mode,
      );
    else requireCatalog((socket.mode & 0o001) !== 0);
    if (this.socketFileIdentity) {
      const endpoint = lstatSync(join(this.socketDirectory, '.s.PGSQL.5432'));
      requireCatalog(
        endpoint.isSocket() &&
          !endpoint.isSymbolicLink() &&
          endpoint.ino === this.socketFileIdentity.ino &&
          endpoint.dev === this.socketFileIdentity.dev &&
          endpoint.uid === this.socketFileIdentity.uid,
      );
    }
  }

  async start(): Promise<OwnedCatalogIdentity> {
    const image = JSON.parse(await this.docker(['image', 'inspect', this.image, '--format', '{{json .}}'])) as {
      Id: string;
      Architecture: string;
      Os: string;
    };
    requireCatalog(image.Id === this.image && ['amd64', 'arm64'].includes(image.Architecture) && image.Os === 'linux');
    requireCatalog(
      (await this.docker(['volume', 'ls', '--filter', `name=^${this.volume}$`, '--format', '{{.Name}}'])) === '',
    );
    requireCatalog(
      (await this.docker(['container', 'ls', '-a', '--filter', `name=^/${this.name}$`, '--format', '{{.ID}}'])) === '',
    );
    requireCatalog(
      (await this.docker(['volume', 'create', '--label', `${LABEL}=${this.nonce}`, this.volume])) === this.volume,
    );
    requireCatalog(
      (await this.docker(['container', 'ls', '-a', '--filter', `volume=${this.volume}`, '--format', '{{.ID}}'])) === '',
    );
    this.container = await this.docker([
      'create',
      '--name',
      this.name,
      '--label',
      `${LABEL}=${this.nonce}`,
      '--pull',
      'never',
      '--network',
      'none',
      '--memory',
      '2g',
      '--memory-swap',
      '2g',
      '--cpus',
      '2',
      '--pids-limit',
      '256',
      '--mount',
      `type=volume,source=${this.volume},target=/var/lib/postgresql`,
      '--mount',
      `type=bind,source=${this.socketDirectory},target=/var/run/postgresql`,
      '--env',
      'POSTGRES_HOST_AUTH_METHOD=trust',
      '--env',
      'POSTGRES_USER=postgres',
      '--env',
      `POSTGRES_DB=${this.database}`,
      this.image,
      'postgres',
      '-c',
      'listen_addresses=',
      '-c',
      'unix_socket_directories=/var/run/postgresql',
      '-c',
      'unix_socket_permissions=0777',
      '-c',
      'max_connections=20',
      '-c',
      'statement_timeout=30000',
      '-c',
      'lock_timeout=5000',
    ]);
    requireCatalog(/^[a-f0-9]{64}$/.test(this.container));
    await this.requireOwnership();
    savePrivateJson(join(this.directory, 'container.json'), this.resourceEvidence());
    await this.docker(['start', this.container]);
    const deadline = performance.now() + 120_000;
    while (performance.now() < deadline) {
      let observed: unknown;
      try {
        requireCatalog((await this.docker(['exec', this.container, 'cat', '/proc/1/comm'])) === 'postgres');
        observed = JSON.parse(
          await this.psql(`BEGIN READ ONLY; SELECT json_build_object(
          'version',current_setting('server_version_num'),'systemIdentifier',(SELECT system_identifier::text FROM pg_control_system()),
          'databaseOid',(SELECT oid::int FROM pg_database WHERE datname=current_database()),'recovery',pg_is_in_recovery(),
          'relations',(SELECT count(*)::int FROM pg_class AS relation JOIN pg_namespace AS namespace ON namespace.oid=relation.relnamespace WHERE namespace.nspname !~ '^pg_' AND namespace.nspname <> 'information_schema' AND relation.relkind IN ('r','p','v','m','S','f')),
          'extraRoles',(SELECT count(*)::int FROM pg_roles WHERE rolname !~ '^pg_' AND rolname <> 'postgres'),
          'extraDatabases',(SELECT count(*)::int FROM pg_database WHERE datname NOT IN ('template0','template1','postgres',current_database())),
          'extraExtensions',(SELECT count(*)::int FROM pg_extension WHERE extname <> 'plpgsql'),
          'routines',(SELECT count(*)::int FROM pg_proc AS routine JOIN pg_namespace AS namespace ON namespace.oid=routine.pronamespace WHERE namespace.nspname !~ '^pg_' AND namespace.nspname <> 'information_schema'),
          'types',(SELECT count(*)::int FROM pg_type AS type JOIN pg_namespace AS namespace ON namespace.oid=type.typnamespace WHERE namespace.nspname !~ '^pg_' AND namespace.nspname <> 'information_schema'),
          'namespaces',(SELECT count(*)::int FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname NOT IN ('public','information_schema')),
          'eventTriggers',(SELECT count(*)::int FROM pg_event_trigger),
          'defaultPrivileges',(SELECT count(*)::int FROM pg_default_acl),
          'policies',(SELECT count(*)::int FROM pg_policy),
          'foreignServers',(SELECT count(*)::int FROM pg_foreign_server),
          'foreignWrappers',(SELECT count(*)::int FROM pg_foreign_data_wrapper),
          'publications',(SELECT count(*)::int FROM pg_publication),
          'subscriptions',(SELECT count(*)::int FROM pg_subscription),
          'extraLanguages',(SELECT count(*)::int FROM pg_language WHERE lanname NOT IN ('internal','c','sql','plpgsql'))); ROLLBACK;`),
        );
      } catch {
        requireCatalog(!this.signal.aborted);
        await new Promise((settle) => setTimeout(settle, 250));
        continue;
      }
      // A seeded or unexpected image is rejected before any fixture DDL, never reset.
      const physical = readEmptyCatalogIdentity(observed);
      this.identity = {
        nonce: this.nonce,
        container: this.container,
        volume: this.volume,
        socketDirectory: this.socketDirectory,
        database: this.database,
        image: this.image,
        systemIdentifier: physical.systemIdentifier,
        databaseOid: physical.databaseOid,
      };
      const socket = lstatSync(this.socketDirectory),
        endpoint = lstatSync(join(this.socketDirectory, '.s.PGSQL.5432'));
      requireCatalog(endpoint.isSocket() && !endpoint.isSymbolicLink());
      this.socketAfterInitialization = { uid: socket.uid, gid: socket.gid, mode: socket.mode };
      this.socketFileIdentity = { ino: endpoint.ino, dev: endpoint.dev, uid: endpoint.uid };
      await this.requireOwnership();
      savePrivateJson(join(this.directory, 'ready.json'), this.identity);
      return this.identity;
    }
    throw new Error('Owned PostgreSQL readiness failed.');
  }

  async psql(sql: string, transaction = false): Promise<string> {
    requireCatalog(this.container);
    return this.docker(
      [
        'exec',
        '-i',
        this.container,
        'psql',
        '-X',
        '-q',
        '-A',
        '-t',
        '--host=/var/run/postgresql',
        '--port=5432',
        '--username=postgres',
        `--dbname=${this.database}`,
        '--set=ON_ERROR_STOP=1',
        '--set=VERBOSITY=sqlstate',
        ...(transaction ? ['--single-transaction'] : []),
        '--file=-',
      ],
      { input: sql },
    );
  }

  async withClient<Result>(operation: (client: postgres.Sql) => Promise<Result>): Promise<Result> {
    requireCatalog(this.identity && !this.signal.aborted);
    const identity = this.identity;
    await this.requireOwnership();
    requireCatalog(!this.signal.aborted);
    let closes = 0;
    const createClient = createRequire(join(this.sourceRoot, 'packages/db/package.json'))(
      'postgres',
    ) as typeof postgres;
    const options = {
      host: this.socketDirectory,
      port: 5432,
      database: this.database,
      username: 'postgres',
      password: () => '',
      ssl: false,
      max: 1,
      connect_timeout: 3,
      idle_timeout: 0,
      max_lifetime: 120,
      debug: false,
      fetch_types: false,
      target_session_attrs: 'primary',
      keep_alive: 30,
      backoff: () => 0.1,
      publications: 'alltables',
      onnotice: () => {},
      onclose: () => {
        closes += 1;
      },
      connection: { application_name: 'boardsesh_owned_catalog', statement_timeout: 30000, lock_timeout: 5000 },
      sslnegotiation: null,
      max_pipeline: 1,
    } satisfies postgres.Options<{}> & { sslnegotiation: null; max_pipeline: 1 };
    const client = createClient(options);
    let shutdownPromise: Promise<void> | undefined;
    const shutdown = () => {
      shutdownPromise ??= (async () => {
        // This sample belongs to the FIRST shutdown, including one caused by
        // abort. Finally reuses its result instead of demanding a second close.
        const previous = closes,
          deadline = performance.now() + 5000;
        await client.end({ timeout: 1 });
        while (closes === previous && performance.now() < deadline)
          await new Promise((settle) => setTimeout(settle, 10));
        requireCatalog(closes > previous);
        this.connectionClosed = true;
      })();
      return shutdownPromise;
    };
    try {
      return await waitForCatalogWork(
        async () => {
          requireCatalog(
            client.options.host[0] === this.socketDirectory &&
              client.options.port[0] === 5432 &&
              client.options.database === this.database &&
              client.options.path === join(this.socketDirectory, '.s.PGSQL.5432'),
          );
          const [physical] = await client<
            { system: string; oid: number; address: null; recovery: boolean }[]
          >`SELECT (SELECT system_identifier::text FROM pg_control_system()) AS system,(SELECT oid::int FROM pg_database WHERE datname=current_database()) AS oid,inet_client_addr() AS address,pg_is_in_recovery() AS recovery`;
          requireCatalog(
            physical?.system === identity.systemIdentifier &&
              physical.oid === identity.databaseOid &&
              physical.address === null &&
              physical.recovery === false,
          );
          return await operation(client);
        },
        this.signal,
        () => Promise.allSettled([shutdown(), this.stop()]),
        () => {
          this.operationSettled = true;
        },
      );
    } finally {
      await shutdown();
      if (!this.signal.aborted) await this.requireOwnership();
      requireCatalog(!this.signal.aborted);
    }
  }

  async stop(): Promise<void> {
    if (!this.container || this.stopped) return;
    this.stopPromise ??= (async () => {
      await this.requireOwnership();
      requireCatalog(this.container);
      await this.docker(['stop', '--time', '10', this.container], { cleanup: true });
      const state = JSON.parse(
        await this.docker(['container', 'inspect', this.container, '--format', '{{json .State}}'], { cleanup: true }),
      ) as { Running: boolean; OOMKilled: boolean };
      requireCatalog(state.Running === false && state.OOMKilled === false);
      this.stopped = true;
    })();
    await this.stopPromise;
  }
}
