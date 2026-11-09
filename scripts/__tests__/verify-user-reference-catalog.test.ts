import { describe, it } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cutoffBootstrapSql, parseCatalogOptions, requireCatalogInvocation } from '../verify-user-reference-catalog';
import {
  CatalogCommandFailure,
  digest,
  runCatalogCommand,
  readEmptyCatalogIdentity,
  snapshotCatalogSource,
  waitForCatalogWork,
} from '../lib/owned-catalog-postgres';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const head = 'a'.repeat(40);
const image = `sha256:${'b'.repeat(64)}`;
const validArguments = [
  '--run',
  '--source-root',
  root,
  '--source-head',
  head,
  '--harness-head',
  head,
  '--image',
  image,
  '--out',
  '/tmp/catalog-proof-test-output.json',
];

describe('owned user-reference proof input and source boundary', () => {
  it('runs the actual native CLI plan without a service child, driver or socket', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'catalog-native-plan-'));
    const preload = join(directory, 'plan-io-guard.mjs');
    writeFileSync(
      preload,
      `
      import childProcess from 'node:child_process';
      import {registerHooks,createRequire,syncBuiltinESMExports} from 'node:module';
      import {Socket} from 'node:net';
      import {realpathSync} from 'node:fs';
      import {tmpdir,userInfo} from 'node:os';
      import {join} from 'node:path';
      const rootRequire=createRequire(${JSON.stringify(join(root, 'package.json'))});
      const tsxRequire=createRequire(rootRequire.resolve('tsx'));
      const esbuildRequire=createRequire(tsxRequire.resolve('esbuild'));
      const compiler=realpathSync(esbuildRequire.resolve('@esbuild/'+process.platform+'-'+process.arch+'/bin/esbuild'));
      for (const method of ['spawn','spawnSync','execFile','execFileSync']) {
        const original=childProcess[method];
        childProcess[method]=function(command,...args) {
          if (typeof command!=='string' || realpathSync(command)!==compiler) throw new Error('PLAN_SERVICE_CHILD_FORBIDDEN');
          return Reflect.apply(original,this,[command,...args]);
        };
      }
      for (const method of ['exec','execSync','fork']) childProcess[method]=()=>{throw new Error('PLAN_SERVICE_CHILD_FORBIDDEN');};
      syncBuiltinESMExports();
      const parentPipe=join(tmpdir(),'tsx-'+(process.geteuid?process.geteuid():userInfo().username),process.ppid+'.pipe');
      const originalConnect=Socket.prototype.connect;
      Socket.prototype.connect=function(...args) {
        const first=Array.isArray(args[0])?args[0][0]:args[0];
        const path=typeof first==='string'?first:first?.path;
        if(path!==parentPipe || (typeof first!=='string' && (first.host!==undefined || first.port!==undefined))) throw new Error('PLAN_SERVICE_SOCKET_FORBIDDEN');
        return Reflect.apply(originalConnect,this,args);
      };
      registerHooks({resolve(specifier,context,nextResolve) {
        if(['postgres','pg','ioredis'].includes(specifier)) throw new Error('PLAN_SERVICE_DRIVER_FORBIDDEN');
        return nextResolve(specifier,context);
      }});
    `,
      { flag: 'wx', mode: 0o600 },
    );
    const output = await runCatalogCommand(
      process.execPath,
      [
        '--import',
        pathToFileURL(preload).href,
        '--import',
        'tsx',
        join(root, 'scripts/verify-user-reference-catalog.ts'),
        '--plan',
      ],
      { cwd: root, timeoutMs: 5000 },
    );
    const plan = JSON.parse(output) as Record<string, unknown>;
    assert.equal(plan.action, 'plan');
    assert.equal(plan.existingDatabaseOrCredentialsAccepted, false);
  });

  it('rejects unbound loader flags, environment names, CWD and ancestor configuration', () => {
    requireCatalogInvocation(root, ['PATH', 'LANG'], ['--import', 'tsx'], root);
    for (const name of [
      'TSX_TSCONFIG_PATH',
      'ESBUILD_BINARY_PATH',
      'NODE_OPTIONS',
      'NODE_PATH',
      'PGHOST',
      'DATABASE_URL',
    ])
      assert.throws(() => requireCatalogInvocation(root, ['PATH', name], ['--import', 'tsx'], root), /rejected/);
    // Proxy variables are normal in remote sessions; the Node side makes no proxied calls.
    requireCatalogInvocation(root, ['PATH', 'HTTPS_PROXY', 'NO_PROXY'], ['--import', 'tsx'], root);
    assert.throws(() => requireCatalogInvocation(root, ['PATH'], ['--import', 'unbound-loader'], root), /rejected/);
    const parent = mkdtempSync(join(tmpdir(), 'catalog-loader-config-'));
    const child = join(parent, 'source');
    mkdirSync(child);
    writeFileSync(join(parent, 'tsconfig.json'), '{"compilerOptions":{"allowJs":true}}', { flag: 'wx', mode: 0o600 });
    assert.throws(() => requireCatalogInvocation(root, ['PATH'], ['--import', 'tsx'], child), /rejected/);
    assert.throws(() => requireCatalogInvocation(child, ['PATH'], ['--import', 'tsx'], child), /rejected/);
  });

  it('rejects every nonempty image surface and strictly decodes the fresh physical identity', () => {
    const empty = {
      version: '180006',
      systemIdentifier: '12345',
      databaseOid: 16384,
      recovery: false,
      relations: 0,
      extraRoles: 0,
      extraDatabases: 0,
      extraExtensions: 0,
      routines: 0,
      types: 0,
      namespaces: 0,
      eventTriggers: 0,
      defaultPrivileges: 0,
      policies: 0,
      foreignServers: 0,
      foreignWrappers: 0,
      publications: 0,
      subscriptions: 0,
      extraLanguages: 0,
    };
    assert.deepEqual(readEmptyCatalogIdentity(empty), { systemIdentifier: '12345', databaseOid: 16384 });
    for (const key of [
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
    ]) {
      assert.throws(() => readEmptyCatalogIdentity({ ...empty, [key]: 1 }), /rejected/);
      assert.throws(() => readEmptyCatalogIdentity({ ...empty, [key]: '0' }), /rejected/);
    }
    for (const invalid of [
      { ...empty, recovery: undefined },
      { ...empty, recovery: 0 },
      { ...empty, databaseOid: '16384' },
      { ...empty, systemIdentifier: 12345 },
      { ...empty, unexpected: 0 },
    ])
      assert.throws(() => readEmptyCatalogIdentity(invalid), /rejected/);
  });

  it('requires an explicit immutable local image and both source identities before execution', () => {
    assert.equal(parseCatalogOptions([]), null);
    assert.equal(parseCatalogOptions(['--plan']), null);
    assert.deepEqual(parseCatalogOptions(validArguments), {
      sourceRoot: root,
      sourceHead: head,
      harnessHead: head,
      image,
      output: '/tmp/catalog-proof-test-output.json',
    });
    for (const rejected of [
      validArguments.filter((_, index) => index !== 7 && index !== 8),
      validArguments.map((argument) => (argument === image ? 'postgres:18' : argument)),
      [...validArguments, '--database-url', 'postgresql://synthetic.invalid/never-contacted'],
      validArguments.map((argument) => (argument === '--source-head' ? '--harness-head' : argument)),
    ])
      assert.throws(() => parseCatalogOptions(rejected), /rejected/);
  });

  it('accepts only one task forwarding separator immediately after --run', () => {
    const forwardedArguments = ['--run', '--', ...validArguments.slice(1)];
    assert.deepEqual(parseCatalogOptions(forwardedArguments), parseCatalogOptions(validArguments));
    for (const rejected of [
      ['--run', '--', '--', ...validArguments.slice(1)],
      ['--', ...validArguments],
      [...validArguments.slice(0, 3), '--', ...validArguments.slice(3)],
      [...validArguments, '--'],
      validArguments.map((argument, index) => (index === 2 ? '--' : argument)),
      forwardedArguments.map((argument, index) => (index === 3 ? '--' : argument)),
      ['--plan', '--'],
    ])
      assert.throws(() => parseCatalogOptions(rejected), /rejected/);
  });

  it('copies the actual helper body and rejects changed bootstrap literal contracts', () => {
    const sql = cutoffBootstrapSql(root);
    const originalFunction = readFileSync(join(root, 'packages/db/scripts/sync-deletions-cutoff-function.sql'), 'utf8');
    assert.ok(sql.includes(originalFunction));
    assert.ok(sql.includes('WITH ADMIN FALSE, INHERIT TRUE, SET FALSE'));
    const synthetic = mkdtempSync(join(tmpdir(), 'catalog-cutoff-source-'));
    const scripts = join(synthetic, 'packages/db/scripts');
    mkdirSync(scripts, { recursive: true });
    for (const name of [
      'bootstrap-sync-deletions-cutoff-development.ts',
      'bootstrap-sync-deletions-cutoff.ts',
      'sync-deletions-cutoff-function.sql',
      'sync-deletions-cutoff-contract.sql',
    ]) {
      writeFileSync(join(scripts, name), readFileSync(join(root, 'packages/db/scripts', name)), {
        flag: 'wx',
        mode: 0o600,
      });
    }
    const bootstrap = join(scripts, 'bootstrap-sync-deletions-cutoff.ts');
    writeFileSync(
      bootstrap,
      readFileSync(bootstrap, 'utf8').replace(
        "const OWNER_ROLE = 'boardsesh_sync_cutoff_owner';",
        "const OWNER_ROLE = 'different_owner';",
      ),
    );
    assert.throws(() => cutoffBootstrapSql(synthetic), /rejected/);
  });

  it('excludes a tracked dangling native alias while binding Node files and rejecting other aliases', async () => {
    // macOS's tmpdir is a symlink; the snapshot reports real paths.
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'catalog-native-scope-')));
    const git = (arguments_: string[]) => runCatalogCommand('git', arguments_, { cwd: directory });
    const commit = async () => {
      await git(['add', '.']);
      await git([
        '-c',
        'user.name=CatalogProof',
        '-c',
        'user.email=catalog@example.invalid',
        '-c',
        'core.hooksPath=/dev/null',
        'commit',
        '--quiet',
        '-m',
        'fixture',
      ]);
      return git(['rev-parse', 'HEAD']);
    };
    await git(['init', '--quiet']);
    const inputPath = join(directory, 'input.ts');
    const contents = 'export const identity = 1;\n';
    writeFileSync(inputPath, contents, { flag: 'wx', mode: 0o600 });
    const nativeDirectory = join(directory, 'embedded/test/lib/climb-history');
    mkdirSync(nativeDirectory, { recursive: true });
    symlinkSync('missing-native-library.json', join(nativeDirectory, 'library.json'));
    const admitted = await snapshotCatalogSource(directory, await commit());
    assert.deepEqual(admitted.files, { [inputPath]: digest(contents) });
    symlinkSync('missing-node-library.json', join(directory, 'library.json'));
    await assert.rejects(snapshotCatalogSource(directory, await commit()));
  });

  it('rejects changed assume-unchanged input despite an actually clean Git status', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'catalog-git-binding-'));
    const git = (arguments_: string[]) => runCatalogCommand('git', arguments_, { cwd: directory });
    await git(['init', '--quiet']);
    const path = join(directory, 'input.ts');
    writeFileSync(path, 'export const identity = 1;\n', { flag: 'wx', mode: 0o600 });
    await git(['add', 'input.ts']);
    await git([
      '-c',
      'user.name=CatalogProof',
      '-c',
      'user.email=catalog@example.invalid',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '--quiet',
      '-m',
      'fixture',
    ]);
    const commit = await git(['rev-parse', 'HEAD']);
    const admitted = await snapshotCatalogSource(directory, commit);
    assert.equal(admitted.head, commit);
    await git(['update-index', '--assume-unchanged', 'input.ts']);
    writeFileSync(path, 'export const identity = 2;\n');
    assert.equal(await git(['status', '--porcelain']), '');
    await assert.rejects(snapshotCatalogSource(directory, commit), /rejected/);
  });
});

