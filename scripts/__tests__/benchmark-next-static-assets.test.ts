import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { S3Client, type ServiceOutputTypes } from '@aws-sdk/client-s3';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  benchmarkNextStaticAssets,
  parseBenchmarkArguments,
  serializedRequestLimiter,
} from '../benchmark-next-static-assets';
import { STATIC_ASSET_CACHE_CONTROL } from '../lib/static-asset-upload';

const IMAGE_DIGEST = `sha256:${'a'.repeat(64)}`;
const directories: string[] = [];
const clients: S3Client[] = [];
const checksum = (contents: Uint8Array) => createHash('sha256').update(contents).digest('base64');

afterEach(async () => {
  vi.useRealTimers();
  for (const client of clients.splice(0)) client.destroy();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(files: Record<string, string> = { 'chunks/a.js': 'window.runtime = true;' }) {
  const directory = await mkdtemp(join(tmpdir(), 'next-static-benchmark-'));
  directories.push(directory);
  const objects = new Map<string, Uint8Array>();
  for (const [name, contents] of Object.entries(files)) {
    await mkdir(join(directory, name, '..'), { recursive: true });
    await writeFile(join(directory, name), contents);
    objects.set(`_next/static/${name}`, new TextEncoder().encode(contents));
  }
  const client = new S3Client({
    region: 'us-east-1',
    credentials: { accessKeyId: 'test-key', secretAccessKey: 'test-secret' },
    maxAttempts: 1,
  });
  clients.push(client);
  const calls: { operation: string; key: string }[] = [];
  const faults: { putStatusOnce?: number; successfulPutOnce?: boolean; publicStatus?: number } = {};
  client.middlewareStack.add(
    (_next, context) => async (arguments_) => {
      const input = arguments_.input as { Key: string; IfNoneMatch?: string };
      calls.push({ operation: context.commandName ?? 'UnknownCommand', key: input.Key });
      const contents = objects.get(input.Key);
      if (!contents) {
        throw Object.assign(new Error('signed-url?credential=secret-value'), {
          $metadata: { httpStatusCode: 404 },
        });
      }
      if (context.commandName === 'PutObjectCommand') {
        expect(input.IfNoneMatch).toBe('*');
        if (faults.successfulPutOnce) {
          faults.successfulPutOnce = false;
          return { response: {}, output: { $metadata: { httpStatusCode: 200 } } as ServiceOutputTypes };
        }
        const status = faults.putStatusOnce ?? 412;
        faults.putStatusOnce = undefined;
        throw Object.assign(new Error('signed-url?credential=secret-value'), {
          $metadata: { httpStatusCode: status },
        });
      }
      const output = {
        ContentLength: contents.byteLength,
        ContentType: 'application/javascript',
        CacheControl: STATIC_ASSET_CACHE_CONTROL,
        ChecksumSHA256: checksum(contents),
        $metadata: { httpStatusCode: 200 },
        ...(context.commandName === 'GetObjectCommand'
          ? { Body: { transformToWebStream: () => new Response(Uint8Array.from(contents)).body } }
          : {}),
      };
      return { response: {}, output: output as unknown as ServiceOutputTypes };
    },
    { step: 'initialize', priority: 'low', name: 'inMemoryStorage' },
  );
  const fetchImpl = vi.fn<typeof fetch>(async (input) => {
    if (faults.publicStatus) return new Response(null, { status: faults.publicStatus });
    const url = new URL(input instanceof Request ? input.url : input);
    expect(url.origin).toBe('https://assets.boardsesh.com');
    const contents = objects.get(decodeURIComponent(url.pathname.slice(1)))!;
    return new Response(Uint8Array.from(contents), {
      headers: {
        'content-type': 'application/javascript',
        'content-length': String(contents.byteLength),
        'cache-control': STATIC_ASSET_CACHE_CONTROL,
        'access-control-allow-origin': '*',
        'cf-ray': 'benchmark-test-SYD',
        'cf-cache-status': 'HIT',
      },
    });
  });
  const createLimiter = vi.fn((_rate: number) => async () => {});
  const options = { directory, client, bucket: 'static-assets', imageDigest: IMAGE_DIGEST, fetchImpl, createLimiter };
  return { directory, objects, calls, faults, fetchImpl, createLimiter, options };
}

describe('existing Next asset publisher benchmark', () => {
  it('measures all five production operations at every rate, including both public request shapes', async () => {
    const remote = await fixture({ 'chunks/a.js': 'first', 'chunks/z.js': 'second' });
    const report = await benchmarkNextStaticAssets(remote.options);

    expect(report).toMatchObject({ status: 'passed', phase: 'complete', assets: 2, bytes: 11, workers: 4 });
    expect(remote.createLimiter.mock.calls.map(([rate]) => rate)).toEqual([5, 5, 10, 20, 20, 10, 5]);
    expect(report.rounds.map((round) => round.rate)).toEqual([5, 10, 20, 20, 10, 5]);
    for (const round of report.rounds) {
      expect(round).toMatchObject({
        uploaded: 0,
        existing: 2,
        requests: {
          'PutObjectCommand:412': 2,
          'HeadObjectCommand:200': 2,
          'GetObjectCommand:200': 2,
          'CDN_GET:200': 4,
        },
        cacheStatuses: { HIT: 4 },
      });
      expect(round.seconds).toBeGreaterThanOrEqual(0);
    }
    expect(remote.calls.slice(0, 4).map(({ operation }) => operation)).toEqual([
      'HeadObjectCommand',
      'GetObjectCommand',
      'HeadObjectCommand',
      'GetObjectCommand',
    ]);
    expect(remote.calls.filter(({ operation }) => operation === 'PutObjectCommand')).toHaveLength(12);
    expect(remote.fetchImpl).toHaveBeenCalledTimes(24);
    expect(remote.fetchImpl.mock.calls.filter(([, init]) => new Headers(init?.headers).has('Origin'))).toHaveLength(12);
    expect(remote.fetchImpl.mock.calls.every(([, init]) => init?.redirect === 'error')).toBe(true);
  });

  it.each(['missing', 'corrupt'] as const)(
    'refuses the whole set before any PUT when a later asset is %s',
    async (fault) => {
      const remote = await fixture({ 'chunks/a.js': 'first', 'chunks/z.js': 'second' });
      if (fault === 'missing') remote.objects.delete('_next/static/chunks/z.js');
      else remote.objects.set('_next/static/chunks/z.js', new TextEncoder().encode('broken'));

      const report = await benchmarkNextStaticAssets(remote.options);

      expect(report).toMatchObject({ status: 'failed', phase: 'preflight', rounds: [] });
      expect(remote.calls.some(({ operation }) => operation === 'PutObjectCommand')).toBe(false);
      expect(remote.fetchImpl).not.toHaveBeenCalled();
      expect(JSON.stringify(report)).not.toContain('secret-value');
      expect(JSON.stringify(report)).not.toContain('signed-url');
    },
  );

  it('records a throttled PUT even when its retry succeeds, then stops before the next rate', async () => {
    const remote = await fixture();
    remote.faults.putStatusOnce = 429;

    const report = await benchmarkNextStaticAssets(remote.options);

    expect(report.status).toBe('failed');
    expect(report.rounds).toHaveLength(1);
    expect(report.rounds[0]).toMatchObject({
      uploaded: 0,
      existing: 1,
      requests: { 'PutObjectCommand:429': 1, 'PutObjectCommand:412': 1, 'CDN_GET:200': 2 },
    });
    expect(remote.createLimiter.mock.calls.map(([rate]) => rate)).toEqual([5, 5]);
  });

  it('stops later rounds if an object was recreated between preflight and the conditional PUT', async () => {
    const remote = await fixture();
    remote.faults.successfulPutOnce = true;

    const report = await benchmarkNextStaticAssets(remote.options);

    expect(report.status).toBe('failed');
    expect(report.rounds).toHaveLength(1);
    expect(report.rounds[0]).toMatchObject({ uploaded: 1, existing: 0, requests: { 'PutObjectCommand:200': 1 } });
    expect(remote.createLimiter.mock.calls.map(([rate]) => rate)).toEqual([5, 5]);
  });

  it('retains failed public status counts without advancing to another rate', async () => {
    const remote = await fixture();
    remote.faults.publicStatus = 403;

    const report = await benchmarkNextStaticAssets(remote.options);

    expect(report.status).toBe('failed');
    expect(report.rounds).toHaveLength(1);
    expect(report.rounds[0].requests['CDN_GET:403']).toBe(1);
    expect(remote.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refuses an oversized set before contacting storage', async () => {
    const remote = await fixture(
      Object.fromEntries(Array.from({ length: 401 }, (_, index) => [`chunks/${index}.js`, 'x'])),
    );

    const report = await benchmarkNextStaticAssets(remote.options);

    expect(report).toMatchObject({ status: 'failed', phase: 'preflight', rounds: [] });
    expect(remote.calls).toEqual([]);
    expect(remote.fetchImpl).not.toHaveBeenCalled();
  });

  it('requires a digest before contacting storage', async () => {
    const remote = await fixture();
    await expect(benchmarkNextStaticAssets({ ...remote.options, imageDigest: 'production' })).rejects.toThrow(
      'immutable image digest',
    );
    expect(remote.calls).toEqual([]);
  });
});

describe('benchmark arguments and request limiting', () => {
  it('accepts only explicit input and report paths', () => {
    expect(parseBenchmarkArguments(['--directory', '/tmp/assets', '--output', '/tmp/report.json'])).toEqual({
      directory: '/tmp/assets',
      output: '/tmp/report.json',
    });
    for (const arguments_ of [
      [],
      ['--directory', 'assets'],
      ['--directory', '--output', '--output', 'report'],
      ['--directory', 'assets', '--output', ''],
      ['--directory', 'assets', '--output', 'report', '--rate', '200'],
    ]) {
      expect(() => parseBenchmarkArguments(arguments_)).toThrow('Usage:');
    }
  });

  it('spaces concurrent callers instead of letting them burst through the same allowance', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const limit = serializedRequestLimiter(5);
    const starts: number[] = [];
    const callers = Promise.all(
      Array.from({ length: 4 }, async () => {
        await limit();
        starts.push(Date.now());
      }),
    );
    await vi.runAllTimersAsync();
    await callers;
    expect(starts).toEqual([0, 200, 400, 600]);
  });
});
