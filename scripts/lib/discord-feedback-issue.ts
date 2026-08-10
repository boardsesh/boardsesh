/// <reference types="node" />

/**
 * Pure issue-shaping and triage-validation for the Discord feedback scanner.
 *
 * The triage step is an LLM reading text typed by anyone who can click a public
 * Discord invite, so nothing it returns is trusted. `validateTriageResult` is
 * the boundary: every decision is checked against the bundle the scanner itself
 * produced, and anything unrecognised is dropped with a reason rather than
 * filed.
 */

import { redactSensitiveText } from '@boardsesh/text-redaction';

import { clampDiscordMessage, type CollectedMessage } from './discord-feedback';

export const ISSUE_BODY_LIMIT = 60_000;
const TITLE_LIMIT = 120;
const MIN_TITLE_LENGTH = 8;

/** Verdicts the classifier may return. Only bug/feature ever become issues. */
export const TRIAGE_VERDICTS = ['bug', 'feature', 'question', 'noise', 'duplicate'] as const;
export type TriageVerdict = (typeof TRIAGE_VERDICTS)[number];

const VERDICTS: ReadonlySet<string> = new Set(TRIAGE_VERDICTS);

/** Verdicts that result in a filed issue. */
const FILING_VERDICTS: ReadonlySet<string> = new Set(['bug', 'feature']);

/**
 * Labels the model is allowed to request. Anything outside this set is dropped
 * rather than created — an injected prompt must not be able to mint labels.
 */
export const LABEL_ALLOWLIST: ReadonlySet<string> = new Set([
  'android',
  'bug',
  'enhancement',
  'from-discord',
  'ios',
  'mobile',
  'priority:P0',
  'priority:P1',
  'priority:P2',
  'priority:P3',
  'user-feedback',
  'web',
]);

/** Applied to every filed issue regardless of what the model asked for. */
export const REQUIRED_LABELS = ['from-discord', 'user-feedback'] as const;

// Colors mirror the TestFlight→issues sync (scripts/testflight-feedback-to-issues.ts)
// and the in-app bug-report path (packages/backend/src/services/github-feedback.ts)
// so labels created by any of the three look consistent.
export const LABEL_COLORS: Record<string, string> = {
  android: '0e8a16',
  bug: 'd73a4a',
  enhancement: 'a2eeef',
  'from-discord': '5865f2',
  ios: '1d76db',
  mobile: 'c5def5',
  'priority:P0': 'b60205',
  'priority:P1': 'd93f0b',
  'priority:P2': 'fbca04',
  'priority:P3': 'c2e0c6',
  'user-feedback': 'fbca04',
  web: '5319e7',
};

export type TriageDecision = {
  messageId: string;
  verdict: TriageVerdict;
  title: string;
  body: string;
  labels: string[];
  /** Set when verdict is `duplicate`: the issue this repeats. */
  duplicateOf: string | null;
  /** Why the classifier landed here. Recorded in logs, not in the issue. */
  rationale: string;
};

export type RejectedDecision = {
  messageId: string | null;
  reason: string;
};

export type IssueDraft = {
  messageId: string;
  marker: string;
  title: string;
  body: string;
  labels: string[];
};

/**
 * Idempotency marker, written as the issue body's first line.
 *
 * Backstop to the processed reaction: if the process dies after filing but
 * before reacting, the next run finds this via GitHub search and reacts instead
 * of filing a second issue. GitHub search is the state store — no state file.
 */
export function discordFeedbackMarker(messageId: string): string {
  return `<!-- discord-feedback:${messageId} -->`;
}

/**
 * Strip HTML comments from model-supplied text.
 *
 * Without this the model could emit a marker naming a different message id and
 * make the next run skip a real report — or make this run look like a duplicate
 * of something it isn't.
 */
function stripHtmlComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, '');
}

function normalizeTitle(rawTitle: string): string {
  const collapsed = stripHtmlComments(rawTitle).replace(/\s+/g, ' ').trim();
  if (collapsed.length <= TITLE_LIMIT) return collapsed;
  return `${collapsed.slice(0, TITLE_LIMIT - 3).trimEnd()}...`;
}

