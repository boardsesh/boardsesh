/// <reference types="node" />

/**
 * Pure transforms for the GitHub contributor + sponsor data shown on the mobile
 * Acknowledgements screen. Kept free of I/O so they're unit-testable without
 * hitting the network (see scripts/__tests__/acknowledgements-transform.test.ts).
 */

export type Contributor = {
  login: string;
  name: string | null;
  avatarUrl: string;
  htmlUrl: string;
  pullRequests: number;
  issues: number;
  /** pullRequests + issues — the ranking score for the contributors list. */
  contributions: number;
};

export type Sponsor = {
  login: string;
  name: string | null;
  avatarUrl: string;
  url: string;
};

export type AcknowledgementsData = {
  generatedAt: string;
  contributors: Contributor[];
  sponsors: Sponsor[];
  /** How many sponsors chose to stay private — surfaced as an anonymous count. */
  privateSponsorCount: number;
};

/** A GraphQL pull-request / issue `author` (an Actor: User, Organization, Bot, …). */
export type AuthorRef = {
  login?: string;
  typename?: string;
  name?: string | null;
  avatarUrl?: string;
  url?: string;
};

/** Subset of a GraphQL `sponsorshipsAsMaintainer.nodes[]` entry. */
export type RawSponsorNode = {
  sponsorEntity?: {
    __typename?: string;
    login?: string;
    name?: string | null;
    avatarUrl?: string;
    url?: string;
  } | null;
};

// Automation accounts that author PRs/issues but aren't people to thank.
// The GraphQL `__typename === 'Bot'` covers GitHub Apps; the rest catch bots
// that act as plain users.
const BOT_LOGINS = new Set([
  'dependabot',
  'dependabot-preview',
  'github-actions',
  'renovate',
  'renovate-bot',
  'codecov',
  'codecov-commenter',
  'snyk-bot',
  'imgbot',
  'allcontributors',
]);

// AI coding assistants that author co-authored commits and so surface in the
// contributor graph as plain users. They're the tools, not the crew — so they're
// filtered out of the human thank-you list.
const AI_LOGINS = new Set([
  'claude',
  'codex',
  'devin',
  'devin-ai-integration',
  'copilot',
  'github-copilot',
  'cursor',
  'cursoragent',
  'chatgpt',
  'openai',
  'anthropic',
]);

export function isBotLogin(login: string): boolean {
  const lower = login.toLowerCase();
  if (!lower) return true;
  if (lower.endsWith('[bot]')) return true;
  if (lower.endsWith('-bot')) return true;
  return BOT_LOGINS.has(lower) || AI_LOGINS.has(lower);
}

function isBotAuthor(author: AuthorRef): boolean {
  if ((author.typename ?? '').toLowerCase() === 'bot') return true;
  return isBotLogin(author.login ?? '');
}

/**
 * Builds the contributors list from everyone who authored a pull request or an
 * issue, ranked by their combined count (pullRequests + issues). Bots/AI authors
 * are dropped; display name/avatar are backfilled from whichever record carries them.
 */
export function aggregateContributors(prAuthors: AuthorRef[], issueAuthors: AuthorRef[]): Contributor[] {
  const byLogin = new Map<string, Contributor>();

  const tally = (author: AuthorRef, kind: 'pr' | 'issue') => {
    const login = author.login;
    if (!login || isBotAuthor(author)) return;
    let entry = byLogin.get(login);
    if (!entry) {
      entry = {
        login,
        name: author.name ?? null,
        avatarUrl: author.avatarUrl ?? '',
        htmlUrl: author.url ?? `https://github.com/${login}`,
        pullRequests: 0,
        issues: 0,
        contributions: 0,
      };
      byLogin.set(login, entry);
    } else {
      if (!entry.name && author.name) entry.name = author.name;
      if (!entry.avatarUrl && author.avatarUrl) entry.avatarUrl = author.avatarUrl;
    }
    if (kind === 'pr') entry.pullRequests += 1;
    else entry.issues += 1;
    entry.contributions = entry.pullRequests + entry.issues;
  };

  for (const author of prAuthors) tally(author, 'pr');
  for (const author of issueAuthors) tally(author, 'issue');

  return [...byLogin.values()].sort(
    (first, second) => second.contributions - first.contributions || first.login.localeCompare(second.login),
  );
}

export function transformSponsors(nodes: RawSponsorNode[]): Sponsor[] {
  return nodes
    .map((node) => node.sponsorEntity)
    .filter(
      (entity): entity is NonNullable<RawSponsorNode['sponsorEntity']> & { login: string } =>
        Boolean(entity) && typeof entity?.login === 'string',
    )
    .map((entity) => ({
      login: entity.login,
      name: entity.name ?? null,
      avatarUrl: entity.avatarUrl ?? '',
      url: entity.url ?? `https://github.com/${entity.login}`,
    }));
}
