/// <reference types="node" />

/** Dependency-free deployment outbox. Keep webhook credentials in trusted notification jobs. */
import { createHash } from 'node:crypto';
import { object, string } from './ota-publish-protocol.ts';

export const DEPLOYMENT_EVENT_KINDS = [
  'train-cut',
  'train-published',
  'candidate-frozen',
  'qa-passed',
  'qa-rejected',
  'canary-started',
  'rollout-increased',
  'rollout-finished',
  'rollout-reverted',
  'aborted',
  'hold',
  'failed',
] as const;
export interface DeploymentEvent {
  id: string;
  kind: (typeof DEPLOYMENT_EVENT_KINDS)[number];
  branch: string;
  commit?: string;
  version?: string;
  platform?: 'ios' | 'android';
  runtimeVersion?: string;
  percentage?: number;
  reason?: string;
  runUrl?: string;
}
export interface DeploymentOutbox {
  pending: DeploymentEvent[];
  sent: string[];
  lastHoldReason: string | null;
}
export const emptyDeploymentOutbox = (): DeploymentOutbox => ({ pending: [], sent: [], lastHoldReason: null });

export function parseDeploymentEvent(input: unknown): DeploymentEvent {
  const parsed = object(input, 'Deployment event');
  if (!DEPLOYMENT_EVENT_KINDS.includes(parsed.kind as DeploymentEvent['kind']))
    throw new Error('Unknown deployment event.');
  const id = string(parsed.id, 'Event ID');
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid deployment event ID.');
  const branch = string(parsed.branch, 'Deployment branch');
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch)) throw new Error('Invalid deployment branch.');
  const event: DeploymentEvent = { id, kind: parsed.kind as DeploymentEvent['kind'], branch };
  for (const field of ['commit', 'version', 'runtimeVersion', 'reason', 'runUrl'] as const) {
    if (parsed[field] !== undefined) event[field] = string(parsed[field], `Event ${field}`);
  }
  if (event.commit && !/^[a-f0-9]{40}$/.test(event.commit)) throw new Error('Deployment commit must be a full SHA.');
  if (event.runtimeVersion && !/^[a-f0-9]{40}$/.test(event.runtimeVersion))
    throw new Error('Invalid deployment runtime.');
  if (event.runUrl && !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+$/.test(event.runUrl))
    throw new Error('Deployment event must link to a GitHub Actions run.');
  if (parsed.platform !== undefined) {
    if (parsed.platform !== 'ios' && parsed.platform !== 'android') throw new Error('Invalid event platform.');
    event.platform = parsed.platform;
  }
  if (parsed.percentage !== undefined) {
    if (
      typeof parsed.percentage !== 'number' ||
      !Number.isInteger(parsed.percentage) ||
      parsed.percentage < 0 ||
      parsed.percentage > 100
    )
      throw new Error('Invalid event percentage.');
    event.percentage = parsed.percentage;
  }
  return event;
}
export function parseDeploymentOutbox(input: unknown): DeploymentOutbox {
  if (input === undefined) return emptyDeploymentOutbox(); // Existing v1 stable checkpoints.
  const parsed = object(input, 'Deployment outbox');
  if (!Array.isArray(parsed.pending) || !Array.isArray(parsed.sent)) throw new Error('Invalid deployment outbox.');
  const pending = parsed.pending.map(parseDeploymentEvent);
  const sent = parsed.sent.map((identifier) => {
    const id = string(identifier, 'Delivered event ID');
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid delivered event ID.');
    return id;
  });
  if (new Set(pending.map((event) => event.id)).size !== pending.length || new Set(sent).size !== sent.length)
    throw new Error('Duplicate deployment event IDs.');
  const lastHoldReason = parsed.lastHoldReason === null ? null : string(parsed.lastHoldReason, 'Last hold reason');
  return { pending, sent, lastHoldReason };
}
export function queueDeploymentEvent(outbox: DeploymentOutbox, input: Omit<DeploymentEvent, 'id'>, key: string): void {
  // Proof/scratch branches must never generate production deployment messages.
  if (!['production', 'main'].includes(input.branch)) return;
  const id = createHash('sha256').update(key).digest('hex');
  if (outbox.sent.includes(id) || outbox.pending.some((event) => event.id === id)) return;
  outbox.pending.push(parseDeploymentEvent({ ...input, id }));
}
export function githubRunUrl(environment: NodeJS.ProcessEnv): string | undefined {
  const repository = environment.GITHUB_REPOSITORY;
  const runId = environment.GITHUB_RUN_ID;
  return repository && runId ? `https://github.com/${repository}/actions/runs/${runId}` : undefined;
}
/** API error bodies can contain credentials. Keep them in masked run logs, never webhook messages. */
export function deploymentFailureReason(operation: string, error: unknown): string {
  const status = error instanceof Error ? /\bHTTP[ ):]*(\d{3})\b/.exec(error.message)?.[1] : undefined;
  return `${operation} failed${status ? ` (HTTP ${status})` : ''}; inspect the Actions run. Confirmed platform changes are reported separately.`;
}
export function deploymentMessage(event: DeploymentEvent): string {
  return [
    `**OTA ${event.kind.replaceAll('-', ' ')}** · ${event.branch}`,
    [
      event.version,
      event.commit?.slice(0, 8),
      event.platform,
      event.percentage === undefined ? undefined : `${event.percentage}%`,
    ]
      .filter(Boolean)
      .join(' · '),
    event.runtimeVersion ? `Runtime: ${event.runtimeVersion}` : undefined,
    event.reason?.slice(0, 1200),
    event.runUrl,
  ]
    .filter(Boolean)
    .join('\n');
}
/** Persist after each confirmed Discord delivery. Failure leaves unsent events available for a future run. */
export async function deliverDeploymentEvents(options: {
  outbox: DeploymentOutbox;
  webhook: string | undefined;
  save: () => void;
  fetcher?: typeof fetch;
}): Promise<void> {
  if (options.outbox.pending.length === 0) return;
  if (!options.webhook) throw new Error('DISCORD_DEPLOY_WEBHOOK is missing; deployment events remain pending.');
  const deliveries = [...options.outbox.pending];
  for (const event of deliveries) {
    if (!options.outbox.sent.includes(event.id)) {
      const response = await (options.fetcher ?? fetch)(options.webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: deploymentMessage(event), allowed_mentions: { parse: [] } }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok)
        throw new Error(`Discord delivery returned HTTP ${response.status}; event ${event.id} remains pending.`);
      options.outbox.sent.push(event.id);
    }
    // A sent receipt wins over a stale pending copy, which needs no second post.
    options.outbox.pending = options.outbox.pending.filter((pending) => pending.id !== event.id);
    // Commit each receipt before the next post so a later failure cannot replay it.
    options.save();
  }
}
