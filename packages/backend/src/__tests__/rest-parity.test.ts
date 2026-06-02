import { describe, it, expect, beforeAll, afterAll } from 'vite-plus/test';
import { startServer } from '../server';

const BACKEND_PORT = 8083; // Use different port to avoid conflicts with other tests
const PUBLIC_API_BASE = 'https://www.boardsesh.com';

// Helper to call REST API
async function fetchRest<T>(path: string): Promise<T> {
  const res = await fetch(`${PUBLIC_API_BASE}${path}`);
  if (!res.ok) {
    throw new Error(`REST API error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

// Helper to call GraphQL API
async function fetchGraphQL<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await fetch(`http://localhost:${BACKEND_PORT}/graphql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) {
    throw new Error(`GraphQL error: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

describe('REST vs GraphQL Parity Tests', () => {
  let server: Awaited<ReturnType<typeof startServer>>;

  beforeAll(async () => {
    process.env.PORT = String(BACKEND_PORT);
    server = await startServer();
    // Wait for server to be ready
    await new Promise((resolve) => setTimeout(resolve, 500));
  });

  afterAll(async () => {
    if (server) {
      server.wss.close();
      server.httpServer.close();
    }
  });

  describe('Board Configuration', () => {
    it('grades should match between REST and GraphQL for kilter', async () => {
      // REST API call
      const restResult =
        await fetchRest<Array<{ difficulty_id: number; difficulty_name: string }>>('/api/v1/grades/kilter');

      // GraphQL API call
      const gqlResult = await fetchGraphQL<{
        grades: Array<{ difficultyId: number; name: string }>;
      }>(`query { grades(boardName: "kilter") { difficultyId name } }`);

      // Compare lengths
      expect(gqlResult.grades.length).toBe(restResult.length);

      // Compare values (field names differ between REST and GraphQL)
      restResult.forEach((restGrade, i) => {
        expect(gqlResult.grades[i].difficultyId).toBe(restGrade.difficulty_id);
        expect(gqlResult.grades[i].name).toBe(restGrade.difficulty_name);
      });
    });

    it('grades should match between REST and GraphQL for tension', async () => {
      // REST API call
      const restResult =
        await fetchRest<Array<{ difficulty_id: number; difficulty_name: string }>>('/api/v1/grades/tension');

      // GraphQL API call
      const gqlResult = await fetchGraphQL<{
        grades: Array<{ difficultyId: number; name: string }>;
      }>(`query { grades(boardName: "tension") { difficultyId name } }`);

      // Compare lengths
      expect(gqlResult.grades.length).toBe(restResult.length);

      // Compare values
      restResult.forEach((restGrade, i) => {
        expect(gqlResult.grades[i].difficultyId).toBe(restGrade.difficulty_id);
        expect(gqlResult.grades[i].name).toBe(restGrade.difficulty_name);
      });
    });

    it('should return error for invalid board name', async () => {
      try {
        await fetchGraphQL<{ grades: unknown }>(`query { grades(boardName: "invalid") { difficultyId name } }`);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect((error as Error).message).toContain('Board name must be');
      }
    });

    it.skip('angles should match between REST and GraphQL for kilter layout 1', async () => {
      // Skipped: REST API at www.boardsesh.com/api/v1/angles returns 500
      // TODO: Re-enable when REST API is fixed
      const layoutId = 1;

      // REST API call
      const restResult = await fetchRest<Array<{ angle: number }>>(`/api/v1/angles/kilter/${layoutId}`);

      // GraphQL API call
      const gqlResult = await fetchGraphQL<{
        angles: Array<{ angle: number }>;
      }>(`query { angles(boardName: "kilter", layoutId: ${layoutId}) { angle } }`);

      // Compare lengths
      expect(gqlResult.angles.length).toBe(restResult.length);

      // Compare values
      expect(gqlResult.angles).toEqual(restResult);
    });
  });

  describe('Climb Search', () => {
    it('should return search results with correct structure', async () => {
      const searchParams = {
        boardName: 'kilter',
        layoutId: 1,
        sizeId: 10,
        setIds: '99',
        angle: 40,
        page: 0,
        pageSize: 5,
      };

      // GraphQL API call
      const gqlResult = await fetchGraphQL<{
        searchClimbs: {
          climbs: unknown[];
          totalCount: number;
          hasMore: boolean;
        };
      }>(
        `query SearchClimbs($input: ClimbSearchInput!) {
          searchClimbs(input: $input) {
            climbs { uuid name }
            totalCount
            hasMore
          }
        }`,
        { input: searchParams },
      );

      // For now, just verify the structure is correct
      // Full implementation will come in Phase 2.2
      expect(gqlResult.searchClimbs).toBeDefined();
      expect(gqlResult.searchClimbs.climbs).toBeInstanceOf(Array);
      expect(typeof gqlResult.searchClimbs.totalCount).toBe('number');
      expect(typeof gqlResult.searchClimbs.hasMore).toBe('boolean');
    });
  });

  describe('User Management (Unauthenticated)', () => {
    it('profile should return null for unauthenticated user', async () => {
      const gqlResult = await fetchGraphQL<{ profile: null }>(`
        query { profile { id email displayName avatarUrl } }
      `);

      expect(gqlResult.profile).toBeNull();
    });

    it('auroraCredentials should return empty array for unauthenticated user', async () => {
      const gqlResult = await fetchGraphQL<{
        auroraCredentials: unknown[];
      }>(`
        query { auroraCredentials { boardType username hasToken } }
      `);

      expect(gqlResult.auroraCredentials).toEqual([]);
    });

    it('favorites should return empty array for unauthenticated user', async () => {
      const gqlResult = await fetchGraphQL<{ favorites: string[] }>(
        `query {
          favorites(climbUuids: ["test-uuid"])
        }`,
      );

      expect(gqlResult.favorites).toEqual([]);
    });
  });

  describe('Mutations (Unauthenticated)', () => {
    it('updateProfile should fail for unauthenticated user', async () => {
      try {
        await fetchGraphQL<unknown>(
          `mutation {
            updateProfile(input: { displayName: "Test" }) {
              id
            }
          }`,
        );
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect((error as Error).message).toContain('Authentication required');
      }
    });

    it('toggleFavorite should fail for unauthenticated user', async () => {
      try {
        await fetchGraphQL<unknown>(
          `mutation {
            toggleFavorite(input: { climbUuid: "test-uuid" }) {
              favorited
            }
          }`,
        );
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect((error as Error).message).toContain('Authentication required');
      }
    });
  });
});
