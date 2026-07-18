import { describe, expect, it, vi, beforeEach } from 'vite-plus/test';
import { NextRequest } from 'next/server';
import { GET } from '../route';
import { getServerSession } from 'next-auth/next';
import { issueNativeOAuthTransferToken } from '@/app/lib/auth/native-oauth-transfer';

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

const mockedGetServerSession = vi.mocked(getServerSession);
const mockedIssueToken = vi.mocked(issueNativeOAuthTransferToken);

const CALLBACK_SCHEME = 'com.boardsesh.app://auth/callback';

function createRequest(url: string): NextRequest {
  return new NextRequest(new URL(url, 'http://localhost:3000'));
}

/** Extract the deep link URL from the HTML body's JavaScript redirect. */
async function extractDeepLink(response: Response): Promise<string> {
  const html = await response.text();
  // Match the JSON.stringify'd URL in: window.location.href="..."
  const match = html.match(/window\.location\.href=(".*?")/);
  if (!match) throw new Error('No deep link found in response body');
  return JSON.parse(match[1]) as string;
}

describe('GET /api/auth/native/callback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns HTML redirect with error when session is missing', async () => {
    mockedGetServerSession.mockResolvedValue(null);

    const response = await GET(createRequest('/api/auth/native/callback?next=/'));

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(await extractDeepLink(response)).toBe(`${CALLBACK_SCHEME}?error=session_missing`);
  });

  it('returns HTML redirect with error when session has no user id', async () => {
    mockedGetServerSession.mockResolvedValue({ user: { email: 'test@test.com' } });

    const response = await GET(createRequest('/api/auth/native/callback?next=/'));

    expect(response.status).toBe(200);
    expect(await extractDeepLink(response)).toBe(`${CALLBACK_SCHEME}?error=session_missing`);
  });

  it('returns HTML redirect with transfer token on success', async () => {
    mockedGetServerSession.mockResolvedValue({
      user: { id: 'user_123', email: 'test@test.com' },
    });
    mockedIssueToken.mockReturnValue('test-transfer-token');

    const response = await GET(createRequest('/api/auth/native/callback?next=/settings'));

    expect(response.status).toBe(200);
    const deepLink = await extractDeepLink(response);
    expect(deepLink).toContain(`${CALLBACK_SCHEME}?transferToken=`);
    expect(deepLink).toContain('test-transfer-token');
    expect(deepLink).toContain('next=%2Fsettings');

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

    const response = await GET(createRequest('/api/auth/native/callback?next=https://evil.com'));

    expect(response.status).toBe(200);
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

  it('returns HTML redirect with error when token issuance throws', async () => {
    mockedGetServerSession.mockResolvedValue({
      user: { id: 'user_123', email: 'test@test.com' },
    });
    mockedIssueToken.mockImplementation(() => {
      throw new Error('NEXTAUTH_SECRET not set');
    });

    const response = await GET(createRequest('/api/auth/native/callback?next=/'));

    expect(response.status).toBe(200);
    expect(await extractDeepLink(response)).toBe(`${CALLBACK_SCHEME}?error=token_issue_failed`);
  });

  it('includes HTML-escaped URL in meta refresh attribute', async () => {
    mockedGetServerSession.mockResolvedValue(null);

    const response = await GET(createRequest('/api/auth/native/callback?next=/'));
    const html = await response.text();

    // meta refresh should contain HTML-escaped URL
    expect(html).toContain('<meta http-equiv="refresh"');
    // The scheme contains no characters that need escaping, but verify
    // the meta tag is present and well-formed
    expect(html).toContain('content="0;url=');
  });
});
