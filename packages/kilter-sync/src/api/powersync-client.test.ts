import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { streamKilterPowerSync, type PowerSyncOp } from './powersync-client';

/**
 * Build a Response with an NDJSON body. Pass an array of chunks (strings) so
 * the test can simulate JSON objects straddling chunk boundaries.
 */
function ndjsonResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { 'Content-Type': 'application/x-ndjson' },
  });
}

function mockFetch(response: Response): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response),
  );
}

describe('streamKilterPowerSync', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('fires onCheckpoint for a checkpoint envelope', async () => {
    const checkpoint = {
      last_op_id: '42',
      buckets: [{ bucket: 'user_buckets[abc]', checksum: 1, count: 5, priority: 0, subscriptions: [] }],
      streams: [],
    };
    mockFetch(
      ndjsonResponse([JSON.stringify({ checkpoint }) + '\n', JSON.stringify({ checkpoint_complete: {} }) + '\n']),
    );

    const onCheckpoint = vi.fn();
    await streamKilterPowerSync({
      accessToken: 'tok',
      streams: ['user_buckets'],
      onOp: vi.fn(),
      onCheckpoint,
    });

    expect(onCheckpoint).toHaveBeenCalledTimes(1);
    expect(onCheckpoint).toHaveBeenCalledWith(checkpoint);
  });

  it('fires onOp for each PUT op in a data envelope', async () => {
    const ops: PowerSyncOp[] = [
      { op_id: '1', op: 'PUT', object_type: 'logs', object_id: 'log-1', data: { foo: 'bar' } },
      { op_id: '2', op: 'PUT', object_type: 'logs', object_id: 'log-2', data: { foo: 'baz' } },
    ];
    mockFetch(
      ndjsonResponse([
        JSON.stringify({ data: { bucket: 'user_buckets[abc]', after: '0', has_more: false, data: ops } }) + '\n',
        JSON.stringify({ checkpoint_complete: {} }) + '\n',
      ]),
    );

    const onOp = vi.fn();
    await streamKilterPowerSync({ accessToken: 'tok', streams: ['user_buckets'], onOp });

    expect(onOp).toHaveBeenCalledTimes(2);
    expect(onOp).toHaveBeenNthCalledWith(1, ops[0]);
    expect(onOp).toHaveBeenNthCalledWith(2, ops[1]);
  });

  it('fires onOp for REMOVE ops too', async () => {
    const ops: PowerSyncOp[] = [{ op_id: '1', op: 'REMOVE', object_type: 'logs', object_id: 'log-1' }];
    mockFetch(
      ndjsonResponse([
        JSON.stringify({ data: { bucket: 'user_buckets[abc]', after: '0', has_more: false, data: ops } }) + '\n',
        JSON.stringify({ checkpoint_complete: {} }) + '\n',
      ]),
    );

    const onOp = vi.fn();
    await streamKilterPowerSync({ accessToken: 'tok', streams: ['user_buckets'], onOp });

    expect(onOp).toHaveBeenCalledTimes(1);
    expect(onOp).toHaveBeenCalledWith(ops[0]);
  });

  it('ignores ops with non-PUT/REMOVE op types', async () => {
    const ops = [
      { op_id: '1', op: 'MOVE' as 'PUT', object_type: 'logs', object_id: 'log-1', data: {} },
      { op_id: '2', op: 'PUT' as const, object_type: 'logs', object_id: 'log-2', data: {} },
    ] as PowerSyncOp[];
    mockFetch(
      ndjsonResponse([
        JSON.stringify({ data: { bucket: 'user_buckets[abc]', after: '0', has_more: false, data: ops } }) + '\n',
        JSON.stringify({ checkpoint_complete: {} }) + '\n',
      ]),
    );

    const onOp = vi.fn();
    await streamKilterPowerSync({ accessToken: 'tok', streams: ['user_buckets'], onOp });

    expect(onOp).toHaveBeenCalledTimes(1);
    expect(onOp).toHaveBeenCalledWith(ops[1]);
  });

  it('returns cleanly on checkpoint_complete without throwing', async () => {
    mockFetch(ndjsonResponse([JSON.stringify({ checkpoint_complete: {} }) + '\n']));

    await expect(
      streamKilterPowerSync({ accessToken: 'tok', streams: ['user_buckets'], onOp: vi.fn() }),
    ).resolves.toBeUndefined();
  });

  it('tolerates token_expires_in keepalive after checkpoint_complete', async () => {
    // Build a stream where checkpoint_complete happens first, then we
    // would-be-receive a keepalive. The function aborts on
    // checkpoint_complete, so the keepalive never reaches the parser —
    // but include it in the stream to make sure the parser doesn't crash
    // if order is reversed by the server.
    mockFetch(
      ndjsonResponse([
        JSON.stringify({ token_expires_in: 300 }) + '\n',
        JSON.stringify({ checkpoint_complete: {} }) + '\n',
      ]),
    );

    await expect(
      streamKilterPowerSync({ accessToken: 'tok', streams: ['user_buckets'], onOp: vi.fn() }),
    ).resolves.toBeUndefined();
  });

  it('throws KilterApiError("unauthorized") on 401', async () => {
    mockFetch(new Response('Token rejected', { status: 401 }));

    await expect(
      streamKilterPowerSync({ accessToken: 'tok', streams: ['user_buckets'], onOp: vi.fn() }),
    ).rejects.toMatchObject({
      name: 'KilterApiError',
      code: 'unauthorized',
      httpStatus: 401,
    });
  });

  it('throws KilterApiError("powersync") with status for non-401 non-2xx', async () => {
    mockFetch(new Response('Internal', { status: 503 }));

    await expect(
      streamKilterPowerSync({ accessToken: 'tok', streams: ['user_buckets'], onOp: vi.fn() }),
    ).rejects.toMatchObject({
      name: 'KilterApiError',
      code: 'powersync',
      httpStatus: 503,
    });
  });

  it('throws KilterApiError("powersync", "cancelled by caller") when called with a pre-aborted signal', async () => {
    // fetch shouldn't even be called in this case; pre-aborted short-circuit
    const fetchSpy = vi.fn(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    const controller = new AbortController();
    controller.abort();

    await expect(
      streamKilterPowerSync({
        accessToken: 'tok',
        streams: ['user_buckets'],
        onOp: vi.fn(),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({
      name: 'KilterApiError',
      code: 'powersync',
      message: 'PowerSync stream cancelled by caller',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('throws KilterApiError("powersync") "cancelled by caller" when the caller signal aborts mid-stream', async () => {
    // Build a stream whose body reader throws AbortError when the fetch
    // signal aborts — real `fetch` does this; ReadableStream by itself
    // does not, so we wire it manually.
    const controller = new AbortController();
    const encoder = new TextEncoder();

    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: { signal?: AbortSignal }) => {
        const fetchSignal = init?.signal;
        const stream = new ReadableStream({
          start(controllerStream) {
            // Send the checkpoint envelope so the caller's `onCheckpoint`
            // gets to fire `abort()`. After that, the stream waits for
            // the abort to propagate from the fetch signal into the
            // reader (mimics real fetch behaviour).
            controllerStream.enqueue(
              encoder.encode(
                JSON.stringify({
                  checkpoint: { last_op_id: '0', buckets: [], streams: [] },
                }) + '\n',
              ),
            );
            fetchSignal?.addEventListener(
              'abort',
              () => {
                const err = new Error('aborted');
                err.name = 'AbortError';
                controllerStream.error(err);
              },
              { once: true },
            );
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'application/x-ndjson' },
        });
      }),
    );

    const promise = streamKilterPowerSync({
      accessToken: 'tok',
      streams: ['user_buckets'],
      onOp: vi.fn(),
      onCheckpoint: () => controller.abort(),
      signal: controller.signal,
    });

    await expect(promise).rejects.toMatchObject({
      name: 'KilterApiError',
      code: 'powersync',
      message: 'PowerSync stream cancelled by caller',
    });
  });

  it('throws KilterApiError("timeout") when fetch open fails with an AbortError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }),
    );

    await expect(
      streamKilterPowerSync({ accessToken: 'tok', streams: ['user_buckets'], onOp: vi.fn() }),
    ).rejects.toMatchObject({ name: 'KilterApiError', code: 'timeout' });
  });

  it('throws KilterApiError("network") when fetch open fails with a generic error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connection refused');
      }),
    );

    await expect(
      streamKilterPowerSync({ accessToken: 'tok', streams: ['user_buckets'], onOp: vi.fn() }),
    ).rejects.toMatchObject({ name: 'KilterApiError', code: 'network' });
  });

  it('reassembles JSON objects split across chunk boundaries', async () => {
    const op: PowerSyncOp = {
      op_id: '1',
      op: 'PUT',
      object_type: 'logs',
      object_id: 'log-1',
      data: { climb_uuid: 'climb-1' },
    };
    const envelope =
      JSON.stringify({ data: { bucket: 'user_buckets[abc]', after: '0', has_more: false, data: [op] } }) + '\n';
    const complete = JSON.stringify({ checkpoint_complete: {} }) + '\n';

    // Split the data envelope at a random byte in the middle so the reader
    // has to buffer across chunks. Then send the checkpoint_complete in a
    // third chunk for good measure.
    const cut = Math.floor(envelope.length / 2);
    mockFetch(ndjsonResponse([envelope.slice(0, cut), envelope.slice(cut), complete]));

    const onOp = vi.fn();
    await streamKilterPowerSync({ accessToken: 'tok', streams: ['user_buckets'], onOp });

    expect(onOp).toHaveBeenCalledTimes(1);
    expect(onOp).toHaveBeenCalledWith(op);
  });

  it('reassembles when the newline splits across chunks', async () => {
    const op: PowerSyncOp = { op_id: '1', op: 'PUT', object_type: 'logs', object_id: 'log-1', data: {} };
    const line1 = JSON.stringify({ data: { bucket: 'b', after: '0', has_more: false, data: [op] } });
    const line2 = JSON.stringify({ checkpoint_complete: {} });

    // Put the \n separator in its own chunk so the reader has to handle
    // the case where the line break arrives without trailing content.
    mockFetch(ndjsonResponse([line1, '\n', line2, '\n']));

    const onOp = vi.fn();
    await streamKilterPowerSync({ accessToken: 'tok', streams: ['user_buckets'], onOp });

    expect(onOp).toHaveBeenCalledTimes(1);
  });
});
