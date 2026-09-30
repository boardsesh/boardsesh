import { describe, expect, it } from 'vitest';
import { buildSchema, parse, validate } from 'graphql';
import { typeDefs } from '@boardsesh/shared-schema';
import { GET_BETA_LINKS } from '@boardsesh/graphql/operations/beta-links';
import { GET_BOARD_LEADERBOARD, GET_MY_BOARDS } from '@boardsesh/graphql/operations/boards';
import { SEARCH_CLIMBS, SEARCH_CLIMBS_COUNT } from '@boardsesh/graphql/operations/climb-search';
import {
  DELETE_TICK,
  GET_TICKS,
  GET_USER_ASCENTS_FEED,
  GET_USER_CLIMB_PERCENTILE,
  GET_USER_PROFILE_STATS,
  GET_USER_TICK_COUNTS_BY_BOARD,
  GET_USER_TICKS,
  SAVE_TICK,
} from '@boardsesh/graphql/operations/ticks';
import { GET_PROFILE } from './profile';
import { SEARCH_SETTERS } from './setters';

// Every document Boardz sends to the hosted backend. After an upstream merge,
// a renamed field or argument fails here instead of on the phone.
const OPERATIONS = {
  DELETE_TICK,
  GET_BETA_LINKS,
  GET_BOARD_LEADERBOARD,
  GET_MY_BOARDS,
  GET_PROFILE,
  GET_TICKS,
  GET_USER_ASCENTS_FEED,
  GET_USER_CLIMB_PERCENTILE,
  GET_USER_PROFILE_STATS,
  GET_USER_TICK_COUNTS_BY_BOARD,
  GET_USER_TICKS,
  SAVE_TICK,
  SEARCH_CLIMBS,
  SEARCH_CLIMBS_COUNT,
  SEARCH_SETTERS,
};

// Built here rather than imported, so it shares this file's copy of graphql-js.
const schema = buildSchema(typeDefs.join('\n\n'));

describe('GraphQL operations', () => {
  it.each(Object.entries(OPERATIONS))('%s matches the backend schema', (_name, document) => {
    const errors = validate(schema, parse(document)).map((error) => error.message);
    expect(errors).toEqual([]);
  });
});
