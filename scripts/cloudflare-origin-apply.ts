/// <reference types="node" />
import { pathToFileURL } from 'node:url';

const ZONE_ID = '2ffcc52b2e8c604fd85b9faa8efc18bf';
const PHASE = 'http_request_late_transform';
const MARKER = 'boardsesh:verify-web-origin (managed by scripts/cloudflare-origin-apply.ts)';
const HEADER = 'x-boardsesh-origin-verify';

type TransformRule = {
  id?: string;
  description?: string;
  action?: string;
  expression?: string;
  enabled?: boolean;
  action_parameters?: { headers?: Record<string, { operation: string; value?: string }> };
};
type Ruleset = { id: string; rules?: TransformRule[] };

export function originRule(secret: string): TransformRule {
  if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error('Origin secret must be 32 random bytes encoded as hex');
  return {
    description: MARKER,
    expression: '(http.host eq "www.boardsesh.com")',
    action: 'rewrite',
    enabled: true,
    action_parameters: { headers: { [HEADER]: { operation: 'set', value: secret } } },
  };
}

/** Reports only action/ID, never current or desired header values. */
export function planOriginRule(
  rules: TransformRule[],
  secret: string,
): { action: 'create' | 'update' | 'none'; id?: string } {
  const desired = originRule(secret);
  const owned = rules.filter((rule) => rule.description === MARKER);
  if (owned.length > 1) throw new Error('Duplicate managed origin rules require review');
  if (
    rules.some(
      (rule) =>
        rule.description !== MARKER &&
        Object.keys(rule.action_parameters?.headers ?? {}).some((header) => header.toLowerCase() === HEADER),
    )
  ) {
    throw new Error('Another rule modifies the origin header; resolve ownership before applying');
  }
  const current = owned[0];
  if (!current) return { action: 'create' };
  if (!current.id) throw new Error('Managed origin rule is missing its ID');
  const matches =
    current.action === desired.action &&
    current.expression === desired.expression &&
    current.enabled === true &&
    JSON.stringify(current.action_parameters) === JSON.stringify(desired.action_parameters);
  return { action: matches ? 'none' : 'update', id: current.id };
}

export async function applyOriginRule(env: Record<string, string | undefined>, apply: boolean): Promise<string> {
  const token = env.CLOUDFLARE_API_TOKEN;
  const secret = env.WEB_ORIGIN_VERIFY_SECRET ?? '';
  const desired = originRule(secret);
  if (!token) throw new Error('CLOUDFLARE_API_TOKEN is required');
  async function api<Result>(path: string, method = 'GET', body?: unknown): Promise<Result | null> {
    let response: Response;
    try {
      response = await fetch(`https://api.cloudflare.com/client/v4/zones/${ZONE_ID}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new Error('Cloudflare origin-rule request failed; response details withheld');
    }
    if (method === 'GET' && response.status === 404) return null;
    // Never print API bodies: they can echo the secret-bearing rule.
    if (!response.ok)
      throw new Error(`Cloudflare origin-rule request failed (HTTP ${response.status}); response withheld`);
    let payload: { success: boolean; result: Result };
    try {
      payload = (await response.json()) as { success: boolean; result: Result };
    } catch {
      throw new Error('Cloudflare origin-rule response was invalid JSON; response withheld');
    }
    if (!payload.success) throw new Error('Cloudflare origin-rule API returned failure; response withheld');
    return payload.result;
  }
  const current = await api<Ruleset>(`/rulesets/phases/${PHASE}/entrypoint`);
  const plan = planOriginRule(current?.rules ?? [], secret);
  if (!apply || plan.action === 'none') return `${apply ? 'Apply' : 'Dry run'}: ${plan.action} origin header rule`;
  if (!current) {
    await api('/rulesets', 'POST', { name: 'Boardsesh request headers', kind: 'zone', phase: PHASE, rules: [desired] });
  } else if (plan.action === 'create') {
    await api(`/rulesets/${current.id}/rules`, 'POST', desired);
  } else {
    await api(`/rulesets/${current.id}/rules/${plan.id}`, 'PATCH', desired);
  }
  const verified = await api<Ruleset>(`/rulesets/phases/${PHASE}/entrypoint`);
  if (!verified || planOriginRule(verified.rules ?? [], secret).action !== 'none')
    throw new Error('Origin header read-back verification failed');
  return 'Applied and verified origin header rule';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  applyOriginRule(process.env, process.argv.includes('--apply'))
    .then(console.log)
    .catch((error: unknown) => {
      // Only our sanitized errors are emitted. Never stringify request objects.
      console.error(error instanceof Error ? error.message : 'Origin rule failed');
      process.exitCode = 1;
    });
}
