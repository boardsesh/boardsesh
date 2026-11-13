import { expect, it, vi } from 'vite-plus/test';
import { AUTH_COMMAND_MAX_BODY_BYTES, AUTH_COMMAND_REQUEST_BYTES, AUTH_COMMAND_RESPONSE_BYTES } from '../index';
import { AuthBackendUnavailableError, createPrivateAuthCommandTransport } from '../private-command-transport';
import { LOCATION_SYNC_REQUEST_BYTES, LOCATION_SYNC_RESPONSE_BYTES } from '../location-sync-v1';

const path = '/api/internal/auth/owned-proof';
const base = {
  paths: [path],
  originKey: 'OWNED_ORIGIN',
  secretKey: 'OWNED_SECRET',
  disallowedSecretKeys: ['NEXTAUTH_SECRET'],
  environment: {
    NODE_ENV: 'test',
    OWNED_ORIGIN: 'http://127.0.0.1:54321',
    OWNED_SECRET: 'owned-private-proof-secret-at-least-32-bytes',
  },
};
function bodyOfBytes(bytes: number) {
  return JSON.stringify({ payload: 'x'.repeat(bytes - 14) });
}
function streamedJson(bytes: number, headers: Record<string, string> = {}) {
  const body = new TextEncoder().encode(bodyOfBytes(bytes));
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < body.length; offset += 4093)
          controller.enqueue(body.slice(offset, offset + 4093));
        controller.close();
      },
    }),
    { headers: { 'Content-Type': 'application/json', ...headers } },
  );
}

it('keeps the released request default and refuses an oversized request before network I/O', async () => {
  const send = vi.fn(async () => Response.json({ outcome: 'owned' }));
  const transport = createPrivateAuthCommandTransport({ ...base, fetch: send });
  await expect(
    transport.post(path, JSON.parse(bodyOfBytes(AUTH_COMMAND_REQUEST_BYTES)) as unknown),
  ).resolves.toMatchObject({ status: 200 });
  expect(send).toHaveBeenCalledTimes(1);
  await expect(
    transport.post(path, JSON.parse(bodyOfBytes(AUTH_COMMAND_REQUEST_BYTES + 1)) as unknown),
  ).rejects.toThrow(AuthBackendUnavailableError);
  expect(send).toHaveBeenCalledTimes(1);
});

it('keeps the released streamed response default, even when Content-Length understates the actual body', async () => {
  const send = vi.fn(async () => streamedJson(AUTH_COMMAND_RESPONSE_BYTES + 1, { 'Content-Length': '1' }));
  const transport = createPrivateAuthCommandTransport({ ...base, fetch: send });
  await expect(transport.post(path, {})).rejects.toThrow(AuthBackendUnavailableError);
});

it('accepts explicit bounded facade request and response budgets through the complete streamed bodies', async () => {
  const requestBytes = 196_608;
  const responseBytes = 131_072;
  const send = vi.fn(async (_input: string | Request | URL, init?: RequestInit) => {
    if (typeof init?.body !== 'string') throw new Error('Expected serialized private command');
    expect(new TextEncoder().encode(init.body).byteLength).toBe(requestBytes);
    return streamedJson(responseBytes);
  });
  const transport = createPrivateAuthCommandTransport({ ...base, fetch: send, requestBytes, responseBytes });
  const reply = await transport.post(path, JSON.parse(bodyOfBytes(requestBytes)) as unknown);
  expect(reply.status).toBe(200);
  expect(new TextEncoder().encode(JSON.stringify(reply.body)).byteLength).toBe(responseBytes);
  await expect(transport.post(path, JSON.parse(bodyOfBytes(requestBytes + 1)) as unknown)).rejects.toThrow(
    AuthBackendUnavailableError,
  );
  expect(send).toHaveBeenCalledTimes(1);
});

it('applies the selected response cap to both declared and actual bytes', async () => {
  for (const declared of [undefined, '131073']) {
    const send = vi.fn(async () => streamedJson(131_073, declared === undefined ? {} : { 'Content-Length': declared }));
    const transport = createPrivateAuthCommandTransport({ ...base, fetch: send, responseBytes: 131_072 });
    await expect(transport.post(path, {})).rejects.toThrow(AuthBackendUnavailableError);
  }
});

it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, AUTH_COMMAND_MAX_BODY_BYTES + 1])(
  'rejects invalid trusted byte budget %s before making any request',
  (bytes) => {
    const send = vi.fn(async () => Response.json({}));
    expect(() => createPrivateAuthCommandTransport({ ...base, fetch: send, requestBytes: bytes })).toThrow(
      AuthBackendUnavailableError,
    );
    expect(() => createPrivateAuthCommandTransport({ ...base, fetch: send, responseBytes: bytes })).toThrow(
      AuthBackendUnavailableError,
    );
    expect(send).not.toHaveBeenCalled();
  },
);

it('captures trusted budgets at construction and never reads command fields as configuration', async () => {
  const send = vi.fn(async () => Response.json({}));
  const options = { ...base, fetch: send, requestBytes: 32768, responseBytes: 65536 };
  const transport = createPrivateAuthCommandTransport(options);
  options.requestBytes = AUTH_COMMAND_MAX_BODY_BYTES;
  options.responseBytes = AUTH_COMMAND_MAX_BODY_BYTES;
  await expect(
    transport.post(path, { requestedBytes: AUTH_COMMAND_MAX_BODY_BYTES, payload: 'x'.repeat(32768) }),
  ).rejects.toThrow(AuthBackendUnavailableError);
  expect(send).not.toHaveBeenCalled();
});

it('permits the hard trusted ceiling without removing it', async () => {
  const transport = createPrivateAuthCommandTransport({
    ...base,
    fetch: async () => streamedJson(AUTH_COMMAND_MAX_BODY_BYTES),
    requestBytes: AUTH_COMMAND_MAX_BODY_BYTES,
    responseBytes: AUTH_COMMAND_MAX_BODY_BYTES,
  });
  await expect(
    transport.post(path, JSON.parse(bodyOfBytes(AUTH_COMMAND_MAX_BODY_BYTES)) as unknown),
  ).resolves.toMatchObject({ status: 200 });
});

it('preserves the merged location-sync 512 KiB request and 1 MiB response contract', async () => {
  expect(LOCATION_SYNC_REQUEST_BYTES).toBe(524_288);
  expect(LOCATION_SYNC_RESPONSE_BYTES).toBe(1_048_576);
  const transport = createPrivateAuthCommandTransport({
    ...base,
    fetch: async () => streamedJson(LOCATION_SYNC_RESPONSE_BYTES),
    requestBytes: LOCATION_SYNC_REQUEST_BYTES,
    responseBytes: LOCATION_SYNC_RESPONSE_BYTES,
  });
  await expect(
    transport.post(path, JSON.parse(bodyOfBytes(LOCATION_SYNC_REQUEST_BYTES)) as unknown),
  ).resolves.toMatchObject({ status: 200 });
});

it('refuses explicit null budgets from an untyped trusted caller rather than treating them as omitted', () => {
  for (const budget of ['requestBytes', 'responseBytes']) {
    const options = { ...base, fetch: async () => Response.json({}), [budget]: null };
    expect(() => Reflect.apply(createPrivateAuthCommandTransport, undefined, [options])).toThrow(
      AuthBackendUnavailableError,
    );
  }
});
