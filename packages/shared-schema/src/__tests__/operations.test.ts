import { describe, expect, it } from 'vite-plus/test';
import { buildSchema, parse, validate } from 'graphql';
import { EVENTS_REPLAY, QUEUE_UPDATES, typeDefs } from '../index';

describe('shared GraphQL operations', () => {
  const schema = buildSchema(typeDefs.join('\n'));

  it.each([
    ['QueueUpdates', QUEUE_UPDATES],
    ['EventsReplay', EVENTS_REPLAY],
  ])('validates %s against the schema', (_name, operation) => {
    const errors = validate(schema, parse(operation));

    expect(errors.map((error) => error.message)).toEqual([]);
  });
});
