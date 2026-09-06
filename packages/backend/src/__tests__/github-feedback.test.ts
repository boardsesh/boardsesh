import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

// The issue is opened as the GitHub App now. Stub the mint, not the env:
// `lib/__tests__/github-app-auth.test.ts` owns the minting, and `undefined`
// here is a deploy with no App configured.
let installationToken: string | undefined = 'ghs_installation_token';
vi.mock('../lib/github-app-auth', () => ({
  getInstallationAccessToken: async () => installationToken,
}));

import {
  buildFeedbackIssue,
  createFeedbackGithubIssue,
  redactSensitiveText,
  type FeedbackIssuePayload,
} from '../services/github-feedback';

const originalRepo = process.env.FEEDBACK_GITHUB_REPO;
const originalQaRepo = process.env.QA_GITHUB_REPO;

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

  it('renders attached screenshots between the metadata table and the contact line', () => {
    const body = buildFeedbackIssue(
      bugPayload({
        screenshotUrls: [
          'https://media.boardsesh.com/feedback-screenshots/one.jpg',
          'https://media.boardsesh.com/feedback-screenshots/two.webp',
        ],
      }),
    )?.body;

    expect(body).toContain('## Screenshots');
    // Width-capped: a raw phone screenshot is ~2796px tall and would bury the
    // metadata under it.
    expect(body).toContain('<img src="https://media.boardsesh.com/feedback-screenshots/one.jpg" width="300">');
    expect(body).toContain('<img src="https://media.boardsesh.com/feedback-screenshots/two.webp" width="300">');
    expect(body!.indexOf('## Metadata')).toBeLessThan(body!.indexOf('## Screenshots'));
    expect(body!.indexOf('## Screenshots')).toBeLessThan(body!.indexOf('## Contact'));
  });

  it('renders no screenshot heading when none were attached', () => {
    expect(buildFeedbackIssue(bugPayload())?.body).not.toContain('## Screenshots');
    expect(buildFeedbackIssue(bugPayload({ screenshotUrls: [] }))?.body).not.toContain('## Screenshots');
    expect(buildFeedbackIssue(bugPayload({ screenshotUrls: null }))?.body).not.toContain('## Screenshots');
  });
});

// Behaviour lives in @boardsesh/text-redaction and is covered by its own tests.
// This only pins that the re-export is still wired up.
describe('redactSensitiveText re-export', () => {
  it('redacts through to the shared helper', () => {
    expect(redactSensitiveText('mail me at a@b.com')).toContain('[redacted email]');
    expect(redactSensitiveText('crash in /Users/marco/app')).toContain('/Users/[redacted]');
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
    installationToken = 'ghs_installation_token';
    if (originalRepo === undefined) delete process.env.FEEDBACK_GITHUB_REPO;
    else process.env.FEEDBACK_GITHUB_REPO = originalRepo;
    if (originalQaRepo === undefined) delete process.env.QA_GITHUB_REPO;
    else process.env.QA_GITHUB_REPO = originalQaRepo;
  });

  it('no-ops (returns null, no fetch) when the GitHub App is not configured', async () => {
    installationToken = undefined;
    const result = await createFeedbackGithubIssue(bugPayload());
    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns null for a rating source even when configured', async () => {
    const result = await createFeedbackGithubIssue(bugPayload({ source: 'prompt', rating: 5, comment: null }));
    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('POSTs an issue and returns its number + html url when configured', async () => {
    process.env.FEEDBACK_GITHUB_REPO = 'boardsesh/boardsesh';
    delete process.env.QA_GITHUB_REPO;

    const result = await createFeedbackGithubIssue(bugPayload());

    expect(result).toEqual({ number: 123, htmlUrl: 'https://github.com/boardsesh/boardsesh/issues/123' });
    const issueCall = fetchSpy.mock.calls.find(([url]) => String(url).endsWith('/issues'));
    expect(issueCall).toBeTruthy();
    const [, init] = issueCall as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(init.body as string).not.toMatch(/user_id/);
  });

  it('returns null (never throws) when the issue POST fails', async () => {
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
    fetchSpy.mockRejectedValue(new Error('network down'));
    await expect(createFeedbackGithubIssue(bugPayload())).resolves.toBeNull();
  });
});
