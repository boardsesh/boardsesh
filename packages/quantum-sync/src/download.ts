import { Buffer } from 'node:buffer';
import { createHash, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import type { IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import type { QuantumSyncLimits } from './config';
import { QuantumSyncError, quantumSyncErrorMessage } from './errors';
import { createPrivateQuantumTempFile, writeAllToFile, type PrivateQuantumTempFile } from './temp-file';
import type {
  DownloadedQuantumChunk,
  QuantumHostnameResolver,
  QuantumManifestChunk,
  QuantumMirrorFetch,
  QuantumResolvedAddress,
} from './types';

const MAX_MIRROR_REDIRECTS = 5;
const MAX_RESOLVED_ADDRESSES = 16;

type QuantumMirrorResponse = Readonly<{
  status: number;
  url: string;
  header(name: string): string | null;
  consume(consumer: (piece: Uint8Array) => Promise<void>, signal?: AbortSignal): Promise<void>;
  cancel(reason?: unknown): Promise<void>;
}>;

export type DownloadQuantumChunkOptions = {
  /** Test seam only. Production uses the IP-pinned Node HTTPS transport. */
  fetch?: QuantumMirrorFetch;
  resolveHostname?: QuantumHostnameResolver;
  signal?: AbortSignal;
};

export async function downloadQuantumChunk(
  chunk: Readonly<QuantumManifestChunk>,
  limits: Readonly<QuantumSyncLimits>,
  options: DownloadQuantumChunkOptions = {},
): Promise<Readonly<DownloadedQuantumChunk>> {
  if (chunk.size > limits.maxCompressedBytes) {
    throw new QuantumSyncError('CHUNK_INTEGRITY_FAILED', 'Quantum snapshot exceeds the compressed-size cap.');
  }

  const failures: string[] = [];
  for (const mirrorUrl of chunk.urls) {
    try {
      return await downloadOneMirror(mirrorUrl, chunk, limits, options);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      failures.push(quantumSyncErrorMessage(error));
    }
  }

  throw new QuantumSyncError(
    'MIRROR_DOWNLOAD_FAILED',
    `Every Quantum snapshot mirror failed (${failures.length} attempt(s)): ${failures.join('; ')}`,
  );
}

async function downloadOneMirror(
  mirrorUrl: string,
  chunk: Readonly<QuantumManifestChunk>,
  limits: Readonly<QuantumSyncLimits>,
  options: DownloadQuantumChunkOptions,
): Promise<Readonly<DownloadedQuantumChunk>> {
  const deadlineController = new AbortController();
  const deadline = setTimeout(() => deadlineController.abort(), limits.mirrorTimeoutMs);
  const signal = options.signal
    ? AbortSignal.any([options.signal, deadlineController.signal])
    : deadlineController.signal;
  let response: QuantumMirrorResponse | null = null;
  let temporary: PrivateQuantumTempFile | null = null;
  try {
    throwIfAborted(signal);
    response = await requestFollowingSafeRedirects(mirrorUrl, { ...options, signal });
    if (response.status < 200 || response.status > 299) {
      await response.cancel();
      throw new QuantumSyncError('MIRROR_DOWNLOAD_FAILED', `Quantum mirror returned HTTP ${response.status}.`);
    }

    const contentEncoding = response.header('content-encoding');
    if (contentEncoding && contentEncoding.toLowerCase() !== 'identity') {
      await response.cancel();
      throw new QuantumSyncError(
        'CHUNK_INTEGRITY_FAILED',
        'Quantum mirror applied an unexpected HTTP content encoding.',
      );
    }
    const contentLength = response.header('content-length');
    if (contentLength !== null) {
      const parsedLength = Number(contentLength);
      if (!Number.isSafeInteger(parsedLength) || parsedLength !== chunk.size) {
        await response.cancel();
        throw new QuantumSyncError(
          'CHUNK_INTEGRITY_FAILED',
          'Quantum mirror Content-Length disagrees with the manifest.',
        );
      }
    }

    const artifact = await createPrivateQuantumTempFile('boardsesh-quantum-download-', 'snapshot.sqlite3.zst');
    temporary = artifact;
    const digest = createHash('sha256');
    let receivedBytes = 0;
    await response.consume(async (piece) => {
      throwIfAborted(signal);
      if (piece.byteLength === 0) return;
      receivedBytes += piece.byteLength;
      if (receivedBytes > chunk.size || receivedBytes > limits.maxCompressedBytes) {
        throw new QuantumSyncError('CHUNK_INTEGRITY_FAILED', 'Quantum mirror streamed more bytes than allowed.');
      }
      digest.update(piece);
      await writeAllToFile(artifact.handle, piece);
    }, signal);
    await artifact.close();

    if (receivedBytes !== chunk.size) {
      throw new QuantumSyncError('CHUNK_INTEGRITY_FAILED', 'Quantum mirror byte count disagrees with the manifest.');
    }
    const actualSha256 = digest.digest('hex');
    if (!safeHexEquals(actualSha256, chunk.sha256)) {
      throw new QuantumSyncError('CHUNK_INTEGRITY_FAILED', 'Quantum mirror SHA-256 disagrees with the manifest.');
    }

    return Object.freeze({
      filePath: artifact.path,
      mirrorUrl: response.url,
      sha256: actualSha256,
      size: receivedBytes,
      dispose: artifact.dispose,
    });
  } catch (error) {
    void response?.cancel(error).catch(() => {});
    await temporary?.dispose();
    if (deadlineController.signal.aborted && !options.signal?.aborted) {
      throw new QuantumSyncError(
        'MIRROR_DOWNLOAD_FAILED',
        `Quantum mirror exceeded its ${limits.mirrorTimeoutMs}ms deadline.`,
        { cause: error },
      );
    }
    throw error;
  } finally {
    clearTimeout(deadline);
  }
}

async function requestFollowingSafeRedirects(
  mirrorUrl: string,
  options: DownloadQuantumChunkOptions,
): Promise<QuantumMirrorResponse> {
  const initialUrl = requireSafeHttpsUrl(mirrorUrl);
  const approvedOrigin = initialUrl.origin;
  let target = initialUrl;

  for (let redirectCount = 0; redirectCount <= MAX_MIRROR_REDIRECTS; redirectCount += 1) {
    throwIfAborted(options.signal);
    const addresses = await resolvePublicAddresses(
      target,
      options.resolveHostname ?? resolveQuantumHostname,
      options.signal,
    );
    const response = options.fetch
      ? await requestWithInjectedFetch(target, addresses, options.fetch, options.signal)
      : await requestPinnedHttps(target, addresses, options.signal);

    if (!isRedirectStatus(response.status)) return response;
    const location = response.header('location');
    await response.cancel();
    if (!location) {
      throw new QuantumSyncError('MIRROR_DOWNLOAD_FAILED', 'Quantum mirror redirect omitted Location.');
    }
    if (redirectCount === MAX_MIRROR_REDIRECTS) {
      throw new QuantumSyncError('MIRROR_DOWNLOAD_FAILED', 'Quantum mirror exceeded the redirect limit.');
    }

    const redirected = requireSafeHttpsUrl(new URL(location, target).toString());
    if (redirected.origin !== approvedOrigin) {
      throw new QuantumSyncError('MIRROR_DOWNLOAD_FAILED', 'Quantum mirror redirect changed the approved origin.');
    }
    target = redirected;
  }

  throw new QuantumSyncError('MIRROR_DOWNLOAD_FAILED', 'Quantum mirror redirect handling failed.');
}

async function requestWithInjectedFetch(
  target: URL,
  _addresses: readonly QuantumResolvedAddress[],
  fetchMirror: QuantumMirrorFetch,
  signal?: AbortSignal,
): Promise<QuantumMirrorResponse> {
  const response = await raceWithAbort(
    fetchMirror(target.toString(), {
      method: 'GET',
      headers: mirrorRequestHeaders(),
      redirect: 'manual',
      signal,
    }),
    signal,
  );
  if (response.redirected) {
    await response.body?.cancel().catch(() => {});
    throw new QuantumSyncError('MIRROR_DOWNLOAD_FAILED', 'Quantum mirror transport followed a redirect implicitly.');
  }

  let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  return {
    status: response.status,
    url: target.toString(),
    header: (name) => response.headers.get(name),
    async consume(consumer, consumeSignal) {
      if (!response.body) {
        throw new QuantumSyncError('MIRROR_DOWNLOAD_FAILED', 'Quantum mirror response did not contain a body.');
      }
      activeReader = response.body.getReader();
      const abort = () => {
        void activeReader?.cancel(consumeSignal?.reason).catch(() => {});
      };
      consumeSignal?.addEventListener('abort', abort, { once: true });
      if (consumeSignal?.aborted) abort();
      try {
        while (true) {
          throwIfAborted(consumeSignal);
          const result = await activeReader.read();
          if (result.done) break;
          await consumer(result.value);
        }
      } finally {
        consumeSignal?.removeEventListener('abort', abort);
        activeReader.releaseLock();
        activeReader = null;
      }
    },
    async cancel(reason) {
      if (activeReader) {
        await activeReader.cancel(reason).catch(() => {});
        return;
      }
      await response.body?.cancel(reason).catch(() => {});
    },
  };
}

async function requestPinnedHttps(
  target: URL,
  addresses: readonly QuantumResolvedAddress[],
  signal?: AbortSignal,
): Promise<QuantumMirrorResponse> {
  const failures: string[] = [];
  for (const resolved of addresses) {
    try {
      return await requestPinnedAddress(target, resolved, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      failures.push(quantumSyncErrorMessage(error));
    }
  }
  throw new QuantumSyncError(
    'MIRROR_DOWNLOAD_FAILED',
    `Quantum mirror HTTPS connection failed for every public address: ${failures.join('; ')}`,
  );
}

function requestPinnedAddress(
  target: URL,
  resolved: QuantumResolvedAddress,
  signal?: AbortSignal,
): Promise<QuantumMirrorResponse> {
  return new Promise((resolve, reject) => {
    const originalHostname = unbracketHostname(target.hostname);
    const request = httpsRequest(
      {
        protocol: 'https:',
        hostname: resolved.address,
        family: resolved.family,
        port: target.port || 443,
        method: 'GET',
        path: `${target.pathname}${target.search}`,
        headers: { ...mirrorRequestHeaders(), Host: target.host },
        servername: isIP(originalHostname) === 0 ? originalHostname : undefined,
        rejectUnauthorized: true,
        agent: false,
        signal,
      },
      (message) => resolve(nodeMirrorResponse(target, message)),
    );
    request.once('error', reject);
    request.end();
  });
}

function nodeMirrorResponse(target: URL, message: IncomingMessage): QuantumMirrorResponse {
  return {
    status: message.statusCode ?? 0,
    url: target.toString(),
    header(name) {
      const value = message.headers[name.toLowerCase()];
      if (Array.isArray(value)) return value.join(', ');
      return value ?? null;
    },
    async consume(consumer, signal) {
      const abort = () => message.destroy(abortError(signal));
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      try {
        for await (const chunk of message) {
          throwIfAborted(signal);
          const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
          await consumer(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength));
        }
      } finally {
        signal?.removeEventListener('abort', abort);
      }
    },
    async cancel(reason) {
      const error = reason instanceof Error ? reason : undefined;
      message.destroy(error);
    },
  };
}

function mirrorRequestHeaders(): Record<string, string> {
  return {
    Accept: 'application/zstd, application/octet-stream',
    'Accept-Encoding': 'identity',
  };
}

export async function resolveQuantumHostname(
  hostname: string,
  signal?: AbortSignal,
): Promise<readonly QuantumResolvedAddress[]> {
  throwIfAborted(signal);
  const normalizedHostname = unbracketHostname(hostname);
  const literalFamily = isIP(normalizedHostname);
  if (literalFamily === 4 || literalFamily === 6) {
    return [{ address: normalizedHostname, family: literalFamily }];
  }
  const records = await lookup(normalizedHostname, { all: true, verbatim: true });
  throwIfAborted(signal);
  return records.map(({ address, family }) => {
    if (family !== 4 && family !== 6) {
      throw new QuantumSyncError('MIRROR_DOWNLOAD_FAILED', 'Quantum mirror DNS returned an unsupported address.');
    }
    return { address, family };
  });
}

async function resolvePublicAddresses(
  target: URL,
  resolver: QuantumHostnameResolver,
  signal?: AbortSignal,
): Promise<readonly QuantumResolvedAddress[]> {
  const rawHostname = unbracketHostname(target.hostname).toLowerCase();
  const hostname = rawHostname.endsWith('.') ? rawHostname.slice(0, -1) : rawHostname;
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.home.arpa')
  ) {
    throw new QuantumSyncError('MIRROR_DOWNLOAD_FAILED', 'Quantum mirror hostname is not publicly routable.');
  }

  const resolved = await raceWithAbort(resolver(hostname, signal), signal);
  throwIfAborted(signal);
  if (resolved.length === 0 || resolved.length > MAX_RESOLVED_ADDRESSES) {
    throw new QuantumSyncError('MIRROR_DOWNLOAD_FAILED', 'Quantum mirror DNS returned an invalid address count.');
  }
  const unique = new Map<string, QuantumResolvedAddress>();
  for (const candidate of resolved) {
    const detectedFamily = isIP(candidate.address);
    if (detectedFamily !== candidate.family || !isPublicIpAddress(candidate.address)) {
      throw new QuantumSyncError('MIRROR_DOWNLOAD_FAILED', 'Quantum mirror resolved to a non-public address.');
    }
    unique.set(`${candidate.family}:${candidate.address}`, Object.freeze({ ...candidate }));
  }
  return Object.freeze([...unique.values()]);
}

function requireSafeHttpsUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new QuantumSyncError('MIRROR_DOWNLOAD_FAILED', 'Quantum mirror URL is invalid.');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) {
    throw new QuantumSyncError(
      'MIRROR_DOWNLOAD_FAILED',
      'Quantum mirror URL must be credential-free HTTPS without a fragment.',
    );
  }
  return parsed;
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

