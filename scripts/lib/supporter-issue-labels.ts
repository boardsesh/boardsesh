/// <reference types="node" />

/**
 * Quiet triage for GitHub Sponsors: add the `supporter` label to OPEN issues
 * whose author currently sponsors the `boardsesh` org, public and private
 * sponsors alike (docs/supporters.md).
 *
 * Add-only. It never removes a label, so a label a human added or removed by
 * hand on another issue is left alone, and an issue that already carries the
 * label is skipped. A sponsor who lapses keeps the label on old issues.
 *
 * GitHub I/O is injected so the plan and the runner are testable without the
 * network (scripts/__tests__/supporter-issue-labels.test.ts). The runner logs
 * counts only: Actions logs on a public repo are public, and a private
 * sponsor's login must not appear in them.
 */

export const SUPPORTER_LABEL = 'supporter';
/** Matches LABEL_COLORS.supporter in packages/backend/src/lib/github-client.ts. */
export const SUPPORTER_LABEL_COLOR = 'c5def5';

const PAGE_LIMIT = 200;

export type SponsorshipNode = {
  sponsorEntity?: { __typename?: string; login?: string | null } | null;
};

export type OpenIssue = {
  number: number;
  authorLogin: string | null;
  labels: string[];
};

/** Current sponsors who are people (an organization cannot author an issue), lowercased. */
export function sponsorLoginsFrom(nodes: readonly SponsorshipNode[]): Set<string> {
  const logins = new Set<string>();
  for (const node of nodes) {
    const entity = node.sponsorEntity;
    if (entity?.__typename === 'User' && entity.login) logins.add(entity.login.toLowerCase());
  }
  return logins;
}

/** Issue numbers to label: authored by a current sponsor and not labelled yet. */
export function planSupporterLabels(issues: readonly OpenIssue[], sponsorLogins: ReadonlySet<string>): number[] {
  const toLabel = new Set<number>();
  for (const issue of issues) {
    if (!issue.authorLogin || !sponsorLogins.has(issue.authorLogin.toLowerCase())) continue;
    if (issue.labels.some((label) => label.toLowerCase() === SUPPORTER_LABEL)) continue;
    toLabel.add(issue.number);
  }
  return [...toLabel].sort((left, right) => left - right);
}

export type GithubGraphql = (query: string, variables: Record<string, string>) => unknown;

export type SupporterLabelDeps = {
  owner: string;
  repo: string;
  sponsorOrg: string;
  /** GraphQL with a token that can read the org's private sponsorships. */
  sponsorsGraphql: GithubGraphql;
  /** GraphQL with the repo token. */
  issuesGraphql: GithubGraphql;
  /** Create the label; resolve when it exists already. */
  ensureLabel: (name: string, color: string) => void;
  /** POST /issues/{n}/labels, which adds without touching existing labels. */
  addLabel: (issueNumber: number, label: string) => void;
  dryRun: boolean;
  log: (line: string) => void;
};

export type SupporterLabelResult = {
  sponsors: number;
  openIssuesBySponsors: number;
  labelled: number;
  failed: number;
};

type GraphqlErrors = { errors?: { message?: string }[] };
type PageInfo = { hasNextPage?: boolean; endCursor?: string | null };

function throwOnErrors(response: GraphqlErrors): void {
  if (!response.errors?.length) return;
  throw new Error(`GitHub GraphQL query failed: ${response.errors.map((error) => error.message).join('; ')}`);
}

function nextCursor(pageInfo: PageInfo | undefined, what: string): string | null {
  if (!pageInfo) throw new Error(`GitHub did not return pageInfo for ${what}.`);
  if (!pageInfo.hasNextPage) return null;
  if (!pageInfo.endCursor) throw new Error(`GitHub reported another ${what} page without a cursor.`);
  return pageInfo.endCursor;
}

// activeOnly:true — a current sponsor, not everyone who ever gave.
// includePrivate:true — the owner chose to label private sponsors' issues too.
export const CURRENT_SPONSORS_QUERY = `query($login: String!, $cursor: String) {
  organization(login: $login) {
    sponsorshipsAsMaintainer(first: 100, after: $cursor, activeOnly: true, includePrivate: true) {
      pageInfo { hasNextPage endCursor }
      nodes { sponsorEntity { __typename ... on User { login } ... on Organization { login } } }
    }
  }
}`;

