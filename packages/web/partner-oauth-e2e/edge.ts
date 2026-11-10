import { once } from 'node:events';
import {
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from 'node:http';
import { createServer as createHttpsServer, request as httpsRequest, type Server as HttpsServer } from 'node:https';
import { connect, type AddressInfo, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';

/**
 * A stand-in for Cloudflare and Railway in front of www and the backend.
 *
 * The www consent page calls https://api.boardsesh.com and requires the exact
 * origin https://www.boardsesh.com, and the session cookie it relies on is set
 * for `.boardsesh.com`. Those are production names on port 443, so the browser
 * has to believe it is talking to them. It does, through a local HTTP proxy that
 * tunnels only those hosts into a TLS server with a self-signed certificate.
 * Every other host is refused, so nothing in the test can reach the real sites.
 *
 * Like the real edge, it terminates TLS, overwrites any forwarding header the
 * client sent, and appends the client's address as `X-Forwarded-For`, which the
 * backend trusts from a private peer.
 */

/** Documentation addresses (RFC 5737), never routed: one for the climber's browser, one for the app's server. */
export const BROWSER_CLIENT_ADDRESS = '198.51.100.7';
export const APP_SERVER_CLIENT_ADDRESS = '203.0.113.9';

/** Hop-by-hop and forwarding headers the edge never passes on as the client sent them. */
const DROPPED_REQUEST_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authorization',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'cf-connecting-ip',
]);
const DROPPED_RESPONSE_HEADERS = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'trailer']);

export interface EdgeOptions {
  key: Buffer;
  cert: Buffer;
  /** Host name to the local port that serves it. */
  upstreams: Record<string, number>;
  /**
   * Path prefixes refused per host. The pages believe they are on production,
   * so the browser's Sentry reports through www's `/monitoring` tunnel, and the
   * local server would forward that to the real Sentry project. The edge stops it.
   */
  refusedPathPrefixes?: Record<string, readonly string[]>;
}

export interface Edge {
  /** The browser's proxy, `http://127.0.0.1:<port>`. */
  proxyServer: string;
  /** The TLS port a server-side caller connects to directly. */
  appPort: number;
  close(): Promise<void>;
}

function hostnameOf(hostHeader: string | undefined): string {
  return (hostHeader ?? '').trim().toLowerCase().replace(/:443$/, '');
}

function forwardedHeaders(
  headers: IncomingHttpHeaders,
  hostname: string,
  clientAddress: string,
  keep: ReadonlySet<string> = new Set(),
): OutgoingHttpHeaders {
  const forwarded: OutgoingHttpHeaders = {};
  for (const [name, headerValue] of Object.entries(headers)) {
    if (headerValue === undefined) continue;
    if (DROPPED_REQUEST_HEADERS.has(name) && !keep.has(name)) continue;
    forwarded[name] = headerValue;
  }
  forwarded['x-forwarded-for'] = clientAddress;
  forwarded['x-forwarded-proto'] = 'https';
  forwarded['x-forwarded-host'] = hostname;
  return forwarded;
}

