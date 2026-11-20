import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import * as Sentry from '@sentry/node';
import type { Plugin } from 'graphql-yoga';
import { privateFeedbackDiagnosticHooks } from '../../lib/private-feedback-diagnostics';

const envelopes: unknown[] = [];
const events: Sentry.Event[] = [];
// Capture everything in memory. A fresh process lets the real SDK instrument
// GraphQL on first load, before Yoga imports its parser.
Sentry.init({
  ...privateFeedbackDiagnosticHooks,
  dsn: 'http://public@127.0.0.1:1/1',
  sendDefaultPii: false,
  tracesSampleRate: 1,
  integrations: [Sentry.requestDataIntegration({ include: { data: false } })],
  transport: () => ({
    send: async (envelope) => {
      envelopes.push(envelope);
      for (const [header, payload] of envelope[1]) {
        if (header.type === 'event' || header.type === 'transaction') events.push(payload as Sentry.Event);
      }
      return { statusCode: 200 };
    },
    flush: async () => true,
  }),
});
try {
  const require = createRequire(import.meta.url);
  const { createSchema, createYoga } = require('graphql-yoga') as typeof import('graphql-yoga');
  const { execute } = require('graphql') as typeof import('graphql');
  const { privateBoardOperationPrivacyPlugin } = await import('../../graphql/private-board-operation');
  const instrumentedExecutor: Plugin = { onExecute: ({ setExecuteFn }) => setExecuteFn(execute) };
  const yoga = createYoga({
    schema: createSchema({
      typeDefs:
        'type Query { publicBoard: Boolean!, adminAppFeedback(search: String): Boolean! } type Mutation { submitBoardRequest(note: String): Boolean! }',
      resolvers: {
        Query: { publicBoard: () => true, adminAppFeedback: () => true },
        Mutation: { submitBoardRequest: () => true },
      },
    }),
    logging: false,
    // Yoga supports several executors. Exercise the SDK-instrumented GraphQL
    // executor as well as its parser so root operation names are tested.
    plugins: [privateBoardOperationPrivacyPlugin(), instrumentedExecutor],
  });
  // Runtime markers cannot be mistaken for the SDK's error stack source context.
  const marker = 'PrivateFixture' + randomUUID().replaceAll('-', '');
  for (const [valid, query] of [
    [true, 'query PublicControl { publicBoard }'],
    [true, `mutation ${marker}Submit { ${marker}Alias: submitBoardRequest(note: "${marker}Note") } # ${marker}Comment`],
    [true, `query ${marker}Read { ${marker}Search: adminAppFeedback(search: "${marker}Term") } # ${marker}ReadComment`],
    [false, `mutation ${marker}Validation { submitBoardRequest(note: ["${marker}Invalid"]) }`],
  ] as const) {
    await Sentry.startSpan({ name: 'POST /graphql', op: 'http.server', forceTransaction: true }, async () => {
      const result = await yoga.fetch('http://localhost/graphql', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query }),
      });
      const body = (await result.json()) as { data?: unknown; errors?: unknown[] };
      if (valid) assert.ok(body.data);
      else assert.ok(body.errors?.length);
    });
  }
  // The HTTP integration captures the URL before the GraphQL executor starts.
  const { createServer } = require('node:http') as typeof import('node:http');
  const publicGetName = 'PublicGetFixture' + randomUUID().replaceAll('-', '');
  const privateGetMarker = 'PrivateSearch' + randomUUID().replaceAll('-', '');
  const server = createServer((request, response) => {
    Sentry.captureException(new Error('Fixed GET fixture failure'));
    void yoga(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const { execFile } = require('node:child_process') as typeof import('node:child_process');
    const { promisify } = require('node:util') as typeof import('node:util');
    for (const [query, variables] of [
      [`query ${publicGetName} { publicBoard }`, {}],
      [
        'query RequestList($term:String!) { ...ReadFeedback } fragment ReadFeedback on Query { inbox:adminAppFeedback(search:$term) }',
        { term: privateGetMarker },
      ],
    ] as const) {
      const url = new URL(`http://127.0.0.1:${address.port}/graphql`);
      url.search = new URLSearchParams({ query, variables: JSON.stringify(variables) }).toString();
      // A separate uninstrumented client keeps the receipt limited to the server.
      const { stdout } = await promisify(execFile)(process.execPath, [
        '-e',
        'fetch(process.argv[1]).then(r=>r.json()).then(v=>console.log(JSON.stringify(v)))',
        url.href,
      ]);
      assert.ok((JSON.parse(stdout) as { data?: unknown }).data);
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  Sentry.captureException(new Error('Fixed diagnostic control'));
  await Sentry.flush(5000);
  const sent = JSON.stringify(envelopes);
  assert.match(sent, /graphql\.source/);
  assert.match(sent, /"transaction":"POST \/graphql \(query PublicControl\)"/);
  assert.match(sent, /Fixed diagnostic control/);
  for (const type of [undefined, 'transaction'] as const) {
    assert.ok(
      events.some((event) => event.type === type && event.request?.url?.includes(publicGetName)),
      'Normal GET keeps its HTTP context',
    );
  }
  assert.ok(!sent.includes(privateGetMarker), 'Private GET search reached an HTTP envelope');
  const diagnostic = events.find((event) => event.message === 'Private feedback HTTP request failed');
  assert.ok(diagnostic?.event_id && !diagnostic.request && !diagnostic.breadcrumbs);

  assert.ok(!sent.includes(marker), 'Private document reached an SDK envelope');
} finally {
  await Sentry.close(1000);
}
