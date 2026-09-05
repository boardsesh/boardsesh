/**
 * Which PRs are still building their OTA preview bundle.
 *
 * `mobile-ota-preview.yml` opens a GitHub deployment in the `pr-preview`
 * environment before it publishes (`Start deployment (preview building)`) and
 * finalizes it afterwards, so the deployment — not a PR comment — is that
 * workflow's authoritative state store; its own fork reconciler and cleanup job
 * both key off it. We read the same thing rather than inventing a second
 * signal.
 *
 * Why this exists: the mobile PR switcher builds its list from xprem's
 * published branches, so a PR whose bundle is mid-publish has no branch yet and
 * is simply absent. A tester who just pushed sees nothing.
 *
 * GraphQL, not REST: `GET /repos/{repo}/deployments` omits the state, which
 * would mean one extra status call per deployment on every refill.
 *
 * Never throws. GitHub's GraphQL API has no anonymous tier, so a deploy with no
 * App configured gets an empty map and no build states — the switcher then
 * behaves exactly as it did before this existed.
 */

import type { QaOtaBuildState } from '@boardsesh/shared-schema';
import { resolveGithubToken, resolveGithubRepo } from '../lib/github-client';
import { logger } from '../utils/logger';

// Re-exported, not redefined: the SDL owns this union. A local copy would stay
// structurally compatible right up until someone adds a state to one and not
// the other, and the resolver would then serve a value the schema has no enum
// member for.
export type { QaOtaBuildState };

const GITHUB_GRAPHQL = 'https://api.github.com/graphql';

/**
 * Concurrent readers share one in-flight promise and the error cache only
 * starts ticking once a call settles, so an unresponsive GitHub would otherwise
 * park every `qaPreviews` response behind an OS-level TCP timeout — minutes,
 * for a field that only decorates rows. Ten seconds is far longer than a
 * healthy call and far shorter than a tester will wait.
 */
const REQUEST_TIMEOUT_MS = 10_000;

/** Matches the workflow's `description: OTA preview pr-N`. */
const DEPLOYMENT_DESCRIPTION_RE = /^OTA preview pr-([1-9]\d*)$/;

/**
 * One page, newest first, and deliberately not paginated.
 *
 * The only state that produces a row of its own is `building`, and a build in
 * flight is by construction among the newest deployments in the repo — the
 * workflow opens the deployment moments before it publishes. So the case this
 * page can miss is an older PR's settled `ready` / `unavailable` state, which
 * degrades to `unknown` and renders nothing, exactly as before this existed.
 * Paginating would spend requests to decorate rows nobody is waiting on.
 */
const PAGE_SIZE = 100;
const CACHE_TTL_MS = 60 * 1000;
// Same reasoning as the QA pull-request reader: a GitHub error must not
// amplify into a request storm behind a burst of testers.
const ERROR_CACHE_TTL_MS = 30 * 1000;

type DeploymentNode = {
  description?: string | null;
  createdAt?: string | null;
  latestStatus?: { state?: string | null } | null;
};

type DeploymentsResponse = {
  data?: { repository?: { deployments?: { nodes?: (DeploymentNode | null)[] | null } | null } | null };
  errors?: { message?: string }[];
};

const DEPLOYMENTS_QUERY = `
  query OtaPreviewDeployments($owner: String!, $name: String!, $first: Int!) {
    repository(owner: $owner, name: $name) {
      deployments(
        environments: ["pr-preview"]
        first: $first
        orderBy: { field: CREATED_AT, direction: DESC }
      ) {
        nodes {
          description
          createdAt
          latestStatus { state }
        }
      }
    }
  }
`;

/** GitHub's `DeploymentStatusState`, reduced to what a tester needs to see. */
export function toOtaBuildState(githubState: string | null | undefined): QaOtaBuildState {
  switch (githubState) {
    case 'QUEUED':
    case 'PENDING':
    case 'IN_PROGRESS':
      return 'building';
    case 'SUCCESS':
    case 'ACTIVE':
      return 'ready';
    case 'FAILURE':
    case 'ERROR':
      return 'failed';
    case 'INACTIVE':
      return 'unavailable';
    default:
      return 'unknown';
  }
}

