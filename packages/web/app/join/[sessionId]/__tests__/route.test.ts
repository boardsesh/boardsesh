import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock server-only
vi.mock('server-only', () => ({}));

// Mock database
const mockSelect = vi.fn();
const mockFrom = vi.fn();
const mockWhere = vi.fn();
const mockLimit = vi.fn();

vi.mock('@/app/lib/db/db', () => ({
  dbz: {
    select: (...args: unknown[]) => {
      mockSelect(...args);
      return { from: mockFrom };
    },
  },
}));

mockFrom.mockReturnValue({ where: mockWhere });
mockWhere.mockReturnValue({ limit: mockLimit });

// Mock schema
vi.mock('@/app/lib/db/schema', () => ({
  boardSessions: {
    id: 'id',
    boardPath: 'boardPath',
  },
}));

// Mock drizzle-orm
vi.mock('drizzle-orm', () => ({
  eq: (col: string, val: string) => ({ col, val }),
}));

// Mock climb session cookie
vi.mock('@/app/lib/climb-session-cookie', () => ({
  CLIMB_SESSION_COOKIE: 'climb-session',
}));

import { GET } from '../route';

function makeRequest(
  url: string,
  headers: Record<string, string> = {},
): Request {
  return new Request(url, { headers });
}

function makeParams(sessionId: string): { params: Promise<{ sessionId: string }> } {
  return { params: Promise.resolve({ sessionId }) };
}

describe('GET /join/[sessionId]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLimit.mockResolvedValue([
      { id: 'test-session-123', boardPath: 'kilter/1/2/3/40/list' },
    ]);
  });

  describe('protocol validation (x-forwarded-proto)', () => {
    const originalEnv = process.env.NODE_ENV;

    beforeEach(() => {
      // getBaseUrl only reads forwarded headers in development
      vi.stubEnv('NODE_ENV', 'development');
    });

    it('accepts http as a valid protocol', async () => {
      const request = makeRequest('http://localhost:3000/join/test-session-123', {
        'x-forwarded-host': 'my-proxy.local',
        'x-forwarded-proto': 'http',
      });

      const response = await GET(request, makeParams('test-session-123'));
      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toMatch(/^http:\/\/my-proxy\.local\//);
    });

    it('accepts https as a valid protocol', async () => {
      const request = makeRequest('http://localhost:3000/join/test-session-123', {
        'x-forwarded-host': 'my-proxy.local',
        'x-forwarded-proto': 'https',
      });

      const response = await GET(request, makeParams('test-session-123'));
      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toMatch(/^https:\/\/my-proxy\.local\//);
    });

    it('rejects javascript: protocol and defaults to http', async () => {
      const request = makeRequest('http://localhost:3000/join/test-session-123', {
        'x-forwarded-host': 'my-proxy.local',
        'x-forwarded-proto': 'javascript:',
      });

      const response = await GET(request, makeParams('test-session-123'));
      expect(response.status).toBe(307);
      const location = response.headers.get('location')!;
      expect(location).toMatch(/^http:\/\/my-proxy\.local\//);
      expect(location).not.toContain('javascript:');
    });

    it('rejects data: protocol and defaults to http', async () => {
      const request = makeRequest('http://localhost:3000/join/test-session-123', {
        'x-forwarded-host': 'my-proxy.local',
        'x-forwarded-proto': 'data:',
      });

      const response = await GET(request, makeParams('test-session-123'));
      const location = response.headers.get('location')!;
      expect(location).toMatch(/^http:\/\/my-proxy\.local\//);
    });

    it('rejects arbitrary protocol values', async () => {
      const request = makeRequest('http://localhost:3000/join/test-session-123', {
        'x-forwarded-host': 'my-proxy.local',
        'x-forwarded-proto': 'ftp',
      });

      const response = await GET(request, makeParams('test-session-123'));
      const location = response.headers.get('location')!;
      expect(location).toMatch(/^http:\/\/my-proxy\.local\//);
    });

    it('handles comma-separated forwarded proto (picks first)', async () => {
      const request = makeRequest('http://localhost:3000/join/test-session-123', {
        'x-forwarded-host': 'my-proxy.local',
        'x-forwarded-proto': 'https, http',
      });

      const response = await GET(request, makeParams('test-session-123'));
      const location = response.headers.get('location')!;
      expect(location).toMatch(/^https:\/\/my-proxy\.local\//);
    });

    it('defaults to http when x-forwarded-proto is missing', async () => {
      const request = makeRequest('http://localhost:3000/join/test-session-123', {
        'x-forwarded-host': 'my-proxy.local',
      });

      const response = await GET(request, makeParams('test-session-123'));
      const location = response.headers.get('location')!;
      expect(location).toMatch(/^http:\/\/my-proxy\.local\//);
    });
  });

  describe('missing forwarded headers fallback', () => {
    it('uses host header and request protocol when no forwarded headers', async () => {
      const request = makeRequest('https://boardsesh.com/join/test-session-123', {
        host: 'boardsesh.com',
      });

      const response = await GET(request, makeParams('test-session-123'));
      expect(response.status).toBe(307);
      const location = response.headers.get('location')!;
      expect(location).toMatch(/^https:\/\/boardsesh\.com\//);
    });

    it('falls back to request URL when no host header', async () => {
      const request = makeRequest('https://boardsesh.com/join/test-session-123');

      const response = await GET(request, makeParams('test-session-123'));
      expect(response.status).toBe(307);
      const location = response.headers.get('location')!;
      expect(location).toContain('boardsesh.com');
    });
  });

  describe('forwarded headers ignored in production', () => {
    beforeEach(() => {
      vi.stubEnv('NODE_ENV', 'production');
    });

    it('ignores x-forwarded-host in production', async () => {
      const request = makeRequest('https://boardsesh.com/join/test-session-123', {
        host: 'boardsesh.com',
        'x-forwarded-host': 'evil.com',
        'x-forwarded-proto': 'http',
      });

      const response = await GET(request, makeParams('test-session-123'));
      const location = response.headers.get('location')!;
      expect(location).toMatch(/^https:\/\/boardsesh\.com\//);
      expect(location).not.toContain('evil.com');
    });
  });

  describe('session validation', () => {
    it('returns 400 for invalid session ID format', async () => {
      const request = makeRequest('http://localhost:3000/join/invalid!@#');

      const response = await GET(request, makeParams('invalid!@#'));
      expect(response.status).toBe(400);
    });

    it('returns 404 for non-existent session', async () => {
      mockLimit.mockResolvedValueOnce([]);

      const request = makeRequest('http://localhost:3000/join/valid-session-id');

      const response = await GET(request, makeParams('valid-session-id'));
      expect(response.status).toBe(404);
    });
  });
});