export function isPublicIpAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family === 6) return isPublicIpv6(address);
  return false;
}

function isPublicIpv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }
  const [first = 0, second = 0, third = 0] = octets;
  if (first === 0 || first === 10 || first === 127 || first >= 224) return false;
  if (first === 100 && second >= 64 && second <= 127) return false;
  if (first === 169 && second === 254) return false;
  if (first === 172 && second >= 16 && second <= 31) return false;
  if (first === 192 && second === 168) return false;
  if (first === 198 && (second === 18 || second === 19)) return false;
  // Documentation and protocol-assignment ranges are not globally routable.
  if (first === 192 && second === 0 && (third === 0 || third === 2)) return false;
  if (first === 198 && second === 51 && third === 100) return false;
  if (first === 203 && second === 0 && third === 113) return false;
  return true;
}

function isPublicIpv6(address: string): boolean {
  const bytes = parseIpv6(address);
  if (!bytes) return false;
  if (bytes.every((byte) => byte === 0)) return false;
  if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) return false;
  if ((bytes[0] & 0xfe) === 0xfc) return false; // fc00::/7 unique-local
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return false; // fe80::/10 link-local
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0xc0) return false; // fec0::/10 site-local
  if (bytes[0] === 0xff) return false; // multicast
  if (bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff) return false;
  if (bytes.slice(0, 12).every((byte) => byte === 0)) return false; // IPv4-compatible
  if (
    bytes[0] === 0x00 &&
    bytes[1] === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b &&
    bytes.slice(4, 12).every((byte) => byte === 0)
  ) {
    return false; // 64:ff9b::/96 NAT64 embeds an IPv4 destination
  }
  if (
    bytes[0] === 0x00 &&
    bytes[1] === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b &&
    bytes[4] === 0x00 &&
    bytes[5] === 0x01
  ) {
    return false; // 64:ff9b:1::/48 local-use translation prefix
  }
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return false; // 6to4 embeds an IPv4 destination
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00) return false; // Teredo
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return false;
  return true;
}

