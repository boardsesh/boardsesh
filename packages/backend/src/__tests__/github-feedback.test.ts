import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import {
  buildFeedbackIssue,
  createFeedbackGithubIssue,
  redactSensitiveText,
  type FeedbackIssuePayload,
} from '../services/github-feedback';

const originalToken = process.env.FEEDBACK_GITHUB_TOKEN;
const originalRepo = process.env.FEEDBACK_GITHUB_REPO;

function serialize(value: unknown): string {
  return JSON.stringify(value);
}

const bugPayload = (overrides: Partial<FeedbackIssuePayload> = {}): FeedbackIssuePayload => ({
  feedbackId: 42,
  rating: null,
  comment: 'Crashed on submit',
  platform: 'ios',
  appVersion: '1.0.0 (3)',
  source: 'drawer-bug',
  ...overrides,
});

describe('buildFeedbackIssue', () => {
  it('returns null for rating sources (they do not become issues)', () => {
    expect(buildFeedbackIssue(bugPayload({ source: 'drawer-feedback', rating: 5, comment: null }))).toBeNull();
    expect(buildFeedbackIssue(bugPayload({ source: 'prompt', rating: 4, comment: null }))).toBeNull();
  });

  it('builds a bug-report title + labels for bug sources', () => {
    const draft = buildFeedbackIssue(bugPayload({ source: 'shake-bug', comment: 'It froze on the board screen' }));
    expect(draft).not.toBeNull();
    expect(draft?.title).toBe('🐞 Bug report: It froze on the board screen');
    expect(draft?.labels).toEqual(['bug', 'user-feedback', 'ios']);
  });

  it('truncates a long title to 120 chars', () => {
    const draft = buildFeedbackIssue(bugPayload({ comment: 'x'.repeat(300) }));
    expect(draft?.title.length).toBeLessThanOrEqual(120);
    expect(draft?.title.endsWith('...')).toBe(true);
  });

  it('renders board + climb + session + url metadata when provided', () => {
    const draft = buildFeedbackIssue(
      bugPayload({
        boardName: 'kilter',
        layoutId: 1,
        sizeId: 5,
        setIds: [1, 2],
        angle: 40,
        context: {
          climbName: 'My Project',
          difficulty: 'V5',
          sessionId: 'sess-1',
          sessionName: 'Friday Sesh',
          url: '/kilter/1/5/1,2/40',
          userAgent: 'BoardseshApp/1.0',
        },
      }),
    );
    const body = draft?.body ?? '';
    expect(body).toContain('| Board | kilter / layout 1 / size 5 / sets [1,2] @ 40° |');
    expect(body).toContain('| Climb | My Project (V5) |');
    expect(body).toContain('| Session | Friday Sesh (sess-1) |');
    expect(body).toContain('| URL | /kilter/1/5/1,2/40 |');
  });

  it('embeds the app_feedback id marker + lookup row but no user identity', () => {
    const draft = buildFeedbackIssue(bugPayload({ feedbackId: 99 }));
    const body = draft?.body ?? '';
    expect(body).toContain('<!-- app-feedback:99 -->');
    expect(body).toContain('app_feedback #99');
    const wire = serialize(draft);
    expect(wire).not.toMatch(/userId/i);
    expect(wire).not.toMatch(/user_id/);
    expect(wire).not.toMatch(/displayName/i);
  });

  it('redacts an email + name in the comment before it reaches the issue', () => {
    const draft = buildFeedbackIssue(
      bugPayload({ comment: 'Reach me at climber@example.com — my name is John Smith. The app froze.' }),
    );
    const wire = serialize(draft);
    expect(wire).not.toContain('climber@example.com');
    expect(wire).toContain('[redacted email]');
  });

  it('shows a consent line that flips with contactConsent', () => {
    expect(buildFeedbackIssue(bugPayload({ contactConsent: true }))?.body).toContain('✅ Reporter agreed to follow-up');
    expect(buildFeedbackIssue(bugPayload({ contactConsent: false }))?.body).toContain('🚫 No contact consent');
    expect(buildFeedbackIssue(bugPayload({ contactConsent: null }))?.body).toContain('🚫 No contact consent');
  });
});

// Behaviour lives in @boardsesh/text-redaction and is covered by its own tests.
// This only pins that the re-export is still wired up.
describe('redactSensitiveText re-export', () => {
  it('redacts through to the shared helper', () => {
    expect(redactSensitiveText('mail me at a@b.com')).toContain('[redacted email]');
  });
});

describe('createFeedbackGithubIssue', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn((input: string | URL) => {
      const url = String(input);
      if (url.endsWith('/issues')) {
        return Promise.resolve({
          ok: true,
          status: 201,
          json: async () => ({ number: 123, html_url: 'https://github.com/boardsesh/boardsesh/issues/123' }),
          text: async () => '',
        });
      }
      // label creation
      return Promise.resolve({ ok: true, status: 201, text: async () => '', json: async () => ({}) });
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.FEEDBACK_GITHUB_TOKEN;
    else process.env.FEEDBACK_GITHUB_TOKEN = originalToken;
    if (originalRepo === undefined) delete process.env.FEEDBACK_GITHUB_REPO;
    else process.env.FEEDBACK_GITHUB_REPO = originalRepo;
  });

  it('no-ops (returns null, no fetch) when the token is unset', async () => {
    delete process.env.FEEDBACK_GITHUB_TOKEN;
    const result = await createFeedbackGithubIssue(bugPayload());
    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns null for a rating source even when configured', async () => {
    process.env.FEEDBACK_GITHUB_TOKEN = 'tok';
    const result = await createFeedbackGithubIssue(bugPayload({ source: 'prompt', rating: 5, comment: null }));
    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('POSTs an issue and returns its number + html url when configured', async () => {
    process.env.FEEDBACK_GITHUB_TOKEN = 'tok';
    process.env.FEEDBACK_GITHUB_REPO = 'boardsesh/boardsesh';

    const result = await createFeedbackGithubIssue(bugPayload());

    expect(result).toEqual({ number: 123, htmlUrl: 'https://github.com/boardsesh/boardsesh/issues/123' });
    const issueCall = fetchSpy.mock.calls.find(([url]) => String(url).endsWith('/issues'));
    expect(issueCall).toBeTruthy();
    const [, init] = issueCall as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(init.body as string).not.toMatch(/user_id/);
  });

  it('returns null (never throws) when the issue POST fails', async () => {
    process.env.FEEDBACK_GITHUB_TOKEN = 'tok';
    fetchSpy.mockImplementation((input: string | URL) => {
      const url = String(input);
      if (url.endsWith('/issues')) {
        return Promise.resolve({ ok: false, status: 500, text: async () => 'boom', json: async () => ({}) });
      }
      return Promise.resolve({ ok: true, status: 201, text: async () => '', json: async () => ({}) });
    });

    await expect(createFeedbackGithubIssue(bugPayload())).resolves.toBeNull();
  });

  it('returns null (never throws) when fetch rejects', async () => {
    process.env.FEEDBACK_GITHUB_TOKEN = 'tok';
    fetchSpy.mockRejectedValue(new Error('network down'));
    await expect(createFeedbackGithubIssue(bugPayload())).resolves.toBeNull();
  });
});