describe('real bounded proof child lifecycle', () => {
  it('observes an actual successful child close with bounded output', async () => {
    assert.equal(await runCatalogCommand(process.execPath, ['-e', 'process.stdout.write("closed")']), 'closed');
  });

  it('terminates and drains an actual child on its deadline', async () => {
    await assert.rejects(
      runCatalogCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 200 }),
      (error: unknown) => error instanceof CatalogCommandFailure && error.groupDrained,
    );
  });

  it('does not treat a closed leader with a live descendant as successful cleanup', async () => {
    const program =
      'const {spawn}=require("node:child_process");const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});child.unref();';
    await assert.rejects(
      runCatalogCommand(process.execPath, ['-e', program]),
      (error: unknown) => error instanceof CatalogCommandFailure && error.exitCode === 0 && error.groupDrained,
    );
  });

  it('rejects output overflow and pre-aborted work', async () => {
    await assert.rejects(
      runCatalogCommand(process.execPath, [
        '-e',
        'process.stdout.write("x".repeat(2*1024*1024));setInterval(()=>{},1000)',
      ]),
      (error: unknown) => error instanceof CatalogCommandFailure && error.groupDrained,
    );
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(runCatalogCommand('nonexistent-proof-command', [], { signal: controller.signal }), /rejected/);
  });
});