/**
 * `prNumber -> state`, newest deployment per PR.
 *
 * The nodes arrive newest-first, so the first one seen for a PR wins and every
 * older deployment for it is skipped — a PR that has been rebuilt ten times
 * reports only its current attempt.
 */
export function buildOtaBuildStates(nodes: readonly (DeploymentNode | null)[]): Map<number, QaOtaBuildState> {
  const stateByPrNumber = new Map<number, QaOtaBuildState>();
  for (const node of nodes) {
    const matched = DEPLOYMENT_DESCRIPTION_RE.exec(node?.description ?? '');
    if (!matched) continue;
    const prNumber = Number(matched[1]);
    if (stateByPrNumber.has(prNumber)) continue;
    stateByPrNumber.set(prNumber, toOtaBuildState(node?.latestStatus?.state));
  }
  return stateByPrNumber;
}

type StateCache = { at: number; states: Map<number, QaOtaBuildState>; isError: boolean };
let stateCache: StateCache | null = null;
let inFlightStates: Promise<Map<number, QaOtaBuildState>> | null = null;

async function fetchOtaBuildStates(): Promise<Map<number, QaOtaBuildState>> {
  const token = await resolveGithubToken();
  // No anonymous tier on GitHub GraphQL. Not an error — just no decoration.
  if (!token) return new Map();

  const [owner, name] = resolveGithubRepo().split('/');
  if (!owner || !name) return new Map();

  const response = await fetch(GITHUB_GRAPHQL, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      // No `X-GitHub-Api-Version`, unlike the REST calls elsewhere: GraphQL is
      // a single versionless schema and ignores it.
      'User-Agent': 'boardsesh-backend',
    },
    body: JSON.stringify({ query: DEPLOYMENTS_QUERY, variables: { owner, name, first: PAGE_SIZE } }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`GitHub GraphQL deployments responded ${response.status}`);
  }

  const payload = (await response.json()) as DeploymentsResponse;
  // GraphQL answers 200 with an `errors` array, so a non-2xx check is not enough.
  if (payload.errors?.length) {
    throw new Error(`GitHub GraphQL deployments: ${payload.errors.map((entry) => entry.message).join('; ')}`);
  }
  return buildOtaBuildStates(payload.data?.repository?.deployments?.nodes ?? []);
}

/**
 * Current OTA build state per PR, cached for {@link CACHE_TTL_MS}. Never
 * throws: on failure the caller gets an empty map, which reads as "no build
 * information", and the switcher degrades to the branch list alone.
 */
export async function readOtaBuildStates(now: number = Date.now()): Promise<ReadonlyMap<number, QaOtaBuildState>> {
  const ttl = stateCache?.isError ? ERROR_CACHE_TTL_MS : CACHE_TTL_MS;
  if (stateCache && now - stateCache.at < ttl) return stateCache.states;
  if (inFlightStates) return inFlightStates;

  inFlightStates = (async () => {
    try {
      const states = await fetchOtaBuildStates();
      stateCache = { at: now, states, isError: false };
      return states;
    } catch (error) {
      logger.warn('[qa] OTA deployment lookup failed; serving no build states:', error);
      stateCache = { at: now, states: new Map(), isError: true };
      return new Map<number, QaOtaBuildState>();
    } finally {
      inFlightStates = null;
    }
  })();
  return inFlightStates;
}

/** PRs whose preview bundle is publishing right now. */
export function buildingPrNumbers(states: ReadonlyMap<number, QaOtaBuildState>): number[] {
  const building: number[] = [];
  for (const [prNumber, state] of states) {
    if (state === 'building') building.push(prNumber);
  }
  return building;
}

/** Test-only: forget the cached deployment states. */
export function resetOtaDeploymentCache(): void {
  stateCache = null;
  inFlightStates = null;
}
