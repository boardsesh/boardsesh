import { once } from 'node:events';
import { request } from 'node:http';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';

/**
 * www's private channel to the backend under `better-auth`
 * (`CURRENT_STORE_AUTH_BACKEND_ORIGIN`). The transport takes plain http only
 * from a loopback origin under NODE_ENV development or test
 * (`trustedAuthOrigin`), so the production build of www, like production,
 * needs https. This relay terminates TLS on 127.0.0.1 with the run's
 * certificate, which www trusts through NODE_EXTRA_CA_CERTS, and passes each
 * request to the backend unchanged. It adds no forwarding header and logs
 * nothing: the private commands carry the RPC secret and passwords.
 */
export async function startBackendRelay(
  certificate: { key: Buffer; cert: Buffer },
  backendPort: number,
): Promise<{ server: Server; origin: string }> {
  const server = createServer({ key: certificate.key, cert: certificate.cert }, (incoming, outgoing) => {
    const upstream = request(
      {
        host: '127.0.0.1',
        port: backendPort,
        method: incoming.method,
        path: incoming.url,
        headers: { ...incoming.headers, host: `127.0.0.1:${backendPort}` },
        agent: false,
      },
      (response) => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(outgoing);
      },
    );
    upstream.on('error', () => {
      if (!outgoing.headersSent) outgoing.writeHead(502, { 'content-type': 'application/json' });
      outgoing.end('{"error":"relay"}');
    });
    incoming.pipe(upstream);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, origin: `https://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
