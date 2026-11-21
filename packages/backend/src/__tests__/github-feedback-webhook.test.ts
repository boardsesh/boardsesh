import { createHmac } from 'node:crypto';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('../services/job-queue', () => ({ requireJobQueue: () => ({ send }) }));
import { handleGithubFeedbackWebhook, verifyFeedbackWebhook } from '../handlers/github-feedback-webhook';

const secret = 'test-webhook-secret';
const payload = {
  action: 'created',
  repository: { full_name: 'boardsesh/boardsesh' },
  issue: { number: 4711 },
  comment: { id: 100 },
};
const sign = (body: string) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
async function request(options: { body?: string; signature?: string; event?: string; method?: string } = {}) {
  const body = options.body ?? JSON.stringify(payload);
  const req = Readable.from([Buffer.from(body)]) as unknown as IncomingMessage;
  req.method = options.method ?? 'POST';
  req.headers = {
    'x-github-event': options.event ?? 'issue_comment',
    'x-hub-signature-256': options.signature ?? sign(body),
  };
  const writeHead = vi.fn();
  const end = vi.fn();
  const response = { writeHead, end } as unknown as ServerResponse;
  await handleGithubFeedbackWebhook(req, response);
  return { status: writeHead.mock.calls[0][0] as number, body: JSON.parse(end.mock.calls[0][0] as string) as unknown };
}
beforeEach(() => {
  vi.stubEnv('GITHUB_FEEDBACK_WEBHOOK_SECRET', secret);
  vi.stubEnv('FEEDBACK_GITHUB_REPO', 'boardsesh/boardsesh');
  vi.stubEnv('QA_GITHUB_REPO', '');
  send.mockReset().mockResolvedValue('job-id');
});
afterEach(() => vi.unstubAllEnvs());

describe('GitHub feedback webhook', () => {
  it('authenticates the exact raw body with HMAC SHA256', () => {
    const body = JSON.stringify(payload);
    expect(verifyFeedbackWebhook(body, sign(body), secret)).toBe(true);
    expect(verifyFeedbackWebhook(body + ' ', sign(body), secret)).toBe(false);
    expect(verifyFeedbackWebhook(body, 'sha256=ab', secret)).toBe(false);
    expect(verifyFeedbackWebhook(body, undefined, secret)).toBe(false);
    expect(verifyFeedbackWebhook(body, sign(body), 'other')).toBe(false);
  });
  it('returns404 while unconfigured and405 for non-POST requests', async () => {
    vi.stubEnv('GITHUB_FEEDBACK_WEBHOOK_SECRET', '');
    expect((await request()).status).toBe(404);
    vi.stubEnv('GITHUB_FEEDBACK_WEBHOOK_SECRET', secret);
    expect((await request({ method: 'GET' })).status).toBe(405);
    expect(send).not.toHaveBeenCalled();
  });
  it('refuses invalid signatures before parsing or queueing payloads', async () => {
    expect((await request({ body: '{malformed', signature: 'sha256=' + '0'.repeat(64) })).status).toBe(401);
    expect(send).not.toHaveBeenCalled();
  });
  it('acknowledges other event types and ignores foreign repositories and pull requests', async () => {
    expect((await request({ event: 'ping' })).status).toBe(200);
    expect(
      (await request({ body: JSON.stringify({ ...payload, repository: { full_name: 'someone/else' } }) })).status,
    ).toBe(200);
    expect(
      (await request({ body: JSON.stringify({ ...payload, issue: { number: 4711, pull_request: { url: 'PR' } } }) }))
        .status,
    ).toBe(200);
    expect(send).not.toHaveBeenCalled();
  });
  it.each(['created', 'edited', 'deleted'])(
    'durably queues %s comment identities without storing webhook body',
    async (action) => {
      expect((await request({ body: JSON.stringify({ ...payload, action }) })).status).toBe(202);
      expect(send).toHaveBeenCalledWith(
        'feedback-github-inbound',
        { repository: 'boardsesh/boardsesh', issueNumber: 4711, commentId: 100 },
        expect.objectContaining({ retryLimit: 20 }),
      );
    },
  );
  it.each(['closed', 'reopened', 'edited'])(
    'queues canonical issue refresh for %s lifecycle events',
    async (action) => {
      expect((await request({ event: 'issues', body: JSON.stringify({ ...payload, action }) })).status).toBe(202);
      expect(send).toHaveBeenCalledWith(
        'feedback-github-issue',
        { repository: 'boardsesh/boardsesh', issueNumber: 4711 },
        expect.objectContaining({ retryLimit: 20 }),
      );
    },
  );
  it.each(['opened', 'labeled', 'assigned'])(
    'acknowledges unsupported %s issue actions without queueing',
    async (action) => {
      expect((await request({ event: 'issues', body: JSON.stringify({ ...payload, action }) })).status).toBe(200);
      expect(send).not.toHaveBeenCalled();
    },
  );
  it('rejects malformed authenticated JSON and invalid comment identities', async () => {
    expect((await request({ body: '{bad JSON' })).status).toBe(400);
    expect((await request({ body: JSON.stringify({ ...payload, comment: { id: -1 } }) })).status).toBe(400);
  });
  it('returns503 if the durable enqueue fails, allowing delivery retry', async () => {
    send.mockRejectedValueOnce(new Error('queue unavailable'));
    expect((await request()).status).toBe(503);
    send.mockResolvedValueOnce(null);
    expect((await request()).status).toBe(503);
  });
});
