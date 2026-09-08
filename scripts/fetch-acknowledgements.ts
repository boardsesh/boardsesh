/// <reference types="node" />

/**
 * Generates packages/mobile/src/data/acknowledgements.generated.json — the
 * contributor + sponsor lists shown on the mobile Acknowledgements screen.
 *
 * Contributors come from paginated GraphQL over the repo's pull requests + issues
 * and sponsors come from the GitHub GraphQL API for the `boardsesh` org. Locally
 * this uses your `gh` keyring. In CI it uses the Boardsesh Repo Bot installation
 * token, whose read-only Organization Members permission permits the sponsors
 * query and whose repository permission permits the contributor query.
 *
 * Local runs degrade gracefully: if a fetch fails, the existing committed JSON
 * for that section is kept. CI passes --strict, which fails before writing if
 * any source cannot refresh. `generatedAt` only moves when the data actually
 * changes, keeping the committed file churn-free.
 *
 * Usage: vp run generate:acknowledgements [--strict]
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  aggregateContributors,
  resolveAcknowledgements,
  transformSponsors,
  type AcknowledgementsData,
  type AcknowledgementsRefreshMode,
  type AuthorRef,
  type Contributor,
  type Sponsor,
  type RawSponsorNode,
} from './lib/acknowledgements-transform';

const REPO_OWNER = 'boardsesh';
const REPO_NAME = 'boardsesh';
const SPONSOR_ORG = 'boardsesh';

const here = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = resolve(here, '../packages/mobile/src/data/acknowledgements.generated.json');
const refreshMode: AcknowledgementsRefreshMode = process.argv.includes('--strict') ? 'strict' : 'best-effort';

function gh(args: string[]): string {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function readExisting(): AcknowledgementsData {
  try {
    return JSON.parse(readFileSync(OUTPUT_PATH, 'utf8')) as AcknowledgementsData;
  } catch {
    return { generatedAt: '', contributors: [], sponsors: [], privateSponsorCount: 0 };
  }
}

// Contributors are everyone who authored a PR or an issue, ranked by the sum of
// the two. The GraphQL connections are paginated fully (the REST /contributors
// endpoint only counts commits and can't see issue creators).
const authorSelection = `author { __typename login avatarUrl ... on User { name url } ... on Organization { name url } }`;
const PR_AUTHORS_QUERY = `query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: 100, after: $cursor, orderBy: { field: CREATED_AT, direction: ASC }) {
      pageInfo { hasNextPage endCursor }
      nodes { ${authorSelection} }
    }
  }
}`;
const ISSUE_AUTHORS_QUERY = `query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    issues(first: 100, after: $cursor, orderBy: { field: CREATED_AT, direction: ASC }) {
      pageInfo { hasNextPage endCursor }
      nodes { ${authorSelection} }
    }
  }
}`;

type AuthorNode = { __typename?: string; login?: string; avatarUrl?: string; name?: string | null; url?: string };
type AuthorConnection = {
  pageInfo?: { hasNextPage?: boolean; endCursor?: string };
  nodes?: { author?: AuthorNode | null }[];
};

type GraphQlResponse = { errors?: { message?: string }[] };

function throwOnGraphQlErrors(response: GraphQlResponse): void {
  if (!response.errors?.length) return;
  const messages = response.errors.map((error) => error.message ?? 'unknown GraphQL error').join('; ');
  throw new Error(`GitHub GraphQL query failed: ${messages}`);
}

function fetchAuthors(query: string, connectionKey: 'pullRequests' | 'issues'): AuthorRef[] {
  const authors: AuthorRef[] = [];
  let cursor: string | null = null;
  // Hard page cap so a pagination bug can never loop forever.
  for (let page = 0; page < 200; page += 1) {
    const args = ['api', 'graphql', '-f', `query=${query}`, '-f', `owner=${REPO_OWNER}`, '-f', `name=${REPO_NAME}`];
    if (cursor) args.push('-f', `cursor=${cursor}`);
    const response = JSON.parse(gh(args)) as GraphQlResponse & {
      data?: { repository?: Record<string, AuthorConnection> };
    };
    throwOnGraphQlErrors(response);
    const connection = response.data?.repository?.[connectionKey];
    if (!connection?.pageInfo || !Array.isArray(connection.nodes)) {
      throw new Error(`GitHub did not return a valid ${connectionKey} connection.`);
    }
    for (const node of connection.nodes) {
      const author = node.author;
      if (author?.login) {
        authors.push({
          login: author.login,
          typename: author.__typename,
          name: author.name ?? null,
          avatarUrl: author.avatarUrl,
          url: author.url,
        });
      }
    }
    if (!connection.pageInfo.hasNextPage) return authors;
    if (!connection.pageInfo.endCursor) {
      throw new Error(`GitHub reported another ${connectionKey} page without a cursor.`);
    }
    cursor = connection.pageInfo.endCursor;
  }
  throw new Error(`GitHub ${connectionKey} pagination exceeded the 200-page safety limit.`);
}

function fetchContributors(): Contributor[] | null {
  try {
    const prAuthors = fetchAuthors(PR_AUTHORS_QUERY, 'pullRequests');
    const issueAuthors = fetchAuthors(ISSUE_AUTHORS_QUERY, 'issues');
    return aggregateContributors(prAuthors, issueAuthors);
  } catch (error) {
    console.warn(`[acknowledgements] contributors fetch failed, keeping existing list: ${String(error)}`);
    return null;
  }
}

// activeOnly:false so one-time sponsors (and past supporters) are thanked too —
// a one-time gift isn't an "active" recurring subscription, so activeOnly:true
// would silently drop them. includePrivate:false still respects sponsors who
// chose to stay private (they're surfaced only as an anonymous count below).
const PUBLIC_SPONSORS_QUERY = `query($login: String!, $cursor: String) {
  organization(login: $login) {
    sponsorshipsAsMaintainer(first: 100, after: $cursor, activeOnly: false, includePrivate: false, orderBy: { field: CREATED_AT, direction: ASC }) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes {
        sponsorEntity {
          __typename
          ... on User { login name avatarUrl url }
          ... on Organization { login name avatarUrl url }
        }
      }
    }
  }
}`;

// includePrivate:true returns the FULL count (public + private) to the Repo Bot,
// whose Organization Members permission grants it sponsor visibility. private = all − public.
const ALL_SPONSOR_COUNT_QUERY = `query($login: String!) {
  organization(login: $login) {
    sponsorshipsAsMaintainer(first: 1, activeOnly: false, includePrivate: true) {
      totalCount
    }
  }
}`;

function fetchSponsorData(): { sponsors: Sponsor[] | null; privateCount: number | null } {
  type PublicConnection = {
    totalCount?: number;
    pageInfo?: { hasNextPage?: boolean; endCursor?: string };
    nodes?: RawSponsorNode[];
  };
  const rawNodes: RawSponsorNode[] = [];
  let publicCount = 0;
  let cursor: string | null = null;
  try {
    // Paginate fully — an org can have more than the 100-per-page maximum.
    for (let page = 0; page < 200; page += 1) {
      const args = ['api', 'graphql', '-f', `query=${PUBLIC_SPONSORS_QUERY}`, '-f', `login=${SPONSOR_ORG}`];
      if (cursor) args.push('-f', `cursor=${cursor}`);
      const response = JSON.parse(gh(args)) as GraphQlResponse & {
        data?: { organization?: { sponsorshipsAsMaintainer?: PublicConnection } };
      };
      throwOnGraphQlErrors(response);
      const connection = response.data?.organization?.sponsorshipsAsMaintainer;
      if (!connection?.pageInfo || !Array.isArray(connection.nodes)) {
        throw new Error('GitHub did not return a valid public sponsors connection.');
      }
      publicCount = connection.totalCount ?? publicCount;
      for (const node of connection.nodes) rawNodes.push(node);
      if (!connection.pageInfo.hasNextPage) break;
      if (!connection.pageInfo.endCursor) {
        throw new Error('GitHub reported another public sponsors page without a cursor.');
      }
      cursor = connection.pageInfo.endCursor;
      if (page === 199) {
        throw new Error('GitHub public sponsor pagination exceeded the 200-page safety limit.');
      }
    }
  } catch (error) {
    console.warn(`[acknowledgements] sponsors fetch failed, keeping existing list: ${String(error)}`);
    return { sponsors: null, privateCount: null };
  }

  const sponsors = transformSponsors(rawNodes);
  publicCount = publicCount || sponsors.length;

  // Local runs retain the existing anonymous count when it is unavailable.
  // Scheduled strict runs reject that partial refresh in resolveAcknowledgements.
  let privateCount: number | null = null;
  try {
    const response = JSON.parse(
      gh(['api', 'graphql', '-f', `query=${ALL_SPONSOR_COUNT_QUERY}`, '-f', `login=${SPONSOR_ORG}`]),
    ) as GraphQlResponse & { data?: { organization?: { sponsorshipsAsMaintainer?: { totalCount?: number } } } };
    throwOnGraphQlErrors(response);
    const allCount = response.data?.organization?.sponsorshipsAsMaintainer?.totalCount;
    if (typeof allCount !== 'number') {
      throw new Error('GitHub did not return a total sponsorship count.');
    }
    privateCount = Math.max(0, allCount - publicCount);
  } catch (error) {
    console.warn(`[acknowledgements] private sponsor count unavailable, keeping the existing count: ${String(error)}`);
  }

  return { sponsors, privateCount };
}

function main(): void {
  const existing = readExisting();
  const refreshedContributors = fetchContributors();
  const refreshedSponsors = fetchSponsorData();
  const acknowledgements = resolveAcknowledgements(
    existing,
    {
      contributors: refreshedContributors,
      sponsors: refreshedSponsors.sponsors,
      privateSponsorCount: refreshedSponsors.privateCount,
    },
    refreshMode,
  );
  const { contributors, sponsors, privateSponsorCount } = acknowledgements;

  // Keep generatedAt stable when nothing changed so the committed file (and the
  // refresh workflow's "commit only if changed") stays quiet on no-op runs.
  const dataChanged =
    JSON.stringify({ contributors, sponsors, privateSponsorCount }) !==
    JSON.stringify({
      contributors: existing.contributors,
      sponsors: existing.sponsors,
      privateSponsorCount: existing.privateSponsorCount ?? 0,
    });
  const generatedAt = dataChanged || !existing.generatedAt ? new Date().toISOString() : existing.generatedAt;

  const generatedAcknowledgements: AcknowledgementsData = { generatedAt, contributors, sponsors, privateSponsorCount };
  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(generatedAcknowledgements, null, 2)}\n`);
  console.log(
    `[acknowledgements] wrote ${contributors.length} contributors, ${sponsors.length} public sponsors, ${privateSponsorCount} private`,
  );
}

main();
