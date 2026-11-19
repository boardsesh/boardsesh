import { describe, expect, it } from 'vite-plus/test';
import type { z } from 'zod';
import committedDocument from '../generated/openapi.json';
import { generatePublicApiDocument, renderPublicApiDocument } from '../document';
import {
  CreateWorkoutSchema,
  WorkoutBlockSchema,
  WorkoutBlockSupportSchema,
  WorkoutConflictSchema,
  WorkoutCreatedSchema,
  WorkoutListSchema,
  WorkoutResponseSchema,
  WorkoutResultsSchema,
  WorkoutStatusSchema,
} from '../workouts';
import {
  ApiErrorResponseSchema,
  BoardTypeSchema,
  GradeSchema,
  LogbookChangesResponseSchema,
  MeResponseSchema,
  TickChangeSchema,
  TickClimbSchema,
  TickDeletedChangeSchema,
  TickSchema,
  TickStatusSchema,
  UnknownLogbookChangeSchema,
  PartnerSessionSchema,
  SessionChangeSchema,
  SessionDeletedChangeSchema,
  SessionWorkoutSchema,
  SessionWorkoutStageSchema,
  SessionWorkoutPacingSchema,
  SessionWorkoutClimbSchema,
} from '../schemas';

type Operation = {
  security?: Record<string, string[]>[];
  responses: Record<string, { headers?: Record<string, { required?: boolean }>; content?: unknown }>;
};
type Component = Record<string, unknown>;

const document = generatePublicApiDocument();
const paths = document.paths as Record<string, Record<string, Operation>>;
const components = document.components?.schemas as Record<string, Component>;
const committedJson = JSON.stringify(committedDocument);

const everyOperation = Object.entries(paths).flatMap(([path, methods]) =>
  Object.entries(methods).map(([method, operation]) => ({ path, method, operation })),
);

describe('the committed OpenAPI document', () => {
  it('matches what the schemas generate', () => {
    expect(committedDocument).toEqual(JSON.parse(renderPublicApiDocument()));
  });

  it('is OpenAPI 3.1 for the production host', () => {
    expect(committedDocument).toMatchObject({
      openapi: '3.1.0',
      servers: [{ url: 'https://api.boardsesh.com' }],
    });
  });
});

describe('the OpenAPI routes', () => {
  it('covers exactly the routes that ship first', () => {
    expect(everyOperation.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'get /v1/me',
      'delete /v1/connection',
      'get /v1/logbook/changes',
      'get /v1/logbook/ticks/{id}',
      'get /v1/logbook/sessions/{id}',
      'post /v1/workouts',
      'get /v1/workouts',
      'get /v1/workouts/{id}',
      'delete /v1/workouts/{id}',
    ]);
  });

  it.each([
    ['/v1/me', 'get', ['200', '401', '429', '5XX']],
    ['/v1/connection', 'delete', ['204', '401', '429', '5XX']],
    ['/v1/logbook/changes', 'get', ['200', '400', '401', '403', '410', '429', '5XX']],
    ['/v1/logbook/ticks/{id}', 'get', ['200', '401', '403', '404', '429', '5XX']],
    ['/v1/logbook/sessions/{id}', 'get', ['200', '401', '403', '404', '429', '5XX']],
  ])('documents the responses of %s %s', (path, method, statuses) => {
    expect(Object.keys(paths[path][method].responses).sort()).toEqual([...statuses].sort());
  });

  it.each([
    ['/v1/me', 'get', []],
    ['/v1/connection', 'delete', []],
    ['/v1/logbook/changes', 'get', ['logbook:read']],
    ['/v1/logbook/ticks/{id}', 'get', ['logbook:read']],
    ['/v1/logbook/sessions/{id}', 'get', ['logbook:read', 'sessions:read']],
  ])('requires the right scope on %s %s', (path, method, scopes) => {
    expect(paths[path][method].security).toEqual([{ boardseshOAuth: scopes }]);
  });

  it('disconnect has no body', () => {
    expect(paths['/v1/connection'].delete.responses['204'].content).toBeUndefined();
  });

  it('offers workout scopes with their routes', () => {
    expect(committedJson).toContain('workouts:read');
    expect(committedJson).toContain('workouts:write');
  });

  it.each(
    everyOperation.flatMap(({ path, operation }) =>
      Object.entries(operation.responses).map(([status, response]) => ({ path, status, response })),
    ),
  )('sends the request id and rate limit headers from $path on $status', ({ response }) => {
    expect(Object.keys(response.headers ?? {})).toEqual(
      expect.arrayContaining(['Boardsesh-Request-Id', 'RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset']),
    );
  });

  it('promises Retry-After on 429 and leaves it optional on 5XX', () => {
    const { responses } = paths['/v1/logbook/changes'].get;

    expect(responses['429'].headers?.['Retry-After']?.required).toBe(true);
    expect(responses['5XX'].headers?.['Retry-After']?.required).toBe(false);
  });
});

