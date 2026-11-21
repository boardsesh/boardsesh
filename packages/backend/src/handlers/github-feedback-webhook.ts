import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { readJsonBody, sendJson } from './http-utils';
import { requireJobQueue } from '../services/job-queue';
import { FEEDBACK_GITHUB_INBOUND_QUEUE, FEEDBACK_GITHUB_ISSUE_QUEUE } from '../services/feedback-github-conversations';
import { NOTIFICATION_PUSH_RETRIES } from '../services/notification-push-options';
import { resolveGithubRepo } from '../lib/github-client';
import { logger } from '../utils/logger';

const eventSchema = z.object({
  action: z.enum(['created', 'edited', 'deleted']),
  repository: z.object({ full_name: z.string() }),
  issue: z.object({ number: z.number().int().positive().safe(), pull_request: z.unknown().optional() }),
  comment: z.object({ id: z.number().int().positive().safe() }),
});

const issueEventSchema = z.object({
  action: z.string(),
  repository: z.object({ full_name: z.string() }),
  issue: z.object({ number: z.number().int().positive().safe(), pull_request: z.unknown().optional() }),
});

export function verifyFeedbackWebhook(body: string, signature: string | undefined, secret: string): boolean {
  if (!signature || !/^sha256=[0-9a-f]{64}$/.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(body).digest();
  return timingSafeEqual(Buffer.from(signature.slice(7), 'hex'), expected);
}

/** Authenticated GitHub events are queued before acknowledgement; payload bodies are never logged. */
export async function handleGithubFeedbackWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const secret = process.env.GITHUB_FEEDBACK_WEBHOOK_SECRET?.trim();
  if (!secret) {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' }, { Allow: 'POST' });
    return;
  }
  let body: string;
  try {
    body = await readJsonBody(req, 1_000_000);
  } catch {
    sendJson(res, 400, { error: 'Invalid payload' });
    return;
  }
  const signature = req.headers['x-hub-signature-256'];
  if (!verifyFeedbackWebhook(body, typeof signature === 'string' ? signature : undefined, secret)) {
    sendJson(res, 401, { error: 'Invalid signature' });
    return;
  }
  const eventType = req.headers['x-github-event'];
  if (eventType !== 'issue_comment' && eventType !== 'issues') {
    sendJson(res, 200, { accepted: true });
    return;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    sendJson(res, 400, { error: 'Invalid payload' });
    return;
  }
  const parsed = (eventType === 'issues' ? issueEventSchema : eventSchema).safeParse(payload);
  if (!parsed.success) {
    sendJson(res, 400, { error: 'Invalid issue comment' });
    return;
  }
  const event = parsed.data;
  const commentId = eventType === 'issue_comment' ? eventSchema.parse(payload).comment.id : undefined;
  if (
    event.repository.full_name !== resolveGithubRepo() ||
    event.issue.pull_request !== undefined ||
    (eventType === 'issues' && !['closed', 'reopened', 'edited'].includes(event.action))
  ) {
    sendJson(res, 200, { accepted: true });
    return;
  }
  try {
    const jobId = await requireJobQueue().send(
      eventType === 'issues' ? FEEDBACK_GITHUB_ISSUE_QUEUE : FEEDBACK_GITHUB_INBOUND_QUEUE,
      {
        ...(commentId !== undefined ? { commentId } : {}),
        issueNumber: event.issue.number,
        repository: event.repository.full_name,
      },
      NOTIFICATION_PUSH_RETRIES,
    );
    if (!jobId) throw new Error('GITHUB_WEBHOOK_ENQUEUE_FAILED');
    sendJson(res, 202, { accepted: true });
  } catch (error) {
    logger.error('[feedback] GitHub webhook queue unavailable', {
      errorName: error instanceof Error ? error.name : 'unknown',
    });
    sendJson(res, 503, { error: 'Try again later' });
  }
}
