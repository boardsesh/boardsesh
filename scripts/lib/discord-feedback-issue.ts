/// <reference types="node" />

import { redactSensitiveText } from '@boardsesh/text-redaction';

import { clampDiscordMessage, type CollectBundle } from './discord-feedback';

export const ISSUE_BODY_LIMIT = 60_000;
export const MAX_ISSUES_PER_COMMAND = 5;
const TITLE_LIMIT = 120;
const MIN_TITLE_LENGTH = 8;

export const TRIAGE_VERDICTS = ['bug', 'feature', 'duplicate'] as const;
export type TriageVerdict = (typeof TRIAGE_VERDICTS)[number];
const VERDICTS: ReadonlySet<string> = new Set(TRIAGE_VERDICTS);

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

export const REQUIRED_LABELS = ['from-discord', 'user-feedback'] as const;

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
  commandMessageId: string;
  issueIndex: number;
  verdict: TriageVerdict;
  title: string;
  body: string;
  labels: string[];
  duplicateOf: string | null;
  rationale: string;
};

export type RejectedDecision = {
  issueIndex: number | null;
  reason: string;
};

export type IssueDraft = {
  commandMessageId: string;
  issueIndex: number;
  marker: string;
  title: string;
  body: string;
  labels: string[];
};

export type AppliedIssue = {
  kind: 'filed' | 'duplicate';
  title: string;
  issueUrl: string;
};

export function discordFeedbackMarker(commandMessageId: string, issueIndex: number): string {
  return `<!-- discord-feedback:${commandMessageId}:${issueIndex} -->`;
}

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
  const issueKind = verdict === 'feature' ? 'enhancement' : 'bug';
  return [...new Set([...allowed, issueKind, ...REQUIRED_LABELS])].sort();
}

const GITHUB_ISSUE_URL = /^https:\/\/github\.com\/boardsesh\/boardsesh\/issues\/\d+$/;

