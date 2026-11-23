// Execute the installed Flight helpers against Next's real React renderer.
// Bundle helpers are extracted because the runtime does not export them.
const assert = require('node:assert/strict');
const { AsyncLocalStorage } = require('node:async_hooks');
const { getEventListeners, once } = require('node:events');
const { readFileSync, readdirSync } = require('node:fs');
const http = require('node:http');
const { createRequire } = require('node:module');
const { dirname, resolve } = require('node:path');
const { PassThrough } = require('node:stream');
const { setImmediate: nextTurn } = require('node:timers/promises');
const vm = require('node:vm');

globalThis.AsyncLocalStorage = AsyncLocalStorage;
const webRequire = createRequire(resolve(__dirname, '../../../package.json'));
const ts = webRequire('typescript-compiler-api');
const nextRoot = dirname(webRequire.resolve('next/package.json'));
const { ResponseAborted } = webRequire('next/dist/server/web/spec-extension/adapters/next-request');
const { createReactServerErrorHandler } = webRequire('next/dist/server/app-render/create-error-handler');
const { pipeNodeReadableToNodeResponse } = webRequire('next/dist/server/pipe-readable');
const { React, ReactServerDOMWebpackServer } = webRequire('next/dist/compiled/next-server/app-page.runtime.prod')
  .vendored['react-rsc'];

const artifacts = [
  'dist/server/app-render/stream-ops.node.js',
  'dist/esm/server/app-render/stream-ops.node.js',
  ...readdirSync(resolve(nextRoot, 'dist/compiled/next-server'))
    .filter((name) => /^app-page(?:-turbo)?(?:-experimental)?\.runtime\.(dev|prod)\.js$/.test(name))
    .sort()
    .map((name) => `dist/compiled/next-server/${name}`),
];

function installedFlightHelper(relative) {
  if (relative === artifacts[0]) {
    return webRequire('next/dist/server/app-render/stream-ops.node').renderToNodeFlightStream;
  }
  const ast = ts.createSourceFile(
    relative,
    readFileSync(resolve(nextRoot, relative), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const functions = [];
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.getText(ast).includes('renderToPipeableStream is not implemented')) {
      functions.push(node);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.equal(functions.length, 1, `${relative}: expected one installed Flight helper`);
  const flightHelper = functions[0];
  const context = { Error, Object, PassThrough, ResponseAborted };
  function bindConstructors(node) {
    if (ts.isNewExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const constructor = node.expression;
      if (['PassThrough', 'ResponseAborted'].includes(constructor.name.text)) {
        const namespace = constructor.expression.getText(ast);
        context[namespace] ??= {};
        context[namespace][constructor.name.text] =
          constructor.name.text === 'PassThrough' ? PassThrough : ResponseAborted;
      }
    }
    ts.forEachChild(node, bindConstructors);
  }
  bindConstructors(flightHelper);
  const functionSource = flightHelper.getText(ast).replace(/^export\s+/, '');
  return new vm.Script(`(${functionSource})`, { filename: relative }).runInNewContext(context);
}

function render(helper, element, signal) {
  const abortReasons = [];
  const errors = [];
  const reported = [];
  const onError = createReactServerErrorHandler(false, false, new Map(), (error) => reported.push(error));
  const stream = helper(
    {
      renderToPipeableStream(...args) {
        const pipeable = ReactServerDOMWebpackServer.renderToPipeableStream(...args);
        return {
          pipe: pipeable.pipe.bind(pipeable),
          abort(reason) {
            abortReasons.push(reason);
            pipeable.abort(reason);
          },
        };
      },
    },
    element,
    {},
    {
      signal,
      onError(error) {
        errors.push(error);
        return onError(error);
      },
    },
  );
  return { stream, abortReasons, errors, reported };
}

async function consume(stream) {
  const chunks = [];
  stream.on('data', (chunk) => chunks.push(chunk));
  await once(stream, 'end');
  return Buffer.concat(chunks).toString();
}

async function completion(helper) {
  const rendered = render(helper, React.createElement('p', null, 'flight-complete'));
  const body = await consume(rendered.stream);
  await nextTurn();
  return {
    complete: body.includes('flight-complete'),
    aborts: rendered.abortReasons.length,
    reported: rendered.reported.map((error) => error.message),
    closeListeners: rendered.stream.listenerCount('close'),
  };
}

function suspendedTree() {
  let release;
  let completionMarkers = 0;
  const pending = new Promise((resolvePending) => {
    release = resolvePending;
  });
  function Completed() {
    completionMarkers += 1;
    return React.createElement('p', null, 'late-render');
  }
  async function Pending() {
    await pending;
    return React.createElement(Completed);
  }
  return {
    element: React.createElement('section', null, 'flight-started', React.createElement(Pending)),
    release,
    markers: () => completionMarkers,
  };
}

async function disconnectedClient(helper) {
  const tree = suspendedTree();
  const controller = new AbortController();
  let rendered;
  let closed;
  const responseClosed = new Promise((resolveClosed) => {
    closed = resolveClosed;
  });
  const server = http.createServer((_request, response) => {
    rendered = render(helper, tree.element, controller.signal);
    rendered.stream.once('close', closed);
    void pipeNodeReadableToNodeResponse(rendered.stream, response);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let clientAborted = false;
  await new Promise((resolveRequest, rejectRequest) => {
    const client = http.get(`http://127.0.0.1:${server.address().port}`, (response) => {
      response.once('data', () => {
        clientAborted = true;
        client.destroy();
        resolveRequest();
      });
    });
    client.once('error', (error) => {
      if (!clientAborted) rejectRequest(error);
    });
  });
  await responseClosed;
  tree.release();
  await nextTurn();
  await nextTurn();
  server.closeAllConnections();
  await new Promise((resolveClose) => server.close(resolveClose));
  return {
    clientAborted,
    abortNames: rendered.abortReasons.map((error) => error.name),
    errorNames: rendered.errors.map((error) => error.name),
    reported: rendered.reported.map((error) => error.message),
    completionMarkers: tree.markers(),
    signalListeners: getEventListeners(controller.signal, 'abort').length,
  };
}

async function explicitAbort(helper) {
  const tree = suspendedTree();
  const controller = new AbortController();
  const reason = new Error('explicit-flight-abort');
  reason.name = 'AbortError';
  const rendered = render(helper, tree.element, controller.signal);
  const firstChunk = once(rendered.stream, 'data');
  rendered.stream.resume();
  await firstChunk;
  const closed = once(rendered.stream, 'close');
  controller.abort(reason);
  await closed;
  tree.release();
  await nextTurn();
  return {
    sameReason: rendered.abortReasons[0] === reason,
    aborts: rendered.abortReasons.length,
    reported: rendered.reported.map((error) => error.message),
    completionMarkers: tree.markers(),
    signalListeners: getEventListeners(controller.signal, 'abort').length,
  };
}

async function genuineFailure(helper) {
  const failure = new Error('actual-flight-render-failure');
  function Broken() {
    throw failure;
  }
  const rendered = render(helper, React.createElement(Broken));
  await consume(rendered.stream);
  return {
    sameError: rendered.reported[0] === failure,
    reported: rendered.reported.map((error) => error.message),
    aborts: rendered.abortReasons.length,
  };
}

(async () => {
  const reports = [];
  for (const artifact of artifacts) {
    const helper = installedFlightHelper(artifact);
    reports.push({
      artifact,
      completion: await completion(helper),
      disconnect: await disconnectedClient(helper),
      explicitAbort: await explicitAbort(helper),
      genuineFailure: await genuineFailure(helper),
    });
  }
  process.stdout.write(JSON.stringify(reports));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
