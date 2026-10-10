import { CONFIRM_CLIMB_ON_WALL } from '../../packages/shared/graphql/src/operations/queue-session';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  canonicalCampaignDocument,
  campaignNamedBoardJoinResponse,
  isCampaignPushRegistration,
  isCampaignWallConfirmation,
  NATIVE_CAMPAIGN_JOIN_QUERY,
  NATIVE_CAMPAIGN_QUEUE_QUERY,
  NATIVE_CAMPAIGN_REGISTER_QUERY,
  replayCampaignSessionResponse,
} from '../lib/screenshot-campaign-session';
import type { GraphqlFixtureFile } from '../lib/screenshot-fixtures';
const fixture = (
  operationName: string,
  query: string,
  variables: Record<string, unknown>,
  response: unknown,
): GraphqlFixtureFile => ({
  formatVersion: 1,
  operationName,
  query,
  variables,
  response,
  documentHash: '',
  variablesHash: '',
  status: 200,
  recordedAt: '2026-09-19T14:39:54Z',
  upstream: 'https://ws.boardsesh.com',
});
const joinFixture = () =>
  fixture(
    'JoinSession',
    'mutation JoinSession { joinSession { id clientId boardPath } }',
    { sessionId: 'crew', boardPath: 'kilter/8/25/26,27/35' },
    { data: { joinSession: { id: 'crew', clientId: 'recorded-client', boardPath: 'kilter/8/25/26,27/35' } } },
  );