function tlsServer(options: EdgeOptions, clientAddress: string, sockets: Set<Socket>): HttpsServer {
  const server = createHttpsServer({ key: options.key, cert: options.cert }, (incoming, outgoing) =>
    forward(options, clientAddress, incoming, outgoing),
  );
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  // Next's dev server keeps a WebSocket open for hot reload; pass upgrades straight through.
  server.on('upgrade', (incoming: IncomingMessage, clientSocket: Duplex, head: Buffer) => {
    const hostname = hostnameOf(incoming.headers.host);
    const port = options.upstreams[hostname];
    if (!port) {
      clientSocket.destroy();
      return;
    }
    const upstream = connect(port, '127.0.0.1', () => {
      const headers = forwardedHeaders(incoming.headers, hostname, clientAddress, new Set(['connection', 'upgrade']));
      const lines = [`${incoming.method} ${incoming.url} HTTP/1.1`];
      for (const [name, headerValue] of Object.entries(headers)) {
        for (const single of Array.isArray(headerValue) ? headerValue : [headerValue]) lines.push(`${name}: ${single}`);
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    const destroyBoth = () => {
      upstream.destroy();
      clientSocket.destroy();
    };
    upstream.on('error', destroyBoth);
    clientSocket.on('error', destroyBoth);
  });
  return server;
}

function isRefused(options: EdgeOptions, hostname: string, url: string | undefined): boolean {
  const pathname = (url ?? '/').split('?')[0];
  return (options.refusedPathPrefixes?.[hostname] ?? []).some((prefix) => pathname.startsWith(prefix));
}

function forward(options: EdgeOptions, clientAddress: string, incoming: IncomingMessage, outgoing: ServerResponse) {
  const hostname = hostnameOf(incoming.headers.host);
  const port = options.upstreams[hostname];
  if (!port) {
    outgoing.writeHead(421, { 'content-type': 'text/plain' });
    outgoing.end('This edge only serves the Boardsesh test hosts.');
    return;
  }
  if (isRefused(options, hostname, incoming.url)) {
    incoming.resume();
    outgoing.writeHead(403, { 'content-type': 'text/plain' });
    outgoing.end('Refused by the test edge: this path would leave the machine.');
    return;
  }
  const upstream = httpRequest(
    {
      host: '127.0.0.1',
      port,
      method: incoming.method,
      path: incoming.url,
      headers: forwardedHeaders(incoming.headers, hostname, clientAddress),
      agent: false,
    },
    (response) => {
      const headers: OutgoingHttpHeaders = {};
      for (const [name, headerValue] of Object.entries(response.headers)) {
        if (headerValue !== undefined && !DROPPED_RESPONSE_HEADERS.has(name)) headers[name] = headerValue;
      }
      outgoing.writeHead(response.statusCode ?? 502, headers);
      response.pipe(outgoing);
    },
  );
  upstream.on('error', () => {
    if (!outgoing.headersSent) outgoing.writeHead(502, { 'content-type': 'text/plain' });
    outgoing.end('The upstream server did not answer.');
  });
  incoming.pipe(upstream);
}

async function listen(server: HttpsServer | ReturnType<typeof createHttpServer>): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as AddressInfo).port;
}

export async function startEdge(options: EdgeOptions): Promise<Edge> {
  const sockets = new Set<Socket>();
  const browserTls = tlsServer(options, BROWSER_CLIENT_ADDRESS, sockets);
  const appTls = tlsServer(options, APP_SERVER_CLIENT_ADDRESS, sockets);
  const browserTlsPort = await listen(browserTls);
  const appPort = await listen(appTls);

  // Plain HTTP through the proxy is refused: every Boardsesh host is HTTPS only.
  const proxy = createHttpServer((_request, response) => {
    response.writeHead(403, { 'content-type': 'text/plain' });
    response.end('This proxy only tunnels HTTPS to the Boardsesh test hosts.');
  });
  proxy.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  proxy.on('connect', (request: IncomingMessage, clientSocket: Duplex, head: Buffer) => {
    const [hostname, port] = (request.url ?? '').toLowerCase().split(':');
    if (port !== '443' || !(hostname in options.upstreams)) {
      clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const tunnel = connect(browserTlsPort, '127.0.0.1', () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) tunnel.write(head);
      tunnel.pipe(clientSocket);
      clientSocket.pipe(tunnel);
    });
    const destroyBoth = () => {
      tunnel.destroy();
      clientSocket.destroy();
    };
    tunnel.on('error', destroyBoth);
    clientSocket.on('error', destroyBoth);
  });
  const proxyPort = await listen(proxy);

  return {
    proxyServer: `http://127.0.0.1:${proxyPort}`,
    appPort,
    async close() {
      for (const socket of sockets) socket.destroy();
      await Promise.all(
        [browserTls, appTls, proxy].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
      );
    },
  };
}

export interface EdgeFetchOptions {
  method?: string;
  headers?: Record<string, string> | Headers;
  body?: string | URLSearchParams | null;
}

/**
 * The partner app's server calling https://api.boardsesh.com: a real TLS
 * connection to the edge, with the edge's certificate as its only trust anchor.
 * Shaped to be oauth4webapi's `customFetch`.
 */
export function edgeFetch(appPort: number, certificatePem: string, allowedHosts: readonly string[]) {
  return (url: string | URL, options: EdgeFetchOptions = {}): Promise<Response> =>
    new Promise((resolve, reject) => {
      const target = new URL(url);
      if (target.protocol !== 'https:' || !allowedHosts.includes(target.hostname)) {
        reject(new Error(`The app only talks to Boardsesh; refused ${target.origin}`));
        return;
      }
      const headers = new Headers(options.headers);
      const body = options.body === undefined || options.body === null ? undefined : String(options.body);
      if (body !== undefined) headers.set('content-length', String(Buffer.byteLength(body)));
      headers.set('host', target.host);
      const outgoing = httpsRequest(
        {
          host: '127.0.0.1',
          port: appPort,
          servername: target.hostname,
          ca: certificatePem,
          method: options.method ?? 'GET',
          path: `${target.pathname}${target.search}`,
          headers: Object.fromEntries(headers.entries()),
          agent: false,
        },
        (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
          incoming.on('error', reject);
          incoming.on('end', () => {
            const responseHeaders = new Headers();
            for (const [name, headerValue] of Object.entries(incoming.headers)) {
              if (headerValue === undefined) continue;
              for (const single of Array.isArray(headerValue) ? headerValue : [headerValue]) {
                responseHeaders.append(name, single);
              }
            }
            const status = incoming.statusCode ?? 0;
            const bodyless = status === 204 || status === 304;
            resolve(new Response(bodyless ? null : Buffer.concat(chunks), { status, headers: responseHeaders }));
          });
        },
      );
      outgoing.on('error', reject);
      outgoing.end(body);
    });
}
