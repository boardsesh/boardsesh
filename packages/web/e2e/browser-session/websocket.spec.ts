import { APP_HOST, APP_ORIGIN, WS_HOST } from './stack';
import { expect, test } from './fixtures';

/**
 * The app tab's own WebSocket, through the proxy and the TLS edge: from a page
 * on https://app.boardsesh.test, `wss://ws.boardsesh.test/graphql` completes the
 * upgrade (the backend checks the page's Origin) and answers connection_init
 * with connection_ack, in both engines. The Phase B specs rely on this being the
 * path the app's GraphQL-WS client takes.
 */

test(`the app tab opens wss://${WS_HOST}/graphql and receives a connection ack`, async ({ page }) => {
  await page.goto(`${APP_ORIGIN}/`, { waitUntil: 'domcontentloaded' });
  expect(new URL(page.url()).host).toBe(APP_HOST);

  const message = await page.evaluate(
    (url) =>
      new Promise<{ type: string }>((resolve, reject) => {
        const socket = new WebSocket(url, 'graphql-transport-ws');
        const timer = setTimeout(() => reject(new Error('no connection_ack within 20 s')), 20_000);
        socket.onopen = () => socket.send(JSON.stringify({ type: 'connection_init', payload: {} }));
        socket.onmessage = (event) => {
          clearTimeout(timer);
          socket.close();
          resolve(JSON.parse(String(event.data)) as { type: string });
        };
        socket.onerror = () => {
          clearTimeout(timer);
          reject(new Error('the WebSocket failed to open'));
        };
      }),
    `wss://${WS_HOST}/graphql`,
  );
  expect(message.type).toBe('connection_ack');
});
