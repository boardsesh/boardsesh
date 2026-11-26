const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const http = require('node:http');
const { once } = require('node:events');

async function child() {
  require('../../../scripts/public-page-load-guard-preload.cjs');
  const routerPath = require.resolve('next/dist/server/lib/router-server');
  let continueRender;
  const pending = new Promise((resolve) => {
    continueRender = resolve;
  });
  process.on('message', (message) => {
    if (message === 'continue') continueRender();
  });
  // Exercise the installed Next server's actual signal/close sequence with a
  // controlled route. Production component retention is tested by the soak.
  require.cache[routerPath] = {
    id: routerPath,
    filename: routerPath,
    loaded: true,
    exports: {
      initialize: async () => ({
        distDir: '.next',
        requestHandler: async (_request, response) => {
          response.write('start');
          process.send({ type: 'render-started' });
          await pending;
          response.end('end');
        },
        upgradeHandler: () => {},
        server: { close: async () => process.send({ type: 'next-closed' }) },
      }),
    },
  };
  const { startServer } = require('next/dist/server/lib/start-server');
  await startServer({ dir: process.cwd(), hostname: '127.0.0.1', port: 0, isDev: false });
  process.send({ type: 'ready', port: Number(process.env.PORT) });
}

async function parent() {
  const server = fork(__filename, [], {
    env: { ...process.env, NODE_OPTIONS: '', PUBLIC_GUARD_CHILD: '1' },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  server.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const events = [];
  const ready = new Promise((resolve) =>
    server.on('message', (message) => {
      events.push(message.type);
      if (message.type === 'ready') resolve(message.port);
      if (message.type === 'render-started') {
        server.kill('SIGTERM');
        setTimeout(() => server.send('continue'), 25);
      }
    }),
  );
  const exited = once(server, 'exit');
  const port = await ready;
  const body = await new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: '/setter/person' }, (response) => {
        let contents = '';
        response.on('data', (chunk) => {
          contents += chunk;
        });
        response.once('error', reject);
        response.once('end', () => resolve(contents));
      })
      .once('error', reject);
  });
  const [code, signal] = await exited;
  assert.equal(stderr, '');
  process.stdout.write(JSON.stringify({ body, code, signal, nextClosed: events.includes('next-closed') }));
}

(process.env.PUBLIC_GUARD_CHILD === '1' ? child() : parent()).catch((error) => {
  console.error(error);
  process.exit(1);
});
