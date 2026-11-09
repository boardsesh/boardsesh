/// <reference types="node" />
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const script = join(root, 'packages/db/scripts/dedupe-gym-locations.ts');
const modeName = 'CURRENT_STORE_FIXED_SYSTEM_OWNER_ORDER_MODE';

async function invokeCli(
  mode: string,
  cliArguments: string[] = ['--apply'],
): Promise<{ code: number | null; output: string }> {
  const directory = mkdtempSync(join(tmpdir(), 'gym-order-cli-'));
  const databaseModule = join(directory, 'database.mjs');
  const forbiddenClient = join(directory, 'forbidden-client.mjs');
  const preload = join(directory, 'guard.mjs');
  writeFileSync(forbiddenClient, `export default function(){throw new Error('REAL_DATABASE_CLIENT_FORBIDDEN');}`, {
    flag: 'wx',
    mode: 0o600,
  });
  writeFileSync(
    databaseModule,
    `
    import {PgDialect} from ${JSON.stringify(pathToFileURL(join(root, 'packages/db/node_modules/drizzle-orm/pg-core/index.js')).href)};
    const candidates=[1,2].map(id=>({id,uuid:'fixture-gym-'+id,name:'Fixed owner CLI fixture',address:null,
      contactEmail:null,contactPhone:null,description:null,imageUrl:null,latitude:47,longitude:8,
      createdAt:new Date('2026-01-01'),boardCount:0,memberCount:0,followerCount:0,commentCount:0}));
    export function createScriptDb() {
      process.stdout.write('FACTORY_CALLED\\n');
      return {db:{
        async execute() {
          process.env.${modeName}='legacy';
          return candidates;
        },
        async transaction(callback) {
          process.stdout.write('TRANSACTION_STARTED\\n');
          return callback({rollback(){throw new Error('fixture rollback');},async execute(query) {
            const text=new PgDialect().sqlToQuery(query).sql;
            if(text.includes('pg_try_advisory_xact_lock')) {
              process.stdout.write('OWNER_TRY\\n');return [{acquired:false}];
            }
            if(text.includes('boardsesh:gym-location-dedupe')) {
              process.stdout.write('DEDUPE_LOCK\\n');return [];
            }
            process.stdout.write('CONTENT_BEFORE_OWNER\\n');throw new Error('CONTENT_BEFORE_OWNER');
          }});
        }
      },async close(){process.stdout.write('FACTORY_CLOSED\\n');}};
    }
  `,
    { flag: 'wx', mode: 0o600 },
  );
  writeFileSync(
    preload,
    `
    import {registerHooks} from 'node:module';
    import {Socket} from 'node:net';
    import {tmpdir,userInfo} from 'node:os';
    import {join} from 'node:path';
    const parentPipe=join(tmpdir(),'tsx-'+(process.geteuid?process.geteuid():userInfo().username),process.ppid+'.pipe');
    const original=Socket.prototype.connect;
    Socket.prototype.connect=function(...args) {
      const first=Array.isArray(args[0])?args[0][0]:args[0];
      const path=typeof first==='string'?first:first?.path;
      if(path!==parentPipe || (typeof first!=='string' && (first.host!==undefined || first.port!==undefined)))
        throw new Error('SERVICE_SOCKET_FORBIDDEN');
      return Reflect.apply(original,this,args);
    };
    registerHooks({resolve(specifier,context,nextResolve) {
      if(/^dotenv(?:\\/|$)/.test(specifier)) throw new Error('ENVFILE_IMPORT_FORBIDDEN');
      if(specifier==='postgres') return {url:${JSON.stringify(pathToFileURL(forbiddenClient).href)},shortCircuit:true};
      if(/^\\.\\/db-connection\\.(?:js|ts)$/.test(specifier) && context.parentURL?.includes('/scripts/dedupe-gym-locations.ts'))
        return {url:${JSON.stringify(pathToFileURL(databaseModule).href)},shortCircuit:true};
      return nextResolve(specifier,context);
    }});
  `,
    { flag: 'wx', mode: 0o600 },
  );
  const child = spawn(
    process.execPath,
    ['--import', pathToFileURL(preload).href, '--import', 'tsx', script, ...cliArguments],
    {
      cwd: root,
      env: { PATH: process.env.PATH, LANG: 'C', TZ: 'UTC', NODE_ENV: 'test', [modeName]: mode },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const buffers: Buffer[] = [];
  let size = 0;
  let failed = false;
  const kill = () => {
    failed = true;
    if (child.pid) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* Actual close below decides completion. */
      }
    }
  };
  const deadline = setTimeout(kill, 5000);
  const capture = (chunk: Buffer) => {
    size += chunk.length;
    if (size > 65536) kill();
    else buffers.push(chunk);
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  child.once('error', kill);
  process.once('SIGTERM', kill);
  process.once('SIGINT', kill);
  process.once('exit', kill);
  try {
    const code = await new Promise<number | null>((settle) => child.once('close', settle));
    const alive = () =>
      child.pid &&
      execFileSync('ps', ['-eo', 'pgid=,stat='], {
        encoding: 'utf8',
        timeout: 1000,
        maxBuffer: 2 * 1024 * 1024,
        env: { PATH: process.env.PATH, LANG: 'C', NODE_ENV: 'test' },
      })
        .split('\n')
        .some((line) => {
          const [group, state] = line.trim().split(/\s+/);
          return Number(group) === child.pid && !state?.startsWith('Z');
        });
    const drainsAt = performance.now() + 2000;
    while (alive() && performance.now() < drainsAt) await new Promise((settle) => setTimeout(settle, 10));
    assert.equal(Boolean(alive()), false, 'CLI child group must drain');
    assert.equal(failed, false, 'CLI child must close before its deadline/output cap');
    return { code, output: Buffer.concat(buffers).toString() };
  } finally {
    clearTimeout(deadline);
    process.removeListener('SIGTERM', kill);
    process.removeListener('SIGINT', kill);
    process.removeListener('exit', kill);
    if (child.exitCode === null) kill();
  }
}

void it('rejects an unknown mode before constructing the CLI database factory', async () => {
  const result = await invokeCli('invalid-selector-fixture');
  assert.equal(result.code, 1);
  assert.doesNotMatch(result.output, /FACTORY_CALLED|TRANSACTION_STARTED|OWNER_TRY|CONTENT_BEFORE_OWNER/);
  assert.doesNotMatch(
    result.output,
    /invalid-selector-fixture|SERVICE_SOCKET_FORBIDDEN|ENVFILE_IMPORT_FORBIDDEN|REAL_DATABASE_CLIENT_FORBIDDEN/,
  );
  assert.match(result.output, /Fixed system-owner coordination is temporarily unavailable/);
});

void it('prints help on a bad mode instead of failing', async () => {
  const result = await invokeCli('invalid-selector-fixture', ['--help']);
  assert.equal(result.code, 0);
  assert.doesNotMatch(result.output, /FACTORY_CALLED|TRANSACTION_STARTED|OWNER_TRY/);
});

void it('captures staging before candidate loading and queues on the dedupe lock before trying the owner key', async () => {
  const result = await invokeCli('cooperative-staging');
  assert.equal(result.code, 1);
  assert.match(result.output, /FACTORY_CALLED/);
  assert.match(result.output, /TRANSACTION_STARTED/);
  assert.match(result.output, /DEDUPE_LOCK[\s\S]*OWNER_TRY/);
  assert.equal((result.output.match(/OWNER_TRY/g) ?? []).length, 1);
  assert.match(result.output, /FACTORY_CLOSED/);
  assert.doesNotMatch(
    result.output,
    /CONTENT_BEFORE_OWNER|SERVICE_SOCKET_FORBIDDEN|ENVFILE_IMPORT_FORBIDDEN|REAL_DATABASE_CLIENT_FORBIDDEN/,
  );
});