describe('campaign native session replay', () => {
  it('pins native wire documents to the Swift implementation', () => {
    const swift = readFileSync('packages/mobile/modules/live-activity/ios/SessionWebSocketManager.swift', 'utf8');
    const docs = [...swift.matchAll(/let query = """\n([\s\S]*?)\n        """/g)].map((match) =>
      canonicalCampaignDocument(match[1]),
    );
    expect(docs).toContain(canonicalCampaignDocument(NATIVE_CAMPAIGN_JOIN_QUERY));
    expect(docs).toContain(canonicalCampaignDocument(NATIVE_CAMPAIGN_QUEUE_QUERY));
  });
  it('projects recorded native identity only for the same session and board configuration', () => {
    const variables = { sessionId: 'crew', boardPath: '/kilter/8/25/26,27/0' };
    expect(replayCampaignSessionResponse(NATIVE_CAMPAIGN_JOIN_QUERY, variables, joinFixture())).toEqual({
      response: { data: { joinSession: { id: 'crew', clientId: 'recorded-client' } } },
    });
    for (const changed of [
      { ...variables, sessionId: 'other' },
      { ...variables, boardPath: '/kilter/9/25/26,27/0' },
      { ...variables, boardPath: '/kilter/8/25/26,27/40' },
      { ...variables, username: 'new' },
    ])
      expect(replayCampaignSessionResponse(NATIVE_CAMPAIGN_JOIN_QUERY, changed, joinFixture())).toBeNull();
    expect(
      replayCampaignSessionResponse(
        NATIVE_CAMPAIGN_JOIN_QUERY.replace('clientId', 'boardPath'),
        variables,
        joinFixture(),
      ),
    ).toBeNull();
    const missing = joinFixture();
    missing.response = { data: { joinSession: { id: 'crew' } } };
    expect(replayCampaignSessionResponse(NATIVE_CAMPAIGN_JOIN_QUERY, variables, missing)).toBeNull();
  });
  it('accepts equivalent field order while rejecting changed arguments', () => {
    const query =
      'subscription QueueUpdates($sessionId: ID!) { queueUpdates(sessionId: $sessionId) { __typename ... on FullSync { sequence state { sequence stateHash } } } }';
    const recorded = fixture(
      'QueueUpdates',
      query,
      { sessionId: 'crew' },
      {
        data: { queueUpdates: { __typename: 'FullSync', sequence: 1, state: { sequence: 1, stateHash: 'recorded' } } },
      },
    );
    expect(
      replayCampaignSessionResponse(
        query.replace('sequence stateHash', 'stateHash sequence'),
        { sessionId: 'crew' },
        recorded,
      ),
    ).toEqual({ response: recorded.response });
    expect(
      replayCampaignSessionResponse(
        query.replace('sessionId: $sessionId', 'sessionId: "other"'),
        { sessionId: 'crew' },
        recorded,
      ),
    ).toBeNull();
  });
  it('projects native FullSync and refuses missing recorded fields', () => {
    const item = {
      uuid: 'recorded-item',
      addedBy: 'recorded-climber',
      suggested: false,
      climb: {
        uuid: 'recorded-climb',
        setter_username: 'Setter',
        name: 'Recorded climb',
        frames: 'p1r1',
        framesCount: 1,
        framesPace: 0,
        angle: 35,
        ascensionist_count: 20,
        difficulty: 16,
        quality_average: '3',
        stars: 3,
        difficulty_error: null,
        mirrored: false,
        benchmark_difficulty: null,
      },
    };
    const response = {
      data: {
        queueUpdates: {
          __typename: 'FullSync',
          sequence: 1,
          state: { sequence: 1, stateHash: 'recorded', queue: [item], currentClimbQueueItem: item, extra: 'omit' },
        },
      },
    };
    const recorded = fixture(
      'QueueUpdates',
      'subscription QueueUpdates { queueUpdates { __typename } }',
      { sessionId: 'crew' },
      response,
    );
    expect(replayCampaignSessionResponse(NATIVE_CAMPAIGN_QUEUE_QUERY, { sessionId: 'crew' }, recorded)).toEqual({
      response: {
        data: {
          queueUpdates: {
            __typename: 'FullSync',
            sequence: 1,
            state: { sequence: 1, stateHash: 'recorded', queue: [item], currentClimbQueueItem: item },
          },
        },
      },
    });
    delete (response.data.queueUpdates.state as Partial<typeof response.data.queueUpdates.state>).stateHash;
    expect(replayCampaignSessionResponse(NATIVE_CAMPAIGN_QUEUE_QUERY, { sessionId: 'crew' }, recorded)).toBeNull();
  });
  it('prepares only proven named-board aliases with identical session identity', () => {
    const recorded = joinFixture();
    const variables = { sessionId: 'crew', boardPath: '/b/recorded-board/35' };
    const board = { slug: 'recorded-board', boardType: 'kilter', layoutId: 8, sizeId: 25, setIds: '27,26', angle: 35 };
    const expected = {
      data: { joinSession: { id: 'crew', clientId: 'recorded-client', boardPath: variables.boardPath } },
    };
    expect(campaignNamedBoardJoinResponse(recorded.query, variables, recorded, [board])).toEqual({
      response: expected,
    });
    for (const boards of [
      [],
      [board, board],
      [{ ...board, layoutId: 9 }],
      [{ ...board, setIds: '26' }],
      [{ ...board, angle: 40 }],
    ])
      expect(campaignNamedBoardJoinResponse(recorded.query, variables, recorded, boards)).toBeNull();
    for (const changed of [
      { ...variables, boardPath: '/b/recorded-board/40' },
      { ...variables, sessionId: 'other' },
      { ...variables, initialQueue: [] },
    ])
      expect(campaignNamedBoardJoinResponse(recorded.query, changed, recorded, [board])).toBeNull();
    expect(
      campaignNamedBoardJoinResponse(recorded.query.replace('clientId', 'extra'), variables, recorded, [board]),
    ).toBeNull();
  });

  it('recognizes hardware confirmation only for a recorded crew climb on the same board', () => {
    const queue = fixture(
      'QueueUpdates',
      NATIVE_CAMPAIGN_QUEUE_QUERY,
      { sessionId: 'crew' },
      {
        data: {
          queueUpdates: {
            state: { queue: [{ uuid: 'item', climb: { uuid: 'climb', boardType: 'kilter', layoutId: 8 } }] },
          },
        },
      },
    );
    expect(isCampaignWallConfirmation(CONFIRM_CLIMB_ON_WALL, { climbUuid: 'climb' }, queue, joinFixture())).toBe(true);
    for (const variables of [
      { climbUuid: 'missing' },
      { climbUuid: 'climb', queueItemUuid: 'other' },
      { climbUuid: 'climb', boardPath: 'other' },
    ])
      expect(isCampaignWallConfirmation(CONFIRM_CLIMB_ON_WALL, variables, queue, joinFixture())).toBe(false);
    const wrong = joinFixture();
    wrong.variables = { sessionId: 'crew', boardPath: 'tension/10/6/1/35' };
    expect(isCampaignWallConfirmation(CONFIRM_CLIMB_ON_WALL, { climbUuid: 'climb' }, queue, wrong)).toBe(false);
    expect(
      isCampaignWallConfirmation(
        CONFIRM_CLIMB_ON_WALL.replace('climbUuid: $climbUuid', 'climbUuid: "other"'),
        { climbUuid: 'climb' },
        queue,
        joinFixture(),
      ),
    ).toBe(false);
  });

  it('recognizes only the exact native APNs registration operation', () => {
    expect(isCampaignPushRegistration(NATIVE_CAMPAIGN_REGISTER_QUERY)).toBe(true);
    expect(
      isCampaignPushRegistration(NATIVE_CAMPAIGN_REGISTER_QUERY.replace('token: $token', 'token: "changed"')),
    ).toBe(false);
  });
});
