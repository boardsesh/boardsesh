import { describe, it, expect, beforeAll, afterAll } from 'vite-plus/test';
import { type Client, createClient } from 'graphql-ws';
// eslint-disable-next-line import/no-named-as-default -- `ws` exports both default and named `WebSocket`; default is the correct one for graphql-ws.
import WebSocket from 'ws';
import { SUPPORTED_BOARDS } from '@boardsesh/shared-schema';
import { startServer } from '../server';

const TEST_PORT = 8084; // Different port to avoid conflicts
const BOARD_NAME_ERROR = `Board name must be ${SUPPORTED_BOARDS.join(', ')}`;

// Helper to execute GraphQL operations
async function execute<T>(
  client: Client,
  operation: { query: string; variables?: Record<string, unknown> },
): Promise<T> {
  return new Promise((resolve, reject) => {
    let result: T;
    client.subscribe<T>(operation, {
      next: (data) => {
        if (data.errors) {
          reject(new Error(data.errors[0].message));
          return;
        }
        result = data.data as T;
      },
      error: (err) => reject(err),
      complete: () => resolve(result),
    });
  });
}

// Helper to expect GraphQL errors
async function expectError(
  client: Client,
  operation: { query: string; variables?: Record<string, unknown> },
  expectedMessage?: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    client.subscribe(operation, {
      next: (data) => {
        if (data.errors && data.errors.length > 0) {
          if (expectedMessage) {
            expect(data.errors[0].message).toContain(expectedMessage);
          }
          resolve();
        } else {
          reject(new Error('Expected GraphQL error but got success'));
        }
      },
      error: () => resolve(), // Connection errors are also acceptable
      complete: () => reject(new Error('Expected error but query completed successfully')),
    });
  });
}