export function isGitHubIssueUrl(value: string): boolean {
  return GITHUB_ISSUE_URL.test(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

const DECISION_KEYS: ReadonlySet<string> = new Set([
  'commandMessageId',
  'issueIndex',
  'verdict',
  'title',
  'body',
  'labels',
  'duplicateOf',
  'rationale',
]);

/**
 * This is an all-or-nothing boundary. The apply step performs no writes unless
 * every model-produced decision passes and the indexes form 1..N.
 */
export function validateTriageResult(
  raw: unknown,
  bundle: CollectBundle,
): { accepted: TriageDecision[]; rejected: RejectedDecision[] } {
  const accepted: TriageDecision[] = [];
  const rejected: RejectedDecision[] = [];
  const root = asRecord(raw);
  if (root && Object.keys(root).some((key) => key !== 'decisions')) {
    return { accepted, rejected: [{ issueIndex: null, reason: 'unexpected field beside decisions' }] };
  }
  const rawDecisions = root?.decisions;
  if (!Array.isArray(rawDecisions)) {
    return { accepted, rejected: [{ issueIndex: null, reason: 'decisions is not an array' }] };
  }
  if (rawDecisions.length === 0 || rawDecisions.length > MAX_ISSUES_PER_COMMAND) {
    return {
      accepted,
      rejected: [
        {
          issueIndex: null,
          reason: `decisions must contain between 1 and ${MAX_ISSUES_PER_COMMAND} entries`,
        },
      ],
    };
  }

  for (const entry of rawDecisions) {
    const decision = asRecord(entry);
    const rawIndex = decision?.issueIndex;
    const issueIndex = typeof rawIndex === 'number' && Number.isSafeInteger(rawIndex) ? rawIndex : null;
    if (!decision || issueIndex === null) {
      rejected.push({ issueIndex, reason: 'decision is not an object with an integer issueIndex' });
      continue;
    }
    const unexpectedKey = Object.keys(decision).find((key) => !DECISION_KEYS.has(key));
    if (unexpectedKey) {
      rejected.push({ issueIndex, reason: `unexpected field "${unexpectedKey}"` });
      continue;
    }
    if (decision.commandMessageId !== bundle.command.messageId) {
      rejected.push({ issueIndex, reason: 'commandMessageId does not match the collected command' });
      continue;
    }

    const verdict = typeof decision.verdict === 'string' ? decision.verdict : '';
    if (!VERDICTS.has(verdict)) {
      rejected.push({ issueIndex, reason: `unknown verdict "${verdict}"` });
      continue;
    }
    const typedVerdict = verdict as TriageVerdict;
    if (
      typeof decision.title !== 'string' ||
      typeof decision.body !== 'string' ||
      !Array.isArray(decision.labels) ||
      !decision.labels.every((label) => typeof label === 'string' && LABEL_ALLOWLIST.has(label)) ||
      typeof decision.rationale !== 'string'
    ) {
      rejected.push({ issueIndex, reason: 'title, body, labels, or rationale is missing or invalid' });
      continue;
    }
    const title = normalizeTitle(decision.title);
    const body = stripHtmlComments(decision.body).trim();
    const duplicateOf =
      typeof decision.duplicateOf === 'string' && isGitHubIssueUrl(decision.duplicateOf) ? decision.duplicateOf : null;

    if (typedVerdict === 'duplicate') {
      if (duplicateOf === null) {
        rejected.push({ issueIndex, reason: 'duplicate decision has no valid GitHub issue URL' });
        continue;
      }
    } else {
      if (decision.duplicateOf !== null) {
        rejected.push({ issueIndex, reason: 'new issue decision must set duplicateOf to null' });
        continue;
      }
      if (title.length < MIN_TITLE_LENGTH || body.length === 0) {
        rejected.push({ issueIndex, reason: 'filed issue needs a usable title and body' });
        continue;
      }
    }

    accepted.push({
      commandMessageId: bundle.command.messageId,
      issueIndex,
      verdict: typedVerdict,
      title,
      body,
      labels: normalizeLabels(decision.labels, typedVerdict),
      duplicateOf,
      rationale: decision.rationale,
    });
  }

  const indexes = accepted.map((decision) => decision.issueIndex).sort((left, right) => left - right);
  const indexesAreSequential =
    indexes.length === rawDecisions.length && indexes.every((issueIndex, offset) => issueIndex === offset + 1);
  if (!indexesAreSequential) {
    rejected.push({ issueIndex: null, reason: 'issueIndex values must be unique and sequential from 1' });
  }

  return { accepted: rejected.length === 0 ? accepted.sort((a, b) => a.issueIndex - b.issueIndex) : [], rejected };
}

export function buildIssueDraft(
  decision: TriageDecision,
  bundle: CollectBundle,
  attachmentUrls: string[] = [],
): IssueDraft {
  if (!bundle.source.jumpUrl.startsWith('https://discord.com/channels/')) {
    throw new Error(`Refusing to file issue ${decision.issueIndex}: no Discord source link.`);
  }

  const marker = discordFeedbackMarker(bundle.command.messageId, decision.issueIndex);
  const channel = bundle.source.channelName ? `#${bundle.source.channelName}` : 'Discord';
  const sourceLines = [
    '## Source',
    '',
    `[Feedback in ${channel} on Discord](${bundle.source.jumpUrl}).`,
    '',
    `Reporter: \`${bundle.source.authorRef}\` · Posted: ${bundle.source.timestamp || 'unknown'}`,
  ];
  if (bundle.command.jumpUrl !== bundle.source.jumpUrl) {
    sourceLines.push('', `[Issue requested from Discord](${bundle.command.jumpUrl}).`);
  }

  const attachmentBlock =
    attachmentUrls.length > 0
      ? `\n\n## Attachments\n\n${attachmentUrls.map((url, index) => `![attachment ${index + 1}](${url})`).join('\n')}`
      : '';
  const prose = [marker, redactSensitiveText(decision.body), '', sourceLines.join('\n')].join('\n');
  const proseBudget = ISSUE_BODY_LIMIT - attachmentBlock.length;
  const clampedProse = prose.length > proseBudget ? `${prose.slice(0, Math.max(0, proseBudget - 3))}...` : prose;

  return {
    commandMessageId: bundle.command.messageId,
    issueIndex: decision.issueIndex,
    marker,
    title: redactSensitiveText(decision.title),
    body: `${clampedProse}${attachmentBlock}`,
    labels: decision.labels,
  };
}

export function buildReplyMessage(outcomes: AppliedIssue[], hadAttachments: boolean): string {
  const heading = outcomes.length === 1 ? 'Done — here’s the issue:' : `Done — here are the ${outcomes.length} issues:`;
  const lines = outcomes.map((outcome) =>
    outcome.kind === 'duplicate' ? `- Already tracked: ${outcome.issueUrl}` : `- ${outcome.title}: ${outcome.issueUrl}`,
  );
  if (hadAttachments) lines.push('Screenshots were copied to the public tracker.');
  return clampDiscordMessage([heading, ...lines].join('\n'));
}
