const { AsyncLocalStorage } = require('node:async_hooks');
const http = require('node:http');
const { once } = require('node:events');
const { setImmediate: nextTurn } = require('node:timers/promises');
globalThis.AsyncLocalStorage = AsyncLocalStorage;
const { createPublicPageLoadGuard } = require('../../../scripts/public-page-load-guard.cjs');
const { renderToNodeFlightStream } = require('next/dist/server/app-render/stream-ops.node');
const { pipeNodeReadableToNodeResponse } = require('next/dist/server/pipe-readable');
const { createReactServerErrorHandler } = require('next/dist/server/app-render/create-error-handler');
const { React, ReactServerDOMWebpackServer } = require('next/dist/compiled/next-server/app-page.runtime.prod').vendored[
  'react-rsc'
];

async function scenario(streamHeaders) {
  let release;
  let completed = 0;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  function Completed() {
    completed += 1;
    return React.createElement('p', null, 'late-render');
  }
  async function Pending() {
    await pending;
    return React.createElement(Completed);
  }
  const errors = [];
  const reported = [];
  const aborts = [];
  const onError = createReactServerErrorHandler(false, false, new Map(), (error) => reported.push(error.name));
  const guard = createPublicPageLoadGuard({
    timeoutMs: 60,
    reportIntervalMs: 0,
    readHeap: () => ({ used: 1, limit: 100 }),
  });
  const server = http.createServer(
    guard.wrap(async (_request, response) => {
      if (streamHeaders) response.write('stream-started');
      const stream = renderToNodeFlightStream(
        {
          renderToPipeableStream(...arguments_) {
            const rendered = ReactServerDOMWebpackServer.renderToPipeableStream(...arguments_);
            return {
              pipe: rendered.pipe.bind(rendered),
              abort(reason) {
                aborts.push(reason.name);
                rendered.abort(reason);
              },
            };
          },
        },
        React.createElement(Pending),
        {},
        {
          onError(error) {
            errors.push(error.name);
            return onError(error);
          },
        },
      );
      try {
        await pipeNodeReadableToNodeResponse(stream, response);
      } catch (error) {
        if (error.name !== 'ResponseAborted' && error.cause?.name !== 'ResponseAborted') throw error;
      }
    }),
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let status;
  let aborted = false;
  await new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: server.address().port, path: '/b/wall/40/view/climb' }, (response) => {
        status = response.statusCode;
        response.resume();
        response.once('aborted', () => {
          aborted = true;
          resolve();
        });
        response.once('end', resolve);
        response.once('error', (error) => {
          if (!aborted) reject(error);
        });
      })
      .once('error', reject);
  });
  await nextTurn();
  release();
  await nextTurn();
  await nextTurn();
  const stats = guard.getStats();
  guard.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  return { status, aborted, completed, errors, reported, aborts, active: stats.active, deadline: stats.deadline };
}

(async () => {
  process.stdout.write(JSON.stringify({ beforeHeaders: await scenario(false), streaming: await scenario(true) }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
