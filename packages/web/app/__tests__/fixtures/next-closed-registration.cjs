// Real installed providers and route modules. All HTTP is loopback; GC runs
// only in this isolated child, while closed responses remain deliberately held.
const assert = require('node:assert/strict');
const { AsyncLocalStorage } = require('node:async_hooks');
const { once } = require('node:events');
const { readFileSync } = require('node:fs');
const http = require('node:http');
const { createRequire } = require('node:module');
const { Socket } = require('node:net');
const { dirname, resolve } = require('node:path');
const { setImmediate: nextTurn } = require('node:timers/promises');
const vm = require('node:vm');

globalThis.AsyncLocalStorage = AsyncLocalStorage;
const webRequire = createRequire(resolve(__dirname, '../../../package.json'));
const ts = webRequire('typescript-compiler-api');
const nextRoot = dirname(webRequire.resolve('next/package.json'));
const { NodeNextResponse } = webRequire('next/dist/server/base-http/node');
const minimalServer = webRequire('next/dist/compiled/next-server/server.runtime.prod').default;
const { AppRouteRouteModule } = webRequire('next/dist/server/route-modules/app-route/module.compiled');
const ResponseCache = webRequire('next/dist/server/response-cache').default;
const { NextRequest, after } = webRequire('next/server');
const { createWorkStore } = webRequire('next/dist/server/async-storage/work-store');
const { workAsyncStorage } = webRequire('next/dist/server/app-render/work-async-storage.external');
const { afterTaskAsyncStorage } = webRequire('next/dist/server/app-render/after-task-async-storage.external');