describe('GraphQL Resolver Input Validation', () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let client: Client;

  beforeAll(async () => {
    // Set the test port via environment variable
    process.env.PORT = TEST_PORT.toString();
    server = await startServer();
    client = createClient({
      url: `ws://localhost:${TEST_PORT}/graphql`,
      webSocketImpl: WebSocket,
    });
  });

  afterAll(async () => {
    void client.dispose();
    // Close the server
    await new Promise<void>((resolve) => {
      server.httpServer.close(() => {
        server.wss.close(() => {
          resolve();
        });
      });
    });
  });

  describe('Session Query Validation', () => {
    it('should reject invalid session ID with special characters', async () => {
      const query = `
        query TestSession($sessionId: ID!) {
          session(sessionId: $sessionId) {
            id
          }
        }
      `;

      await expectError(
        client,
        {
          query,
          variables: { sessionId: 'test<script>alert(1)</script>' },
        },
        'Invalid sessionId',
      );
    });

    it('should reject empty session ID', async () => {
      const query = `
        query TestSession($sessionId: ID!) {
          session(sessionId: $sessionId) {
            id
          }
        }
      `;

      await expectError(
        client,
        {
          query,
          variables: { sessionId: '' },
        },
        'Session ID cannot be empty',
      );
    });
  });

  describe('Climb Query Validation', () => {
    it('should reject invalid layoutId (negative)', async () => {
      const query = `
        query TestClimb(
          $boardName: String!
          $layoutId: Int!
          $sizeId: Int!
          $setIds: String!
          $angle: Int!
          $climbUuid: ID!
        ) {
          climb(
            boardName: $boardName
            layoutId: $layoutId
            sizeId: $sizeId
            setIds: $setIds
            angle: $angle
            climbUuid: $climbUuid
          ) {
            uuid
          }
        }
      `;

      await expectError(
        client,
        {
          query,
          variables: {
            boardName: 'kilter',
            layoutId: -1,
            sizeId: 1,
            setIds: '1',
            angle: 40,
            climbUuid: 'test-uuid',
          },
        },
        'Invalid layoutId',
      );
    });

    it('should reject invalid angle (> 90)', async () => {
      const query = `
        query TestClimb(
          $boardName: String!
          $layoutId: Int!
          $sizeId: Int!
          $setIds: String!
          $angle: Int!
          $climbUuid: ID!
        ) {
          climb(
            boardName: $boardName
            layoutId: $layoutId
            sizeId: $sizeId
            setIds: $setIds
            angle: $angle
            climbUuid: $climbUuid
          ) {
            uuid
          }
        }
      `;

      await expectError(
        client,
        {
          query,
          variables: {
            boardName: 'kilter',
            layoutId: 1,
            sizeId: 1,
            setIds: '1',
            angle: 100,
            climbUuid: 'test-uuid',
          },
        },
        'Invalid angle',
      );
    });

    it('should reject invalid angle (< -90)', async () => {
      const query = `
        query TestClimb(
          $boardName: String!
          $layoutId: Int!
          $sizeId: Int!
          $setIds: String!
          $angle: Int!
          $climbUuid: ID!
        ) {
          climb(
            boardName: $boardName
            layoutId: $layoutId
            sizeId: $sizeId
            setIds: $setIds
            angle: $angle
            climbUuid: $climbUuid
          ) {
            uuid
          }
        }
      `;

      await expectError(
        client,
        {
          query,
          variables: {
            boardName: 'kilter',
            layoutId: 1,
            sizeId: 1,
            setIds: '1',
            angle: -95,
            climbUuid: 'test-uuid',
          },
        },
        'Invalid angle',
      );
    });

    it('should accept negative angle -5 (Aurora boards support negative tilt) without an angle error', async () => {
      const query = `
        query TestClimb(
          $boardName: String!
          $layoutId: Int!
          $sizeId: Int!
          $setIds: String!
          $angle: Int!
          $climbUuid: ID!
        ) {
          climb(
            boardName: $boardName
            layoutId: $layoutId
            sizeId: $sizeId
            setIds: $setIds
            angle: $angle
            climbUuid: $climbUuid
          ) {
            uuid
          }
        }
      `;

      // 'test-uuid' doesn't exist, so the resolver simply returns a null
      // climb — the point of this test is that it gets past angle
      // validation instead of throwing 'Invalid angle'.
      const result = await execute<{ climb: { uuid: string } | null }>(client, {
        query,
        variables: {
          boardName: 'kilter',
          layoutId: 1,
          sizeId: 1,
          setIds: '1',
          angle: -5,
          climbUuid: 'test-uuid',
        },
      });

      expect(result.climb).toBeNull();
    });

    it('should reject invalid board name', async () => {
      const query = `
        query TestClimb(
          $boardName: String!
          $layoutId: Int!
          $sizeId: Int!
          $setIds: String!
          $angle: Int!
          $climbUuid: ID!
        ) {
          climb(
            boardName: $boardName
            layoutId: $layoutId
            sizeId: $sizeId
            setIds: $setIds
            angle: $angle
            climbUuid: $climbUuid
          ) {
            uuid
          }
        }
      `;

      await expectError(
        client,
        {
          query,
          variables: {
            boardName: 'invalid-board',
            layoutId: 1,
            sizeId: 1,
            setIds: '1',
            angle: 40,
            climbUuid: 'test-uuid',
          },
        },
        BOARD_NAME_ERROR,
      );
    });
  });

  describe('Search Climbs Validation', () => {
    it('should reject pageSize exceeding MAX_PAGE_SIZE', async () => {
      const query = `
        query SearchClimbs($input: ClimbSearchInput!) {
          searchClimbs(input: $input) {
            climbs {
              uuid
            }
            hasMore
          }
        }
      `;

      await expectError(
        client,
        {
          query,
          variables: {
            input: {
              boardName: 'kilter',
              layoutId: 1,
              sizeId: 1,
              setIds: '1',
              angle: 40,
              page: 0,
              pageSize: 200, // Exceeds MAX_PAGE_SIZE of 100
            },
          },
        },
        'Page size cannot exceed 100',
      );
    });

    it('should accept valid pageSize', async () => {
      const query = `
        query SearchClimbs($input: ClimbSearchInput!) {
          searchClimbs(input: $input) {
            climbs {
              uuid
            }
            hasMore
          }
        }
      `;

      // This should succeed (not throw)
      const result = await execute<{
        searchClimbs: { climbs: Array<{ uuid: string }>; hasMore: boolean };
      }>(client, {
        query,
        variables: {
          input: {
            boardName: 'kilter',
            layoutId: 1,
            sizeId: 7,
            setIds: '1',
            angle: 40,
            page: 0,
            pageSize: 50, // Valid
          },
        },
      });

      expect(result.searchClimbs).toBeDefined();
      expect(result.searchClimbs.hasMore).toBeDefined();
    });
  });

  describe('Board Name Validation (SQL Injection Prevention)', () => {
    it('should reject SQL injection attempt in board name', async () => {
      const query = `
        query SearchClimbs($input: ClimbSearchInput!) {
          searchClimbs(input: $input) {
            climbs {
              uuid
            }
          }
        }
      `;

      await expectError(
        client,
        {
          query,
          variables: {
            input: {
              boardName: "kilter'; DROP TABLE users; --",
              layoutId: 1,
              sizeId: 1,
              setIds: '1',
              angle: 40,
            },
          },
        },
        BOARD_NAME_ERROR,
      );
    });
  });
});
