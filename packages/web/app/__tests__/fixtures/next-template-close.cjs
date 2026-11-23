// Execute the installed build templates' callbacks, not an adapter copied into
// this fixture. GC is confined to this isolated child; nothing listens on a port.
const assert = require('node:assert/strict');
const { AsyncLocalStorage } = require('node:async_hooks');
const { readFileSync } = require('node:fs');
const { IncomingMessage, ServerResponse } = require('node:http');
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
const { createWorkStore } = webRequire('next/dist/server/async-storage/work-store');
const { workAsyncStorage } = webRequire('next/dist/server/app-render/work-async-storage.external');
const templates = [
  'dist/build/templates/app-page-runtime.js',
  'dist/esm/build/templates/app-page-runtime.js',
  'dist/build/templates/app-route.js',
  'dist/esm/build/templates/app-route.js',
];
const RESPONSE_COUNT = 16;

function loadTemplateHook(template) {
  const source = readFileSync(resolve(nextRoot, template), 'utf8');
  const ast = ts.createSourceFile(template, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const hooks = [];
  function visit(node) {
    if (ts.isPropertyAssignment(node) && node.name.getText(ast) === 'onClose') {
      assert.ok(ts.isArrowFunction(node.initializer), `${template}: onClose must be an executable callback`);
      hooks.push(node.initializer.getText(ast));
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.equal(hooks.length, 1, `${template}: expected exactly one onClose provider`);
  // The VM evaluates only the original callback expression with its raw Node
  // response binding. Neither its registration method nor body is substituted.
  return new vm.Script(`(res) => (${hooks[0]})`, { filename: template }).runInNewContext();
}

function createResponse() {
  return new ServerResponse(new IncomingMessage(new Socket()));
}

function createStore(onClose, pending) {
  return createWorkStore({
    page: '/fixture/page',
    buildId: 'installed-template-close-fixture',
    previouslyRevalidatedTags: [],
    renderOpts: {
      supportsDynamicResponse: true,
      experimental: {},
      onClose,
      waitUntil: (promise) => pending.push(promise),
    },
  });
}

async function collectGarbage() {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await nextTurn();
    global.gc();
  }
}

const countAlive = (references) => references.filter((reference) => reference.deref() !== undefined).length;

function createNoAfterBatch(makeHook) {
  const heldResponses = [];
  const contexts = [];
  for (let index = 0; index < RESPONSE_COUNT; index += 1) {
    const response = createResponse();
    const store = createStore(makeHook(response), []);
    contexts.push(new WeakRef(store.afterContext));
    response.emit('close');
    heldResponses.push(response);
  }
  return { heldResponses, contexts };
}

async function measureNoAfter(makeHook) {
  // Return from the frame containing each store before collecting. The fixture
  // must retain only responses and WeakRefs, not its own last request graph.
  const { heldResponses, contexts } = createNoAfterBatch(makeHook);
  await collectGarbage();
  return {
    responsesHeld: heldResponses.length,
    remainingCloseListeners: heldResponses.reduce((count, response) => count + response.listenerCount('close'), 0),
    survivingAfterContexts: countAlive(contexts),
  };
}

async function measureAfterTasks(makeHook) {
  const response = createResponse();
  const onClose = makeHook(response);
  const pending = [];
  const events = [];
  const store = createStore(onClose, pending);
  const unit = { phase: 'render' };
  store.shouldTrackFetchMetrics = true;
  new NodeNextResponse(response).onClose(() => {
    store.shouldTrackFetchMetrics = false;
  });
  onClose(function () {
    events.push(this === response ? 'close:first' : 'wrong-receiver');
  });
  onClose(() => events.push('close:second'));
  workAsyncStorage.run(store, () => {
    store.afterContext.after(async () => {
      events.push(`after:first:${unit.phase}:${store.shouldTrackFetchMetrics}`);
    }, unit);
    store.afterContext.after(() => events.push(`after:second:${unit.phase}`), unit);
  });
  response.emit('finish');
  await nextTurn();
  const beforeClose = [...events];
  const phaseBeforeClose = unit.phase;
  const requestClosedBeforeClose = store.afterContext.isRequestClosed;
  response.emit('close');
  await Promise.all(pending);
  workAsyncStorage.run(store, () => {
    store.afterContext.after(() => events.push(`after:late:${unit.phase}`), unit);
  });
  await store.afterContext.callbackQueue.onIdle();
  const beforeRepeatedClose = [...events];
  response.emit('close');
  return {
    beforeClose,
    phaseBeforeClose,
    requestClosedBeforeClose,
    events,
    beforeRepeatedClose,
    phase: unit.phase,
    isRequestClosed: store.afterContext.isRequestClosed,
    fetchMetricsStopped: !store.shouldTrackFetchMetrics,
    remainingCloseListeners: response.listenerCount('close'),
  };
}

function createAfterBatch(makeHook) {
  const heldResponses = [];
  const references = { stores: [], contexts: [], units: [], markers: [] };
  const pending = [];
  const counters = { completedTasks: 0 };
  for (let index = 0; index < RESPONSE_COUNT; index += 1) {
    const response = createResponse();
    const store = createStore(makeHook(response), pending);
    const marker = { rows: Array.from({ length: 8192 }, () => index) };
    const unit = { phase: 'render', marker };
    store.marker = marker;
    workAsyncStorage.run(store, () => {
      store.afterContext.after(() => {
        assert.equal(unit.phase, 'after');
        counters.completedTasks += 1;
      }, unit);
    });
    references.stores.push(new WeakRef(store));
    references.contexts.push(new WeakRef(store.afterContext));
    references.units.push(new WeakRef(unit));
    references.markers.push(new WeakRef(marker));
    response.emit('close');
    heldResponses.push(response);
  }
  return { heldResponses, references, pending, counters };
}

async function measureHeldGraph(makeHook) {
  const { heldResponses, references, pending, counters } = createAfterBatch(makeHook);
  await Promise.all(pending);
  pending.length = 0;
  await collectGarbage();
  return {
    responsesHeld: heldResponses.length,
    completedTasks: counters.completedTasks,
    remainingCloseListeners: heldResponses.reduce((count, response) => count + response.listenerCount('close'), 0),
    surviving: Object.fromEntries(
      Object.entries(references).map(([name, weakReferences]) => [name, countAlive(weakReferences)]),
    ),
  };
}

function measureThrowingCallback(makeHook) {
  const response = createResponse();
  const failure = new Error('template close callback failed');
  makeHook(response)(() => {
    throw failure;
  });
  assert.throws(
    () => response.emit('close'),
    (error) => error === failure,
  );
  return { remainingCloseListeners: response.listenerCount('close') };
}

async function main() {
  assert.equal(typeof global.gc, 'function', 'The isolated fixture requires --expose-gc');
  const results = [];
  for (const template of templates) {
    const makeHook = loadTemplateHook(template);
    results.push({
      template,
      noAfter: await measureNoAfter(makeHook),
      lifecycle: await measureAfterTasks(makeHook),
      graph: await measureHeldGraph(makeHook),
      throwing: measureThrowingCallback(makeHook),
    });
  }
  console.log(JSON.stringify(results));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
