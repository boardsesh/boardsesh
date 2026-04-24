/**
 * Discord webhook forwarding for user-submitted feedback.
 *
 * Posts a compact embed to a single webhook URL. Fire-and-forget: a slow or
 * broken Discord endpoint must never fail the originating mutation.
 *
 * Privacy: the payload intentionally omits userId, username, and email. Only
 * the feedback row id is included so a moderator can correlate the Discord
 * message with a DB row by id alone.
 */

import type { AppFeedbackPlatform, AppFeedbackSource } from '@boardsesh/shared-schema';

const BUG_SOURCES: ReadonlySet<AppFeedbackSource> = new Set(['shake_bug', 'drawer_bug']);

const COLOR_GREEN = 0x57f287;
const COLOR_YELLOW = 0xfee75c;
const COLOR_RED = 0xed4245;

export type FeedbackDiscordPayload = {
  feedbackId: string | number | bigint;
  rating: number | null;
  comment: string | null;
  platform: AppFeedbackPlatform;
  appVersion: string | null;
  source: AppFeedbackSource;
};

/** @internal exported for testing only; do not call from resolver code. */
export function buildWebhookBody(payload: FeedbackDiscordPayload): Record<string, unknown> {
  const isBug = BUG_SOURCES.has(payload.source);
  const title = isBug ? '🐞 Bug report' : `⭐ Rating: ${payload.rating ?? '?'}/5`;
  const color = isBug
    ? COLOR_RED
    : payload.rating !== null && payload.rating >= 4
      ? COLOR_GREEN
      : payload.rating !== null && payload.rating >= 3
        ? COLOR_YELLOW
        : COLOR_RED;

  return {
    username: 'Boardsesh Feedback',
    embeds: [
      {
        title,
        description: payload.comment ?? '(no comment)',
        color,
        fields: [
          { name: 'Platform', value: payload.platform, inline: true },
          { name: 'Source', value: payload.source, inline: true },
          { name: 'App version', value: payload.appVersion ?? 'unknown', inline: true },
        ],
        footer: { text: `feedback #${payload.feedbackId}` },
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

/**
 * Post a feedback row to the Discord webhook. Never throws.
 * Safe to call without `await` — errors are logged and swallowed.
 */
export async function postFeedbackToDiscord(payload: FeedbackDiscordPayload): Promise<void> {
  const url = process.env.DISCORD_FEEDBACK_URL;
  if (!url) return;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildWebhookBody(payload)),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '<unreadable>');
      console.error(`[Discord] Webhook POST failed: ${response.status} ${errorText}`);
    }
  } catch (error) {
    console.error('[Discord] Webhook POST error:', error);
  }
}