function parseIpv6(address: string): Uint8Array | null {
  if (address.includes('%')) return null;
  let normalized = address.toLowerCase();
  if (normalized.includes('.')) {
    const finalColon = normalized.lastIndexOf(':');
    const ipv4 = normalized.slice(finalColon + 1);
    if (isIP(ipv4) !== 4) return null;
    const octets = ipv4.split('.').map(Number);
    normalized = `${normalized.slice(0, finalColon)}:${(((octets[0] ?? 0) << 8) | (octets[1] ?? 0)).toString(
      16,
    )}:${(((octets[2] ?? 0) << 8) | (octets[3] ?? 0)).toString(16)}`;
  }

  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const groups = [...left, ...Array.from({ length: missing }, () => '0'), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  const bytes = new Uint8Array(16);
  groups.forEach((group, index) => {
    const value = Number.parseInt(group, 16);
    bytes[index * 2] = value >>> 8;
    bytes[index * 2 + 1] = value & 0xff;
  });
  return bytes;
}

function unbracketHostname(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

function safeHexEquals(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'hex');
  const rightBytes = Buffer.from(right, 'hex');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function raceWithAbort<Result>(operation: Promise<Result>, signal?: AbortSignal): Promise<Result> {
  if (!signal) return operation;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortError(signal));
    signal.addEventListener('abort', abort, { once: true });
    operation.then(
      (result) => {
        signal.removeEventListener('abort', abort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

function abortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error('Quantum sync aborted');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error('Quantum sync aborted');
  error.name = 'AbortError';
  throw error;
}