export const OPEN_ISSUES_BY_AUTHOR_QUERY = `query($owner: String!, $name: String!, $author: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    issues(first: 100, after: $cursor, states: OPEN, filterBy: { createdBy: $author }) {
      pageInfo { hasNextPage endCursor }
      nodes { number author { login } labels(first: 100) { nodes { name } } }
    }
  }
}`;

export function fetchCurrentSponsorLogins(graphql: GithubGraphql, org: string): Set<string> {
  const nodes: SponsorshipNode[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < PAGE_LIMIT; page += 1) {
    const variables: Record<string, string> = { login: org };
    if (cursor) variables.cursor = cursor;
    const response = graphql(CURRENT_SPONSORS_QUERY, variables) as GraphqlErrors & {
      data?: {
        organization?: { sponsorshipsAsMaintainer?: { pageInfo?: PageInfo; nodes?: SponsorshipNode[] } } | null;
      };
    };
    throwOnErrors(response);
    const connection = response.data?.organization?.sponsorshipsAsMaintainer;
    if (!connection || !Array.isArray(connection.nodes)) {
      throw new Error('GitHub did not return a valid sponsorships connection.');
    }
    nodes.push(...connection.nodes);
    cursor = nextCursor(connection.pageInfo, 'sponsorships');
    if (!cursor) return sponsorLoginsFrom(nodes);
  }
  throw new Error(`Sponsorship pagination exceeded the ${PAGE_LIMIT}-page safety limit.`);
}

type IssueNode = { number?: number; author?: { login?: string } | null; labels?: { nodes?: { name?: string }[] } };

export function fetchOpenIssuesBy(graphql: GithubGraphql, owner: string, repo: string, author: string): OpenIssue[] {
  const issues: OpenIssue[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < PAGE_LIMIT; page += 1) {
    const variables: Record<string, string> = { owner, name: repo, author };
    if (cursor) variables.cursor = cursor;
    const response = graphql(OPEN_ISSUES_BY_AUTHOR_QUERY, variables) as GraphqlErrors & {
      data?: { repository?: { issues?: { pageInfo?: PageInfo; nodes?: IssueNode[] } } | null };
    };
    throwOnErrors(response);
    const connection = response.data?.repository?.issues;
    if (!connection || !Array.isArray(connection.nodes)) {
      throw new Error('GitHub did not return a valid issues connection.');
    }
    for (const node of connection.nodes) {
      if (typeof node.number !== 'number') continue;
      issues.push({
        number: node.number,
        authorLogin: node.author?.login ?? null,
        labels: (node.labels?.nodes ?? []).flatMap((label) => (label.name ? [label.name] : [])),
      });
    }
    cursor = nextCursor(connection.pageInfo, 'issues');
    if (!cursor) return issues;
  }
  throw new Error(`Issue pagination exceeded the ${PAGE_LIMIT}-page safety limit.`);
}

/**
 * Label every open issue by a current sponsor. A sponsor lookup failure
 * throws before any write. A single label write that fails is counted and the
 * rest still run, so one locked issue cannot strand the others.
 */
export function labelSupporterIssues(deps: SupporterLabelDeps): SupporterLabelResult {
  const sponsorLogins = fetchCurrentSponsorLogins(deps.sponsorsGraphql, deps.sponsorOrg);
  const issues = [...sponsorLogins].flatMap((login) =>
    fetchOpenIssuesBy(deps.issuesGraphql, deps.owner, deps.repo, login),
  );
  const toLabel = planSupporterLabels(issues, sponsorLogins);

  let labelled = 0;
  let failed = 0;
  if (toLabel.length > 0 && !deps.dryRun) {
    deps.ensureLabel(SUPPORTER_LABEL, SUPPORTER_LABEL_COLOR);
    for (const issueNumber of toLabel) {
      try {
        deps.addLabel(issueNumber, SUPPORTER_LABEL);
        labelled += 1;
      } catch {
        // No detail: the error can name the issue, and the count is what an operator needs.
        failed += 1;
      }
    }
  }

  const result = { sponsors: sponsorLogins.size, openIssuesBySponsors: issues.length, labelled, failed };
  deps.log(
    `[supporter-labels] ${result.sponsors} current sponsors, ${result.openIssuesBySponsors} open issues by them, ` +
      `${deps.dryRun ? `${toLabel.length} would be labelled (dry run)` : `${labelled} labelled, ${failed} failed`}`,
  );
  return result;
}