describe('whole asynchronous catalog operation abort', () => {
  it('returns only incomplete after cleanup when a callback never settles', async () => {
    const controller = new AbortController();
    let entered!: () => void;
    const started = new Promise<void>((settle) => {
      entered = settle;
    });
    let cleanupFinished = false,
      operationSettled = false;
    const result = waitForCatalogWork(
      async () => {
        entered();
        return await new Promise<never>(() => {});
      },
      controller.signal,
      async () => {
        await new Promise((settle) => setTimeout(settle, 10));
        cleanupFinished = true;
      },
      () => {
        operationSettled = true;
      },
      5,
    );
    const rejected = assert.rejects(result, /aborted/);
    await started;
    controller.abort();
    await rejected;
    assert.equal(cleanupFinished, true);
    assert.equal(operationSettled, false);
  });

  it('observes actual operation settlement caused by owned cleanup without repeating cleanup', async () => {
    const controller = new AbortController();
    let entered!: () => void, rejectWork!: (error: Error) => void;
    const started = new Promise<void>((settle) => {
      entered = settle;
    });
    let cleanupCount = 0,
      operationSettled = false;
    const result = waitForCatalogWork(
      async () => {
        entered();
        return await new Promise<never>((_resolve, reject) => {
          rejectWork = reject;
        });
      },
      controller.signal,
      async () => {
        cleanupCount += 1;
        rejectWork(new Error('Owned cleanup closed the operation.'));
      },
      () => {
        operationSettled = true;
      },
      5,
    );
    const rejected = assert.rejects(result, /aborted/);
    await started;
    controller.abort();
    await rejected;
    assert.equal(cleanupCount, 1);
    assert.equal(operationSettled, true);
  });

  it('discards a positive callback result that arrives after abort and cleanup', async () => {
    const controller = new AbortController();
    let entered!: () => void, finishWork!: (result: string) => void;
    const started = new Promise<void>((settle) => {
      entered = settle;
    });
    let operationSettled = false;
    const result = waitForCatalogWork(
      async () => {
        entered();
        return await new Promise<string>((settle) => {
          finishWork = settle;
        });
      },
      controller.signal,
      async () => {
        finishWork('late positive');
      },
      () => {
        operationSettled = true;
      },
      5,
    );
    const rejected = assert.rejects(result, /aborted/);
    await started;
    controller.abort();
    await rejected;
    assert.equal(operationSettled, true);
  });
});