function parseInstalled(relative) {
  return ts.createSourceFile(
    relative,
    readFileSync(resolve(nextRoot, relative), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
}

function templateProvider(relative) {
  const ast = parseInstalled(relative);
  const hooks = [];
  function visit(node) {
    if (ts.isPropertyAssignment(node) && node.name.getText(ast) === 'onClose') {
      assert.ok(ts.isArrowFunction(node.initializer));
      hooks.push(node.initializer.getText(ast));
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.equal(hooks.length, 1, `${relative}: expected one callback provider`);
  return new vm.Script(`(res) => (${hooks[0]})`, { filename: relative }).runInNewContext();
}

function esmResponseProvider() {
  const relative = 'dist/esm/server/base-http/node.js';
  const ast = parseInstalled(relative);
  const responseClass = ast.statements.find(
    (node) => ts.isClassDeclaration(node) && node.name?.text === 'NodeNextResponse',
  );
  assert.ok(responseClass);
  const methods = responseClass.members.filter(
    (node) => ts.isMethodDeclaration(node) && node.name.getText(ast) === 'onClose',
  );
  assert.equal(methods.length, 1);
  const originalMethod = new vm.Script(`({${methods[0].getText(ast)}}).onClose`, {
    filename: relative,
  }).runInNewContext();
  return (response) => (callback) => originalMethod.call({ originalResponse: response }, callback);
}

const providers = [
  ...[
    'dist/build/templates/app-page-runtime.js',
    'dist/esm/build/templates/app-page-runtime.js',
    'dist/build/templates/app-route.js',
    'dist/esm/build/templates/app-route.js',
  ].map((name) => ({ name, makeHook: templateProvider(name) })),
  {
    name: 'NodeNextResponse CJS',
    makeHook: (response) => {
      const wrapper = new NodeNextResponse(response);
      return wrapper.onClose.bind(wrapper);
    },
  },
  { name: 'NodeNextResponse ESM', makeHook: esmResponseProvider() },
  {
    name: 'minimal production response',
    makeHook: (response) => {
      const wrapper = minimalServer.prototype.normalizeRes(response);
      return wrapper.onClose.bind(wrapper);
    },
  },
];

function createResponse() {
  return new http.ServerResponse(new http.IncomingMessage(new Socket()));
}

function createStore(onClose, pending) {
  return createWorkStore({
    page: '/fixture/page',
    buildId: 'closed-registration-fixture',
    previouslyRevalidatedTags: [],
    renderOpts: {
      supportsDynamicResponse: true,
      experimental: {},
      onClose,
      waitUntil: (promise) => pending.push(promise),
    },
  });
}

async function closedResponse() {
  let resolveResponse;
  const ready = new Promise((resolve) => {
    resolveResponse = resolve;
  });
  const server = http.createServer((_request, response) => {
    response.once('close', () => resolveResponse(response));
    response.end('done');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  await new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: server.address().port, agent: false }, (incoming) => {
        incoming.resume();
        incoming.once('end', resolve);
      })
      .once('error', reject);
  });
  const response = await ready;
  await new Promise((resolve) => server.close(resolve));
  assert.equal(response.closed, true);
  return response;
}

async function lifecycle(makeHook, initialPhase, timing, alreadyClosed) {
  const response = alreadyClosed ? await closedResponse() : createResponse();
  const pending = [];
  const store = createStore(makeHook(response), pending);
  const unit = { phase: initialPhase };
  const tasks = [];
  if (timing === 'close-before-first-after' && !alreadyClosed) response.emit('close');
  workAsyncStorage.run(store, () =>
    store.afterContext.after(() => {
      tasks.push({ phase: unit.phase, rootTaskSpawnPhase: afterTaskAsyncStorage.getStore().rootTaskSpawnPhase });
    }, unit),
  );
  const inlineTasks = tasks.length;
  if (timing === 'normal') response.emit('close');
  await nextTurn();
  if (store.afterContext.isRequestClosed) {
    await Promise.all(pending);
    await store.afterContext.callbackQueue.onIdle();
  }
  return {
    inlineTasks,
    tasks,
    requestClosed: store.afterContext.isRequestClosed,
    remainingCloseListeners: response.listenerCount('close'),
  };
}

function createClosedGraph(makeHook, response) {
  const pending = [];
  const references = { stores: [], contexts: [], units: [] };
  const counters = { tasks: 0 };
  for (let index = 0; index < 4; index += 1) {
    const store = createStore(makeHook(response), pending);
    const unit = { phase: 'action' };
    workAsyncStorage.run(store, () =>
      store.afterContext.after(() => {
        counters.tasks += 1;
      }, unit),
    );
    references.stores.push(new WeakRef(store));
    references.contexts.push(new WeakRef(store.afterContext));
    references.units.push(new WeakRef(unit));
  }
  return { pending, references, counters };
}

async function measureProvider({ name, makeHook }) {
  const response = await closedResponse();
  const calls = [];
  makeHook(response)(function () {
    calls.push({ order: 'first', receiver: this === response, arguments: arguments.length });
  });
  makeHook(response)(function () {
    calls.push({ order: 'second', receiver: this === response, arguments: arguments.length });
  });
  const synchronousCalls = calls.length;
  const failure = new Error('late close failed');
  let sameError = false;
  try {
    makeHook(response)(() => {
      throw failure;
    });
  } catch (error) {
    sameError = error === failure;
  }
  const pendingClose = ['destroyed', 'writableFinished', 'both'].map((state) => {
    const open = createResponse();
    if (state !== 'writableFinished') open.destroyed = true;
    if (state !== 'destroyed') Object.defineProperty(open, 'writableFinished', { value: true });
    let callsAfterClose = 0;
    makeHook(open)(() => {
      callsAfterClose += 1;
    });
    const callsBeforeActualClose = callsAfterClose;
    open.emit('close');
    return { state, callsBeforeActualClose, callsAfterClose, remainingCloseListeners: open.listenerCount('close') };
  });
  const comparisons = {};
  for (const phase of ['render', 'action'])
    comparisons[phase] = {
      normal: await lifecycle(makeHook, phase, 'normal', false),
      ordinaryLate: await lifecycle(makeHook, phase, 'close-before-first-after', false),
      recovered: await lifecycle(makeHook, phase, 'close-before-first-after', true),
    };
  const graphResponse = await closedResponse();
  const graph = createClosedGraph(makeHook, graphResponse);
  await nextTurn();
  if (graph.counters.tasks) await Promise.all(graph.pending);
  graph.pending.length = 0;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await nextTurn();
    global.gc();
  }
  return {
    name,
    direct: { calls, synchronousCalls, sameError, remainingCloseListeners: response.listenerCount('close') },
    pendingClose,
    comparisons,
    graph: {
      responseHeld: graphResponse.closed,
      tasks: graph.counters.tasks,
      remainingCloseListeners: graphResponse.listenerCount('close'),
      surviving: Object.fromEntries(
        Object.entries(graph.references).map(([key, references]) => [
          key,
          references.filter((reference) => reference.deref()).length,
        ]),
      ),
    },
  };
}

async function actualRoute(scenario) {
  const makeHook = providers[2].makeHook;
  let releaseUserland, markLoading;
  const gate = new Promise((resolve) => {
    releaseUserland = resolve;
  });
  const loading = new Promise((resolve) => {
    markLoading = resolve;
  });
  let resolveReport, rejectReport;
  const ready = new Promise((resolve, reject) => {
    resolveReport = resolve;
    rejectReport = reject;
  });
  const tasks = [];
  const route = new AppRouteRouteModule({
    definition: {
      kind: 'APP_ROUTE',
      page: '/fixture/route',
      pathname: '/fixture',
      filename: 'fixture',
      bundlePath: 'fixture',
    },
    resolvedPagePath: '/fixture/route',
    nextConfigOutput: 'standalone',
    userland: async () => {
      markLoading();
      await gate;
      return {
        ...(scenario === 'abort' ? { dynamic: 'force-dynamic' } : { revalidate: 1 }),
        GET: () => {
          after(() => tasks.push('after'));
          return new Response('fresh');
        },
      };
    },
  });
  const cache = new ResponseCache(false);
  const stale = {
    isStale: true,
    cacheControl: { revalidate: 1, expire: 10 },
    value: { kind: 'APP_ROUTE', status: 200, body: Buffer.from('cached'), headers: {} },
  };
  const server = http.createServer(async (_request, response) => {
    try {
      const pending = [],
        registrations = [],
        actualHook = makeHook(response);
      const context = {
        params: {},
        previewProps: {},
        sharedContext: { buildId: 'closed-registration-fixture' },
        renderOpts: {
          supportsDynamicResponse: scenario === 'abort',
          experimental: {},
          cacheComponents: false,
          onClose: (callback) => {
            registrations.push(response.closed);
            actualHook(callback);
          },
          waitUntil: (promise) => pending.push(promise),
        },
      };
      response.once('close', releaseUserland);
      const render = async () => {
        await route.handle(new NextRequest('http://fixture.invalid/fixture'), context);
        await nextTurn();
        if (context.renderOpts.store.afterContext.isRequestClosed) await Promise.all(pending);
        resolveReport({
          scenario,
          responseClosed: response.closed,
          registrations,
          tasks,
          requestClosed: context.renderOpts.store.afterContext.isRequestClosed,
          remainingCloseListeners: response.listenerCount('close'),
        });
        return null;
      };
      if (scenario === 'abort') await render();
      else {
        const cached = await cache.get('/fixture', render, {
          incrementalCache: { get: async () => stale, set: async () => {} },
          routeKind: 'APP_ROUTE',
          waitUntil: () => {},
        });
        response.end(cached.value.body);
      }
    } catch (error) {
      rejectReport(error);
      response.destroy();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let body = '';
  const clientDone = new Promise((resolve, reject) => {
    const client = http.get(
      { host: '127.0.0.1', port: server.address().port, path: '/fixture', agent: false },
      (incoming) => {
        incoming.on('data', (chunk) => {
          body += chunk;
        });
        incoming.once('end', resolve);
      },
    );
    client.once('error', scenario === 'abort' ? resolve : reject);
    if (scenario === 'abort') loading.then(() => client.destroy()).catch(reject);
  });
  const report = await ready;
  await clientDone;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  return { ...report, body };
}

async function main() {
  assert.equal(typeof global.gc, 'function');
  const results = [];
  for (const provider of providers) results.push(await measureProvider(provider));
  console.log(
    JSON.stringify({ providers: results, routes: [await actualRoute('abort'), await actualRoute('stale-isr')] }),
  );
}
main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
