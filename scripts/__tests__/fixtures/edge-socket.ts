/// <reference types="node" />

import { createServer } from 'node:http';
import { once } from 'node:events';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { connect as connectTls, type TLSSocket } from 'node:tls';
import { pathToFileURL } from 'node:url';
import { createCertificate } from '../../../packages/web/e2e/browser-session/certificate';
import type { Edge, EdgeOptions } from '../../../packages/web/partner-oauth-e2e/edge';

const APPROVED_HOST = 'www.boardsesh.test';
type Scenario = 'connect-host' | 'connect-port' | 'upgrade-host';
type EdgeModule = { startEdge: (options: EdgeOptions) => Promise<Edge> };

function readHeaders(socket: Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    let headers = '';
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('end', onEnd);
    };
    const onData = (chunk: Buffer) => {
      headers += chunk.toString('utf8');
      if (!headers.includes('\r\n\r\n')) return;
      cleanup();
      resolve(headers);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onEnd = () => {
      cleanup();
      reject(new Error('The edge closed before sending its response headers'));
    };
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('end', onEnd);
  });
}

/** Use the browser's real CONNECT -> TLS -> upstream route, not the direct app TLS port. */
async function approvedRequest(edge: Edge, certificate: Buffer): Promise<void> {
  const tunnel = connect({ host: '127.0.0.1', port: Number(new URL(edge.proxyServer).port) });
  let secure: TLSSocket | undefined;
  try {
    await once(tunnel, 'connect');
    const connected = readHeaders(tunnel);
    tunnel.write(`CONNECT ${APPROVED_HOST}:443 HTTP/1.1\r\nHost: ${APPROVED_HOST}:443\r\n\r\n`);
    if (!(await connected).startsWith('HTTP/1.1 200 Connection Established'))
      throw new Error('The edge refused an approved CONNECT request');
    secure = connectTls({ socket: tunnel, servername: APPROVED_HOST, ca: certificate });
    await once(secure, 'secureConnect');
    const response = new Promise<string>((resolve, reject) => {
      let contents = '';
      secure!.on('data', (chunk: Buffer) => {
        contents += chunk.toString('utf8');
      });
      secure!.once('error', reject);
      secure!.once('end', () => resolve(contents));
    });
    secure.write(`GET /healthy HTTP/1.1\r\nHost: ${APPROVED_HOST}\r\nConnection: close\r\n\r\n`);
    const contents = await response;
    const separator = contents.indexOf('\r\n\r\n');
    if (!contents.startsWith('HTTP/1.1 200') || separator < 0 || contents.slice(separator + 4) !== 'healthy')
      throw new Error('The approved tunnel did not return the upstream response');
  } finally {
    secure?.destroy();
    tunnel.destroy();
  }
}

async function main(): Promise<void> {
  const [edgePath, scenarioText, resetMode, certificateDirectory] = process.argv.slice(2);
  if (
    !edgePath ||
    !certificateDirectory ||
    !scenarioText ||
    !['connect-host', 'connect-port', 'upgrade-host'].includes(scenarioText)
  )
    throw new Error('Expected edge module, socket scenario, reset mode and certificate directory');
  const scenario = scenarioText as Scenario;
  if (resetMode !== (scenario === 'upgrade-host' ? 'peer-close' : 'peer-reset'))
    throw new Error('Unknown fixture reset mode');
  const { startEdge } = (await import(pathToFileURL(edgePath).href)) as EdgeModule;
  const certificate = createCertificate(certificateDirectory);
  const upstream = createServer((_request, response) => response.end('healthy'));
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const upstreamPort = (upstream.address() as AddressInfo).port;
  const edge = await startEdge({ ...certificate, upstreams: { [APPROVED_HOST]: upstreamPort } });
  let client: Socket | undefined;
  let protocolRefused = false;
  const clientState: { failure?: NodeJS.ErrnoException } = {};
  try {
    const isUpgrade = scenario === 'upgrade-host';
    client = isUpgrade
      ? connectTls({ host: '127.0.0.1', port: edge.appPort, servername: APPROVED_HOST, ca: certificate.cert })
      : connect({ host: '127.0.0.1', port: Number(new URL(edge.proxyServer).port) });
    // Handle only the fixture client. The real edge socket has no test listener
    // or exception hook, so the old CONNECT implementation exits on peer reset.
    client.on('error', (error: NodeJS.ErrnoException) => {
      clientState.failure = error;
    });
    await once(client, isUpgrade ? 'secureConnect' : 'connect');
    if (isUpgrade) {
      let response = '';
      client.on('data', (chunk: Buffer) => {
        response += chunk.toString('utf8');
      });
      const closed = new Promise<void>((resolve) => client!.once('close', () => resolve()));
      client.write(
        'GET /fixture-upgrade HTTP/1.1\r\nHost: refused.boardsesh.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
      );
      await closed;
      protocolRefused = response.length === 0;
      if (!protocolRefused) throw new Error('The edge did not refuse the unknown upgrade host');
    } else {
      const reply = readHeaders(client);
      const target = scenario === 'connect-port' ? `${APPROVED_HOST}:80` : 'refused.boardsesh.test:443';
      client.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
      protocolRefused = (await reply).startsWith('HTTP/1.1 403 Forbidden');
      if (!protocolRefused) throw new Error('The edge did not refuse the CONNECT request');
      client.resetAndDestroy();
      // Give the real loopback RST a turn to reach the server's readable half.
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    if (clientState.failure && clientState.failure.code !== 'ECONNRESET') throw clientState.failure;
    await approvedRequest(edge, certificate.cert);
  } finally {
    client?.destroy();
    await edge.close();
    if (upstream.listening) await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
  process.stdout.write(
    `${JSON.stringify({ scenario, resetMode, protocolRefused, healthyStatus: 200, closed: true })}\n`,
  );
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
