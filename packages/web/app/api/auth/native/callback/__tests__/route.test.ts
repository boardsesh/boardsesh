import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// Mock dependencies before importing the route handler
vi.mock('next-auth/next', () => ({
  getServerSession: vi.fn(),
}));

vi.mock('@/app/lib/auth/auth-options', () => ({
  authOptions: {},
}));

vi.mock('@/app/lib/auth/native-oauth-transfer', () => ({
  issueNativeOAuthTransferToken: vi.fn(),
}));

import { GET } from '../route';
import { getServerSession } from 'next-auth/next';
import { issueNativeOAuthTransferToken } from '@/app/lib/auth/native-oauth-transfer';

const mockedGetServerSession = vi.mocked(getServerSession);
const mockedIssueToken = vi.mocked(issueNativeOAuthTransferToken);

const CALLBACK_SCHEME = 'com.boardsesh.app://auth/callback';

function createRequest(url: string): NextRequest {
  return new NextRequest(new URL(url, 'http://localhost:3000'));
}

describe('GET /api/auth/native/callback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('redirects with error when session is missing', async () => {
    mockedGetServerSession.mockResolvedValue(null);

    const response = await GET(createRequest('/api/auth/native/callback?next=/'));

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe(
      `${CALLBACK_SCHEME}?error=session_missing`,
    );
  });

  it('redirects with error when session has no user id', async () => {
    mockedGetServerSession.mockResolvedValue({ user: { email: 'test@test.com' } });

    const response = await GET(createRequest('/api/auth/native/callback?next=/'));

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe(
      `${CALLBACK_SCHEME}?error=session_missing`,
    );
  });

  it('redirects with transfer token on success', async () => {
    mockedGetServerSession.mockResolvedValue({
      user: { id: 'user_123', email: 'test@test.com' },
    });
    mockedIssueToken.mockReturnValue('test-transfer-token');

    const response = await GET(
      createRequest('/api/auth/native/callback?next=/settings'),
    );

    expect(response.status).toBe(302);
    const location = response.headers.get('Location');
    expect(location).toContain(`${CALLBACK_SCHEME}?transferToken=`);
    expect(location).toContain('test-transfer-token');
    expect(location).toContain('next=%2Fsettings');

    expect(mockedIssueToken).toHaveBeenCalledWith({
      userId: 'user_123',
      nextPath: '/settings',
    });
  });

  it('sanitizes non-relative next path to root', async () => {
    mockedGetServerSession.mockResolvedValue({
      user: { id: 'user_123', email: 'test@test.com' },
    });
    mockedIssueToken.mockReturnValue('token');

    const response = await GET(
      createRequest('/api/auth/native/callback?next=https://evil.com'),
    );

    expect(response.status).toBe(302);
    expect(mockedIssueToken).toHaveBeenCalledWith({
      userId: 'user_123',
      nextPath: '/',
    });
  });

  it('defaults next path to root when missing', async () => {
    mockedGetServerSession.mockResolvedValue({
      user: { id: 'user_123', email: 'test@test.com' },
    });
    mockedIssueToken.mockReturnValue('token');

    await GET(createRequest('/api/auth/native/callback'));

    expect(mockedIssueToken).toHaveBeenCalledWith({
      userId: 'user_123',
      nextPath: '/',
    });
  });

  it('redirects with error when token issuance throws', async () => {
    mockedGetServerSession.mockResolvedValue({
      user: { id: 'user_123', email: 'test@test.com' },
    });
    mockedIssueToken.mockImplementation(() => {
      throw new Error('NEXTAUTH_SECRET not set');
    });

    const response = await GET(createRequest('/api/auth/native/callback?next=/'));

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe(
      `${CALLBACK_SCHEME}?error=token_issue_failed`,
    );
  });
});