describe('the OpenAPI schemas', () => {
  const schemasByComponent: Record<string, z.ZodType> = {
    ApiError: ApiErrorResponseSchema,
    BoardType: BoardTypeSchema,
    Grade: GradeSchema,
    LogbookChangesResponse: LogbookChangesResponseSchema,
    MeResponse: MeResponseSchema,
    Tick: TickSchema,
    TickChange: TickChangeSchema,
    TickClimb: TickClimbSchema,
    TickDeletedChange: TickDeletedChangeSchema,
    TickStatus: TickStatusSchema,
    UnknownLogbookChange: UnknownLogbookChangeSchema,
    PartnerSession: PartnerSessionSchema,
    SessionChange: SessionChangeSchema,
    SessionDeletedChange: SessionDeletedChangeSchema,
    SessionWorkout: SessionWorkoutSchema,
    SessionWorkoutStage: SessionWorkoutStageSchema,
    SessionWorkoutPacing: SessionWorkoutPacingSchema,
    SessionWorkoutClimb: SessionWorkoutClimbSchema,
    CreateWorkout: CreateWorkoutSchema,
    Workout: WorkoutResponseSchema,
    WorkoutBlock: WorkoutBlockSchema,
    WorkoutBlockSupport: WorkoutBlockSupportSchema,
    WorkoutConflict: WorkoutConflictSchema,
    WorkoutCreated: WorkoutCreatedSchema,
    WorkoutList: WorkoutListSchema,
    WorkoutResults: WorkoutResultsSchema,
    WorkoutStatus: WorkoutStatusSchema,
  };

  it('registers a schema for every component', () => {
    expect(Object.keys(components).sort()).toEqual(Object.keys(schemasByComponent).sort());
  });

  it.each(Object.keys(schemasByComponent))('%s carries an example its own schema accepts', (name) => {
    const { example } = components[name];

    expect(example).toBeDefined();
    expect(schemasByComponent[name].safeParse(example).success).toBe(true);
  });

  it('never tells apps that the field list is final', () => {
    expect(committedJson).not.toContain('"additionalProperties":false');
  });

  it('keeps the value lists open, so a new value is not a breaking change', () => {
    expect(components.TickStatus).not.toHaveProperty('enum');
    expect(components.TickStatus['x-extensible-enum']).toEqual(['flash', 'send', 'attempt']);
    expect(components.BoardType).not.toHaveProperty('enum');
    expect(components.BoardType['x-extensible-enum']).toContain('spray');
  });

  it('keeps the feed entries open, with no closed union', () => {
    const changes = (components.LogbookChangesResponse.properties as Record<string, { items: Component }>).changes;

    expect(changes.items).not.toHaveProperty('oneOf');
    expect(changes.items).not.toHaveProperty('discriminator');
    expect(changes.items.anyOf).toEqual([
      { $ref: '#/components/schemas/TickChange' },
      { $ref: '#/components/schemas/TickDeletedChange' },
      { $ref: '#/components/schemas/SessionChange' },
      { $ref: '#/components/schemas/SessionDeletedChange' },
      { $ref: '#/components/schemas/UnknownLogbookChange' },
    ]);
  });

  it('lets a null grade validate', () => {
    expect((components.Tick.properties as Record<string, Component>).grade).toEqual({
      anyOf: [{ $ref: '#/components/schemas/Grade' }, { type: 'null' }],
      description: expect.any(String),
    });
  });
});
