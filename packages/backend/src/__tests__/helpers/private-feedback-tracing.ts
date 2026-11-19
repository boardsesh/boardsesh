import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import * as Sentry from '@sentry/node';
import type { Plugin } from 'graphql-yoga';

const envelopes: unknown[] = [];
// Capture everything in memory. A fresh process lets the real SDK instrument
// GraphQL on first load, before Yoga imports its parser.
Sentry.init({
  dsn: 'http://public@127.0.0.1:1/1',
  sendDefaultPii: false,
  tracesSampleRate: 1,
  integrations: [Sentry.requestDataIntegration({ include: { data: false } })],
  transport: () => ({
    send: async (envelope) => {
      envelopes.push(envelope);
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
  Sentry.captureException(new Error('Fixed diagnostic control'));
  await Sentry.flush(5000);
  const sent = JSON.stringify(envelopes);
  assert.match(sent, /graphql\.source/);
  assert.match(sent, /"transaction":"POST \/graphql \(query PublicControl\)"/);
  assert.match(sent, /Fixed diagnostic control/);
  assert.ok(!sent.includes(marker), 'Private document reached an SDK envelope');
} finally {
  await Sentry.close(1000);
}