function normalizeLabels(rawLabels: unknown, verdict: TriageVerdict): string[] {
  const requested = Array.isArray(rawLabels)
    ? rawLabels.filter((label): label is string => typeof label === 'string')
    : [];
  const allowed = requested.filter((label) => LABEL_ALLOWLIST.has(label));
  const kind = verdict === 'feature' ? 'enhancement' : 'bug';
  return [...new Set([...allowed, kind, ...REQUIRED_LABELS])].sort();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * Validate the model's decisions against the bundle we handed it.
 *
 * Anything referencing a message we didn't collect, or repeating a message we
 * already accepted, is rejected — an injected prompt must not be able to invent
 * targets or amplify one message into many issues.
 */
export function validateTriageResult(
  raw: unknown,
  bundle: { messages: CollectedMessage[] },
): { accepted: TriageDecision[]; rejected: RejectedDecision[] } {
  const accepted: TriageDecision[] = [];
  const rejected: RejectedDecision[] = [];

  const root = asRecord(raw);
  const rawDecisions = root?.decisions;
  if (!Array.isArray(rawDecisions)) {
    return { accepted, rejected: [{ messageId: null, reason: 'decisions is not an array' }] };
  }

  const knownIds = new Set(bundle.messages.map((message) => message.messageId));
  const seenIds = new Set<string>();

  for (const entry of rawDecisions) {
    const decision = asRecord(entry);
    if (!decision) {
      rejected.push({ messageId: null, reason: 'decision is not an object' });
      continue;
    }

    const messageId = typeof decision.messageId === 'string' ? decision.messageId : null;
    if (!messageId) {
      rejected.push({ messageId: null, reason: 'missing messageId' });
      continue;
    }
    if (!knownIds.has(messageId)) {
      rejected.push({ messageId, reason: 'messageId is not in the collected bundle' });
      continue;
    }
    if (seenIds.has(messageId)) {
      rejected.push({ messageId, reason: 'duplicate decision for the same message' });
      continue;
    }

    const verdict = typeof decision.verdict === 'string' ? decision.verdict : '';
    if (!VERDICTS.has(verdict)) {
      rejected.push({ messageId, reason: `unknown verdict "${verdict}"` });
      continue;
    }

    const typedVerdict = verdict as TriageVerdict;
    const title = normalizeTitle(typeof decision.title === 'string' ? decision.title : '');
    const body = stripHtmlComments(typeof decision.body === 'string' ? decision.body : '').trim();

    if (FILING_VERDICTS.has(typedVerdict)) {
      if (title.length < MIN_TITLE_LENGTH) {
        rejected.push({ messageId, reason: 'title is missing or too short for a filed issue' });
        continue;
      }
      if (!body) {
        rejected.push({ messageId, reason: 'body is empty for a filed issue' });
        continue;
      }
    }

    seenIds.add(messageId);
    accepted.push({
      messageId,
      verdict: typedVerdict,
      title,
      body,
      labels: normalizeLabels(decision.labels, typedVerdict),
      duplicateOf: typeof decision.duplicateOf === 'string' ? decision.duplicateOf : null,
      rationale: typeof decision.rationale === 'string' ? decision.rationale : '',
    });
  }

  return { accepted, rejected };
}

const TRIGGER_LABELS: Record<CollectedMessage['trigger'], string> = {
  'feedback-channel': 'posted in the feedback channel',
  reaction: 'flagged with a reaction',
  'thread-keyword': 'flagged in a thread',
};

/**
 * Build the GitHub issue for an accepted decision.
 *
 * The Source block is mandatory: an issue nobody can trace back to the
 * conversation it came from can't be followed up on, so this throws rather than
 * filing one. The model's prose is re-redacted here because it may echo
 * something from the input that slipped through the first pass.
 */
export function buildIssueDraft(
  decision: TriageDecision,
  message: CollectedMessage,
  attachmentUrls: string[] = [],
): IssueDraft {
  if (!message.jumpUrl || !message.jumpUrl.startsWith('https://discord.com/channels/')) {
    throw new Error(`Refusing to file issue for ${message.messageId}: no Discord jump link to link back to.`);
  }

  const marker = discordFeedbackMarker(message.messageId);
  const channel = message.channelName ? `#${message.channelName}` : 'Discord';
  const sourceLines = [
    '## Source',
    '',
    `[Reported in ${channel} on Discord](${message.jumpUrl}) — ${TRIGGER_LABELS[message.trigger]}.`,
    '',
    `Reporter: \`${message.authorRef}\` · Posted: ${message.timestamp || 'unknown'}`,
  ];

  if (message.threadId && message.threadId !== message.messageId) {
    sourceLines.push('', `Thread: ${`https://discord.com/channels/${message.guildId}/${message.threadId}`}`);
  }

  const parts = [marker, redactSensitiveText(decision.body), '', sourceLines.join('\n')];

  if (attachmentUrls.length > 0) {
    parts.push('', '## Attachments', '', ...attachmentUrls.map((url, index) => `![attachment ${index + 1}](${url})`));
  }

  const body = parts.join('\n');

  return {
    messageId: message.messageId,
    marker,
    title: decision.title,
    body: body.length > ISSUE_BODY_LIMIT ? `${body.slice(0, ISSUE_BODY_LIMIT - 3)}...` : body,
    labels: decision.labels,
  };
}

export type ReplyOutcome =
  | { kind: 'filed'; issueUrl: string; hadAttachments: boolean }
  | { kind: 'duplicate'; issueUrl: string }
  | { kind: 'acknowledged' };

/**
 * The message the bot posts back in Discord.
 *
 * Reporters who never hear anything stop reporting, so a filed issue always
 * gets a link back. When a screenshot was re-hosted we say so plainly — it went
 * onto a public tracker and the person who posted it should know.
 */
export function buildReplyMessage(outcome: ReplyOutcome): string {
  if (outcome.kind === 'filed') {
    const lines = [`Thanks — logged this as ${outcome.issueUrl}`];
    if (outcome.hadAttachments) {
      lines.push('Your screenshot is attached to that issue, which is public. Say the word and we can pull it.');
    }
    return clampDiscordMessage(lines.join('\n'));
  }
  if (outcome.kind === 'duplicate') {
    return clampDiscordMessage(`Thanks — we're already tracking this one at ${outcome.issueUrl}`);
  }
  return clampDiscordMessage('Thanks — read and noted.');
}
