/// <reference types="node" />

import { createSign } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const APP_STORE_CONNECT_API_BASE = 'https://api.appstoreconnect.apple.com';
const GITHUB_API_BASE = 'https://api.github.com';
const DEFAULT_BUNDLE_ID = 'com.boardsesh.app';
const DEFAULT_LOOKBACK_HOURS = 72;
const DEFAULT_PAGE_LIMIT = 100;
const DEFAULT_MAX_PAGES = 5;
const ISSUE_BODY_LIMIT = 60_000;
const ISSUE_COMMENT_LIMIT = 55_000;

type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;
type Logger = Pick<Console, 'error' | 'log' | 'warn'>;

type AppStoreJwtInput = {
  keyId: string;
  issuerId: string;
  privateKey: string;
  nowSeconds?: number;
  expiresInSeconds?: number;
};

type JsonApiResourceIdentifier<TType extends string = string> = {
  type: TType;
  id: string;
};

type JsonApiToOneRelationship<TType extends string = string> = {
  data?: JsonApiResourceIdentifier<TType> | null;
};

type JsonApiCollectionResponse<TResource> = {
  data: TResource[];
  included?: JsonApiIncludedResource[];
  links?: {
    next?: string;
  };
};

type JsonApiSingleResponse<TResource> = {
  data: TResource;
};

type AppResource = {
  type: 'apps';
  id: string;
  attributes?: {
    bundleId?: string;
    name?: string;
  };
};

type BuildResource = {
  type: 'builds';
  id: string;
  attributes?: {
    version?: string;
    uploadedDate?: string;
  };
};

type JsonApiIncludedResource = BuildResource | { type: string; id: string; attributes?: Record<string, unknown> };

type BetaFeedbackAttributes = {
  createdDate?: string;
  comment?: string;
  deviceModel?: string;
  osVersion?: string;
  locale?: string;
  timeZone?: string;
  architecture?: string;
  connectionType?: string;
  pairedAppleWatch?: string;
  appUptimeInMilliseconds?: number;
  diskBytesAvailable?: number;
  diskBytesTotal?: number;
  batteryPercentage?: number;
  screenWidthInPoints?: number;
  screenHeightInPoints?: number;
  appPlatform?: string;
  devicePlatform?: string;
  deviceFamily?: string;
  buildBundleId?: string;
};

type BetaFeedbackScreenshotImage = {
  url?: string;
  width?: number;
  height?: number;
  expirationDate?: string;
};

type BetaFeedbackScreenshotSubmissionResource = {
  type: 'betaFeedbackScreenshotSubmissions';
  id: string;
  attributes?: BetaFeedbackAttributes & {
    screenshots?: BetaFeedbackScreenshotImage[];
  };
  relationships?: {
    build?: JsonApiToOneRelationship<'builds'>;
  };
};

type BetaFeedbackCrashSubmissionResource = {
  type: 'betaFeedbackCrashSubmissions';
  id: string;
  attributes?: BetaFeedbackAttributes;
  relationships?: {
    build?: JsonApiToOneRelationship<'builds'>;
  };
};

type BetaCrashLogResource = {
  type: 'betaCrashLogs';
  id: string;
  attributes?: {
    logText?: string;
  };
};

type BuildInfo = {
  id: string | null;
  version: string | null;
  uploadedDate: string | null;
};

type TestFlightFeedbackBase = {
  id: string;
  createdDate: string | null;
  comment: string | null;
  deviceModel: string | null;
  osVersion: string | null;
  locale: string | null;
  timeZone: string | null;
  architecture: string | null;
  connectionType: string | null;
  pairedAppleWatch: string | null;
  appUptimeInMilliseconds: number | null;
  diskBytesAvailable: number | null;
  diskBytesTotal: number | null;
  batteryPercentage: number | null;
  screenWidthInPoints: number | null;
  screenHeightInPoints: number | null;
  appPlatform: string | null;
  devicePlatform: string | null;
  deviceFamily: string | null;
  buildBundleId: string | null;
  build: BuildInfo;
};

export type TestFlightScreenshotFeedback = TestFlightFeedbackBase & {
  kind: 'screenshot';
  screenshots: BetaFeedbackScreenshotImage[];
};

export type TestFlightCrashFeedback = TestFlightFeedbackBase & {
  kind: 'crash';
  crashLog: string | null;
};

type TestFlightFeedback = TestFlightScreenshotFeedback | TestFlightCrashFeedback;

export type FeedbackSource = {
  resolveAppId(bundleId: string): Promise<string>;
  listScreenshotFeedback(appId: string, options: FeedbackListOptions): Promise<TestFlightScreenshotFeedback[]>;
  listCrashFeedback(appId: string, options: FeedbackListOptions): Promise<TestFlightCrashFeedback[]>;
};

export type IssueSink = {
  issueExists(marker: string): Promise<boolean>;
  ensureLabels(labels: string[]): Promise<void>;
  createIssue(issue: IssueDraft): Promise<number>;
  addIssueComment(issueNumber: number, body: string): Promise<void>;
};

type FeedbackListOptions = {
  since: Date;
  pageLimit: number;
  maxPages: number;
};

export type IssueDraft = {
  marker: string;
  title: string;
  body: string;
  labels: string[];
  comments: string[];
};

export type SyncOptions = {
  appId?: string | null;
  bundleId: string;
  dryRun: boolean;
  since: Date;
  pageLimit: number;
  maxPages: number;
};

export type SyncResult = {
  created: number;
  dryRun: number;
  skippedExisting: number;
};

type RunDependencies = {
  feedbackSource: FeedbackSource;
  issueSink: IssueSink;
  logger: Logger;
};

type CliOptions = {
  appId: string | null;
  bundleId: string;
  dryRun: boolean;
  githubRepository: string;
  lookbackHours: number;
  maxPages: number;
  pageLimit: number;
  since: Date | null;
};

type LabelDefinition = {
  color: string;
  description: string;
};

const LABELS: Record<string, LabelDefinition> = {
  testflight: { color: '0e8a16', description: 'Feedback submitted through TestFlight' },
  ios: { color: '1d76db', description: 'iOS app issue' },
  feedback: { color: 'fbca04', description: 'User feedback' },
  screenshot: { color: 'c5def5', description: 'Includes TestFlight screenshot feedback' },
  crash: { color: 'd73a4a', description: 'Includes TestFlight crash feedback' },
};

function base64UrlEncode(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

export function createAppStoreConnectJwt(input: AppStoreJwtInput): string {
  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const expiresInSeconds = input.expiresInSeconds ?? 20 * 60;
  const header = {
    alg: 'ES256',
    kid: input.keyId,
    typ: 'JWT',
  };
  const payload = {
    aud: 'appstoreconnect-v1',
    exp: nowSeconds + expiresInSeconds,
    iat: nowSeconds,
    iss: input.issuerId,
  };
  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(payload))}`;
  const signer = createSign('sha256');
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign({ key: input.privateKey, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${signature.toString('base64url')}`;
}

function decodePrivateKey(secret: string): string {
  const trimmedSecret = secret.trim();
  if (trimmedSecret.includes('BEGIN PRIVATE KEY')) {
    return trimmedSecret;
  }
  return Buffer.from(trimmedSecret, 'base64').toString('utf8');
}

function getRequiredEnv(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const value = env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

async function readJsonResponse<T>(response: Response, context: string): Promise<T> {
  const bodyText = await response.text();
  if (!response.ok) {
    const compactBody = bodyText.length > 800 ? `${bodyText.slice(0, 800)}...` : bodyText;
    throw new Error(`${context} failed: ${response.status} ${response.statusText} ${compactBody}`.trim());
  }
  return JSON.parse(bodyText) as T;
}

class AppStoreConnectClient implements FeedbackSource {
  private readonly fetcher: Fetcher;
  private readonly token: string;
  private readonly apiBase: string;

  constructor(args: { fetcher?: Fetcher; token: string; apiBase?: string }) {
    this.fetcher = args.fetcher ?? fetch;
    this.token = args.token;
    this.apiBase = args.apiBase ?? APP_STORE_CONNECT_API_BASE;
  }

  async resolveAppId(bundleId: string): Promise<string> {
    const url = this.apiUrl('/v1/apps');
    url.searchParams.set('filter[bundleId]', bundleId);
    url.searchParams.set('fields[apps]', 'bundleId,name');
    url.searchParams.set('limit', '1');

    const response = await this.fetchJson<JsonApiCollectionResponse<AppResource>>(url);
    const app = response.data[0];
    if (!app) {
      throw new Error(`No App Store Connect app found for bundle id ${bundleId}`);
    }
    return app.id;
  }

  async listScreenshotFeedback(appId: string, options: FeedbackListOptions): Promise<TestFlightScreenshotFeedback[]> {
    const responseItems = await this.listFeedbackResources<BetaFeedbackScreenshotSubmissionResource>({
      path: `/v1/apps/${appId}/betaFeedbackScreenshotSubmissions`,
      fields:
        'createdDate,comment,deviceModel,osVersion,locale,timeZone,architecture,connectionType,pairedAppleWatch,appUptimeInMilliseconds,diskBytesAvailable,diskBytesTotal,batteryPercentage,screenWidthInPoints,screenHeightInPoints,appPlatform,devicePlatform,deviceFamily,buildBundleId,screenshots,build',
      options,
    });

    return responseItems.map(({ resource, builds }) => mapScreenshotFeedback(resource, builds));
  }

  async listCrashFeedback(appId: string, options: FeedbackListOptions): Promise<TestFlightCrashFeedback[]> {
    const responseItems = await this.listFeedbackResources<BetaFeedbackCrashSubmissionResource>({
      path: `/v1/apps/${appId}/betaFeedbackCrashSubmissions`,
      fields:
        'createdDate,comment,deviceModel,osVersion,locale,timeZone,architecture,connectionType,pairedAppleWatch,appUptimeInMilliseconds,diskBytesAvailable,diskBytesTotal,batteryPercentage,screenWidthInPoints,screenHeightInPoints,appPlatform,devicePlatform,deviceFamily,buildBundleId,crashLog,build',
      options,
    });

    const feedbackItems: TestFlightCrashFeedback[] = [];
    for (const item of responseItems) {
      const crashLog = await this.readCrashLog(item.resource.id);
      feedbackItems.push(mapCrashFeedback(item.resource, item.builds, crashLog));
    }
    return feedbackItems;
  }

  private async readCrashLog(submissionId: string): Promise<string | null> {
    const url = this.apiUrl(`/v1/betaFeedbackCrashSubmissions/${submissionId}/crashLog`);
    url.searchParams.set('fields[betaCrashLogs]', 'logText');
    const response = await this.fetchJson<JsonApiSingleResponse<BetaCrashLogResource>>(url);
    return response.data.attributes?.logText ?? null;
  }

  private async listFeedbackResources<TResource extends { id: string; attributes?: { createdDate?: string } }>(args: {
    path: string;
    fields: string;
    options: FeedbackListOptions;
  }): Promise<Array<{ resource: TResource; builds: Map<string, BuildInfo> }>> {
    let url: URL | null = this.apiUrl(args.path);
    url.searchParams.set('sort', '-createdDate');
    url.searchParams.set('limit', String(args.options.pageLimit));
    url.searchParams.set('include', 'build');
    url.searchParams.set('fields[builds]', 'version,uploadedDate');
    if (args.path.includes('Screenshot')) {
      url.searchParams.set('fields[betaFeedbackScreenshotSubmissions]', args.fields);
    } else {
      url.searchParams.set('fields[betaFeedbackCrashSubmissions]', args.fields);
    }

    const items: Array<{ resource: TResource; builds: Map<string, BuildInfo> }> = [];
    let pageCount = 0;
    while (url && pageCount < args.options.maxPages) {
      pageCount += 1;
      const page = await this.fetchJson<JsonApiCollectionResponse<TResource>>(url);
      const builds = mapIncludedBuilds(page.included ?? []);
      let reachedOlderSubmission = false;

      for (const resource of page.data) {
        if (isOlderThan(resource.attributes?.createdDate ?? null, args.options.since)) {
          reachedOlderSubmission = true;
          continue;
        }
        items.push({ resource, builds });
      }

      if (reachedOlderSubmission || !page.links?.next) {
        break;
      }
      url = new URL(page.links.next, this.apiBase);
    }

    return items;
  }

  private apiUrl(path: string): URL {
    return new URL(path, this.apiBase);
  }

  private async fetchJson<T>(url: URL): Promise<T> {
    const response = await this.fetcher(url, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${this.token}`,
      },
    });
    return readJsonResponse<T>(response, url.pathname);
  }
}

class GitHubIssueClient implements IssueSink {
  private readonly fetcher: Fetcher;
  private readonly owner: string;
  private readonly repository: string;
  private readonly token: string;
  private readonly apiBase: string;

  constructor(args: { fetcher?: Fetcher; repositoryFullName: string; token: string; apiBase?: string }) {
    const [owner, repository] = args.repositoryFullName.split('/');
    if (!owner || !repository) {
      throw new Error(`Invalid GitHub repository "${args.repositoryFullName}". Expected owner/name.`);
    }
    this.fetcher = args.fetcher ?? fetch;
    this.owner = owner;
    this.repository = repository;
    this.token = args.token;
    this.apiBase = args.apiBase ?? GITHUB_API_BASE;
  }

  async issueExists(marker: string): Promise<boolean> {
    const searchQuery = `repo:${this.owner}/${this.repository} is:issue "${marker}"`;
    const url = this.githubUrl('/search/issues');
    url.searchParams.set('q', searchQuery);
    url.searchParams.set('per_page', '1');
    const response = await this.fetchJson<{ total_count?: number }>(url, { method: 'GET' });
    return (response.total_count ?? 0) > 0;
  }

  async ensureLabels(labels: string[]): Promise<void> {
    for (const label of labels) {
      await this.ensureLabel(label);
    }
  }

  async createIssue(issue: IssueDraft): Promise<number> {
    const url = this.githubUrl(`/repos/${this.owner}/${this.repository}/issues`);
    const response = await this.fetchJson<{ number: number }>(url, {
      method: 'POST',
      body: JSON.stringify({
        body: issue.body,
        labels: issue.labels,
        title: issue.title,
      }),
    });
    return response.number;
  }

  async addIssueComment(issueNumber: number, body: string): Promise<void> {
    const url = this.githubUrl(`/repos/${this.owner}/${this.repository}/issues/${issueNumber}/comments`);
    await this.fetchJson<unknown>(url, {
      method: 'POST',
      body: JSON.stringify({ body }),
    });
  }

  private async ensureLabel(label: string): Promise<void> {
    const definition = LABELS[label] ?? { color: 'ededed', description: 'Created by TestFlight feedback sync' };
    const encodedLabel = encodeURIComponent(label);
    const labelUrl = this.githubUrl(`/repos/${this.owner}/${this.repository}/labels/${encodedLabel}`);
    const response = await this.fetcher(labelUrl, this.requestInit({ method: 'GET' }));
    if (response.ok) return;
    if (response.status !== 404) {
      await readJsonResponse<unknown>(response, `GET label ${label}`);
      return;
    }

    const createUrl = this.githubUrl(`/repos/${this.owner}/${this.repository}/labels`);
    await this.fetchJson<unknown>(createUrl, {
      method: 'POST',
      body: JSON.stringify({
        color: definition.color,
        description: definition.description,
        name: label,
      }),
    });
  }

  private githubUrl(path: string): URL {
    return new URL(path, this.apiBase);
  }

  private requestInit(init: RequestInit): RequestInit {
    const headers = new Headers(init.headers);
    headers.set('Accept', 'application/vnd.github+json');
    headers.set('Authorization', `Bearer ${this.token}`);
    headers.set('Content-Type', 'application/json');
    headers.set('X-GitHub-Api-Version', '2022-11-28');

    return {
      ...init,
      headers,
    };
  }

  private async fetchJson<T>(url: URL, init: RequestInit): Promise<T> {
    const response = await this.fetcher(url, this.requestInit(init));
    return readJsonResponse<T>(response, `${init.method ?? 'GET'} ${url.pathname}`);
  }
}

function isOlderThan(value: string | null, since: Date): boolean {
  if (!value) return false;
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return false;
  return timestamp < since.getTime();
}

function nullableString(value: string | undefined): string | null {
  return value && value.trim().length > 0 ? value : null;
}

function nullableNumber(value: number | undefined): number | null {
  return typeof value === 'number' ? value : null;
}

function mapIncludedBuilds(included: JsonApiIncludedResource[]): Map<string, BuildInfo> {
  const builds = new Map<string, BuildInfo>();
  for (const resource of included) {
    if (!isBuildResource(resource)) continue;
    builds.set(resource.id, {
      id: resource.id,
      uploadedDate: nullableString(resource.attributes?.uploadedDate),
      version: nullableString(resource.attributes?.version),
    });
  }
  return builds;
}

function isBuildResource(resource: JsonApiIncludedResource): resource is BuildResource {
  return resource.type === 'builds';
}

function mapFeedbackBase(
  resource: BetaFeedbackScreenshotSubmissionResource | BetaFeedbackCrashSubmissionResource,
  builds: Map<string, BuildInfo>,
): TestFlightFeedbackBase {
  const attributes = resource.attributes ?? {};
  const buildId = resource.relationships?.build?.data?.id ?? null;
  return {
    appPlatform: nullableString(attributes.appPlatform),
    appUptimeInMilliseconds: nullableNumber(attributes.appUptimeInMilliseconds),
    architecture: nullableString(attributes.architecture),
    batteryPercentage: nullableNumber(attributes.batteryPercentage),
    build: buildId ? (builds.get(buildId) ?? { id: buildId, uploadedDate: null, version: null }) : emptyBuild(),
    buildBundleId: nullableString(attributes.buildBundleId),
    comment: nullableString(attributes.comment),
    connectionType: nullableString(attributes.connectionType),
    createdDate: nullableString(attributes.createdDate),
    deviceFamily: nullableString(attributes.deviceFamily),
    deviceModel: nullableString(attributes.deviceModel),
    devicePlatform: nullableString(attributes.devicePlatform),
    diskBytesAvailable: nullableNumber(attributes.diskBytesAvailable),
    diskBytesTotal: nullableNumber(attributes.diskBytesTotal),
    id: resource.id,
    locale: nullableString(attributes.locale),
    osVersion: nullableString(attributes.osVersion),
    pairedAppleWatch: nullableString(attributes.pairedAppleWatch),
    screenHeightInPoints: nullableNumber(attributes.screenHeightInPoints),
    screenWidthInPoints: nullableNumber(attributes.screenWidthInPoints),
    timeZone: nullableString(attributes.timeZone),
  };
}

function emptyBuild(): BuildInfo {
  return { id: null, uploadedDate: null, version: null };
}

function mapScreenshotFeedback(
  resource: BetaFeedbackScreenshotSubmissionResource,
  builds: Map<string, BuildInfo>,
): TestFlightScreenshotFeedback {
  return {
    ...mapFeedbackBase(resource, builds),
    kind: 'screenshot',
    screenshots: resource.attributes?.screenshots ?? [],
  };
}

function mapCrashFeedback(
  resource: BetaFeedbackCrashSubmissionResource,
  builds: Map<string, BuildInfo>,
  crashLog: string | null,
): TestFlightCrashFeedback {
  return {
    ...mapFeedbackBase(resource, builds),
    crashLog,
    kind: 'crash',
  };
}

export function testFlightMarker(kind: TestFlightFeedback['kind'], id: string): string {
  return `<!-- testflight-feedback:${kind}:${id} -->`;
}

export function redactSensitiveText(text: string): string {
  let redactedText = text.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted email]');
  redactedText = redactedText.replace(/\/Users\/[^/\s]+/g, '/Users/[redacted]');
  redactedText = redactedText.replace(
    /\b((?:first|last|full)\s+name|name|tester|email)\s*[:=]\s*([^\n\r,;]+)/gi,
    (_match: string, label: string) => `${label}: [redacted]`,
  );
  redactedText = redactedText.replace(
    /\b(my name is|i am|i'm)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\b/gi,
    (_match: string, prefix: string) => `${prefix} [redacted name]`,
  );
  return redactedText;
}

export function buildIssueDraft(feedback: TestFlightFeedback): IssueDraft {
  if (feedback.kind === 'screenshot') {
    return buildScreenshotIssueDraft(feedback);
  }
  return buildCrashIssueDraft(feedback);
}

function buildScreenshotIssueDraft(feedback: TestFlightScreenshotFeedback): IssueDraft {
  const marker = testFlightMarker(feedback.kind, feedback.id);
  const title = buildIssueTitle('Screenshot feedback', feedback);
  const bodyParts = [
    marker,
    'Screenshot feedback submitted by a beta tester.',
    '',
    formatComment(feedback.comment),
    '',
    formatMetadataTable(feedback),
    '',
    formatScreenshots(feedback.screenshots),
  ];

  return {
    body: bodyParts.join('\n'),
    comments: [],
    labels: ['testflight', 'ios', 'feedback', 'screenshot'],
    marker,
    title,
  };
}

function buildCrashIssueDraft(feedback: TestFlightCrashFeedback): IssueDraft {
  const marker = testFlightMarker(feedback.kind, feedback.id);
  const title = buildIssueTitle('Crash feedback', feedback);
  const redactedLog = feedback.crashLog ? redactSensitiveText(feedback.crashLog) : null;
  const bodyWithoutLog = [
    marker,
    'Crash feedback submitted by a beta tester.',
    '',
    formatComment(feedback.comment),
    '',
    formatMetadataTable(feedback),
  ].join('\n');

  if (!redactedLog) {
    return {
      body: `${bodyWithoutLog}\n\n_No crash log returned by App Store Connect._`,
      comments: [],
      labels: ['testflight', 'ios', 'feedback', 'crash'],
      marker,
      title,
    };
  }

  const crashLogSection = `\n\n## Crash Log\n\n${formatCodeBlock(redactedLog)}`;
  if (bodyWithoutLog.length + crashLogSection.length <= ISSUE_BODY_LIMIT) {
    return {
      body: `${bodyWithoutLog}${crashLogSection}`,
      comments: [],
      labels: ['testflight', 'ios', 'feedback', 'crash'],
      marker,
      title,
    };
  }

  const logChunks = chunkText(redactedLog, ISSUE_COMMENT_LIMIT);
  return {
    body: `${bodyWithoutLog}\n\nCrash log is split across ${logChunks.length} follow-up comments.`,
    comments: logChunks.map(
      (logChunk, index) => `Crash log ${index + 1}/${logChunks.length}\n\n${formatCodeBlock(logChunk)}`,
    ),
    labels: ['testflight', 'ios', 'feedback', 'crash'],
    marker,
    title,
  };
}

function buildIssueTitle(prefix: string, feedback: TestFlightFeedback): string {
  const redactedComment = feedback.comment ? redactSensitiveText(feedback.comment) : '';
  const commentSnippet = redactedComment.replace(/\s+/g, ' ').trim();
  let suffix = commentSnippet;
  if (!suffix) {
    const device = feedback.deviceModel ?? 'unknown device';
    const osVersion = feedback.osVersion ? ` on ${feedback.osVersion}` : '';
    suffix = `${device}${osVersion}`;
  }
  return truncateTitle(`${prefix}: ${suffix}`);
}

function truncateTitle(title: string): string {
  if (title.length <= 120) return title;
  return `${title.slice(0, 117).trimEnd()}...`;
}

function formatComment(comment: string | null): string {
  if (!comment) return '## Tester Comment\n\n_No comment provided._';
  return `## Tester Comment\n\n${redactSensitiveText(comment)}`;
}

function formatMetadataTable(feedback: TestFlightFeedback): string {
  const rows: Array<[string, string | null]> = [
    ['Submission ID', feedback.id],
    ['Created', feedback.createdDate],
    ['Build ID', feedback.build.id],
    ['Build version', feedback.build.version],
    ['Build uploaded', feedback.build.uploadedDate],
    ['Bundle ID', feedback.buildBundleId],
    ['Device model', feedback.deviceModel],
    ['OS version', feedback.osVersion],
    ['App platform', feedback.appPlatform],
    ['Device platform', feedback.devicePlatform],
    ['Device family', feedback.deviceFamily],
    ['Locale', feedback.locale],
    ['Time zone', feedback.timeZone],
    ['Architecture', feedback.architecture],
    ['Connection type', feedback.connectionType],
    ['Paired Apple Watch', feedback.pairedAppleWatch],
    ['App uptime', formatMilliseconds(feedback.appUptimeInMilliseconds)],
    ['Battery', formatPercent(feedback.batteryPercentage)],
    ['Screen', formatScreenSize(feedback.screenWidthInPoints, feedback.screenHeightInPoints)],
    ['Disk available', formatBytes(feedback.diskBytesAvailable)],
    ['Disk total', formatBytes(feedback.diskBytesTotal)],
  ];

  return [
    '## TestFlight Metadata',
    '',
    '| Field | Value |',
    '| --- | --- |',
    ...rows.map(([field, value]) => `| ${field} | ${escapeMarkdownTableCell(value ?? 'unknown')} |`),
  ].join('\n');
}

function formatScreenshots(screenshots: BetaFeedbackScreenshotImage[]): string {
  if (screenshots.length === 0) {
    return '## Screenshots\n\n_No screenshot URLs returned by App Store Connect._';
  }

  const sections = ['## Screenshots'];
  screenshots.forEach((screenshot, index) => {
    const screenshotNumber = index + 1;
    sections.push('');
    sections.push(`### Screenshot ${screenshotNumber}`);
    if (screenshot.url) {
      sections.push(
        `<img alt="TestFlight screenshot ${screenshotNumber}" src="${escapeHtmlAttribute(screenshot.url)}" width="360" />`,
      );
      sections.push('');
      sections.push(`[Open screenshot ${screenshotNumber}](${screenshot.url})`);
    } else {
      sections.push('_No screenshot URL returned._');
    }
    sections.push(`- Size: ${formatImageSize(screenshot.width, screenshot.height)}`);
    sections.push(`- URL expires: ${screenshot.expirationDate ?? 'unknown'}`);
  });
  return sections.join('\n');
}

function formatMilliseconds(value: number | null): string | null {
  if (value === null) return null;
  const seconds = Math.round(value / 1000);
  return `${seconds}s`;
}

function formatPercent(value: number | null): string | null {
  return value === null ? null : `${value}%`;
}

function formatScreenSize(width: number | null, height: number | null): string | null {
  if (width === null || height === null) return null;
  return `${width} x ${height} pt`;
}

function formatImageSize(width: number | undefined, height: number | undefined): string {
  if (typeof width !== 'number' || typeof height !== 'number') return 'unknown';
  return `${width} x ${height}`;
}

function formatBytes(value: number | null): string | null {
  if (value === null) return null;
  const gibibytes = value / 1024 / 1024 / 1024;
  return `${gibibytes.toFixed(2)} GiB`;
}

function escapeMarkdownTableCell(value: string): string {
  return value.replaceAll('|', '\\|').replace(/\r?\n/g, '<br>');
}

function escapeHtmlAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function formatCodeBlock(value: string): string {
  return `\`\`\`text\n${value.replaceAll('```', '`` `')}\n\`\`\``;
}

export function chunkText(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];
  const chunks: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    chunks.push(text.slice(offset, offset + maxLength));
    offset += maxLength;
  }
  return chunks;
}

export async function syncTestFlightFeedback(options: SyncOptions, dependencies: RunDependencies): Promise<SyncResult> {
  const appId = options.appId ?? (await dependencies.feedbackSource.resolveAppId(options.bundleId));
  dependencies.logger.log(
    `[testflight-feedback] Syncing feedback for app ${appId} since ${options.since.toISOString()}`,
  );

  const listOptions: FeedbackListOptions = {
    maxPages: options.maxPages,
    pageLimit: options.pageLimit,
    since: options.since,
  };
  const [screenshotFeedback, crashFeedback] = await Promise.all([
    dependencies.feedbackSource.listScreenshotFeedback(appId, listOptions),
    dependencies.feedbackSource.listCrashFeedback(appId, listOptions),
  ]);

  const feedbackItems = [...screenshotFeedback, ...crashFeedback].sort(compareFeedbackNewestFirst);
  const result: SyncResult = { created: 0, dryRun: 0, skippedExisting: 0 };

  for (const feedback of feedbackItems) {
    const draft = buildIssueDraft(feedback);
    if (options.dryRun) {
      dependencies.logger.log(`[testflight-feedback] Dry run: would create "${draft.title}"`);
      result.dryRun += 1;
      continue;
    }

    if (await dependencies.issueSink.issueExists(draft.marker)) {
      dependencies.logger.log(`[testflight-feedback] Skipping existing ${feedback.kind} feedback ${feedback.id}`);
      result.skippedExisting += 1;
      continue;
    }

    await dependencies.issueSink.ensureLabels(draft.labels);
    const issueNumber = await dependencies.issueSink.createIssue(draft);
    for (const comment of draft.comments) {
      await dependencies.issueSink.addIssueComment(issueNumber, comment);
    }
    dependencies.logger.log(
      `[testflight-feedback] Created issue #${issueNumber} for ${feedback.kind} feedback ${feedback.id}`,
    );
    result.created += 1;
  }

  dependencies.logger.log(
    `[testflight-feedback] Done. created=${result.created} dryRun=${result.dryRun} skippedExisting=${result.skippedExisting}`,
  );
  return result;
}

function compareFeedbackNewestFirst(left: TestFlightFeedback, right: TestFlightFeedback): number {
  const leftTime = left.createdDate ? Date.parse(left.createdDate) : 0;
  const rightTime = right.createdDate ? Date.parse(right.createdDate) : 0;
  return rightTime - leftTime;
}

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseCliOptions(argv: string[], env: NodeJS.ProcessEnv = process.env): CliOptions {
  const options: CliOptions = {
    appId: env.APP_STORE_CONNECT_APP_ID ?? null,
    bundleId: env.ASC_BUNDLE_ID ?? DEFAULT_BUNDLE_ID,
    dryRun: false,
    githubRepository: env.GITHUB_REPOSITORY ?? 'boardsesh/boardsesh',
    lookbackHours: DEFAULT_LOOKBACK_HOURS,
    maxPages: DEFAULT_MAX_PAGES,
    pageLimit: DEFAULT_PAGE_LIMIT,
    since: null,
  };

  for (let argumentIndex = 0; argumentIndex < argv.length; argumentIndex++) {
    const argument = argv[argumentIndex];
    if (argument === '--') continue;

    if (argument === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (argument === '--app-id') {
      options.appId = argv[++argumentIndex] ?? null;
      continue;
    }
    if (argument.startsWith('--app-id=')) {
      options.appId = argument.slice('--app-id='.length);
      continue;
    }
    if (argument === '--bundle-id') {
      options.bundleId = argv[++argumentIndex] ?? options.bundleId;
      continue;
    }
    if (argument.startsWith('--bundle-id=')) {
      options.bundleId = argument.slice('--bundle-id='.length);
      continue;
    }
    if (argument === '--repo') {
      options.githubRepository = argv[++argumentIndex] ?? options.githubRepository;
      continue;
    }
    if (argument.startsWith('--repo=')) {
      options.githubRepository = argument.slice('--repo='.length);
      continue;
    }
    if (argument === '--lookback-hours') {
      options.lookbackHours = parsePositiveInteger(argv[++argumentIndex] ?? '', '--lookback-hours');
      continue;
    }
    if (argument.startsWith('--lookback-hours=')) {
      options.lookbackHours = parsePositiveInteger(argument.slice('--lookback-hours='.length), '--lookback-hours');
      continue;
    }
    if (argument === '--page-limit') {
      options.pageLimit = parsePositiveInteger(argv[++argumentIndex] ?? '', '--page-limit');
      continue;
    }
    if (argument.startsWith('--page-limit=')) {
      options.pageLimit = parsePositiveInteger(argument.slice('--page-limit='.length), '--page-limit');
      continue;
    }
    if (argument === '--max-pages') {
      options.maxPages = parsePositiveInteger(argv[++argumentIndex] ?? '', '--max-pages');
      continue;
    }
    if (argument.startsWith('--max-pages=')) {
      options.maxPages = parsePositiveInteger(argument.slice('--max-pages='.length), '--max-pages');
      continue;
    }
    if (argument === '--since') {
      options.since = new Date(argv[++argumentIndex] ?? '');
      continue;
    }
    if (argument.startsWith('--since=')) {
      options.since = new Date(argument.slice('--since='.length));
      continue;
    }

    throw new Error(`Unknown argument: ${argument}`);
  }

  if (options.since && Number.isNaN(options.since.getTime())) {
    throw new Error('--since must be an ISO-8601 date');
  }
  if (options.pageLimit > 200) {
    throw new Error('--page-limit cannot exceed App Store Connect limit 200');
  }

  return options;
}

async function runCli(argv: string[], env: NodeJS.ProcessEnv, logger: Logger): Promise<number> {
  try {
    const cliOptions = parseCliOptions(argv, env);
    const privateKeySecret = getRequiredEnv('APP_STORE_CONNECT_API_KEY_BASE64', env);
    const token = createAppStoreConnectJwt({
      issuerId: getRequiredEnv('APP_STORE_CONNECT_ISSUER_ID', env),
      keyId: getRequiredEnv('APP_STORE_CONNECT_API_KEY_ID', env),
      privateKey: decodePrivateKey(privateKeySecret),
    });
    const githubToken = cliOptions.dryRun ? null : getRequiredEnv('GITHUB_TOKEN', env);
    const since = cliOptions.since ?? new Date(Date.now() - cliOptions.lookbackHours * 60 * 60 * 1000);

    const feedbackSource = new AppStoreConnectClient({ token });
    const issueSink = githubToken
      ? new GitHubIssueClient({ repositoryFullName: cliOptions.githubRepository, token: githubToken })
      : dryRunIssueSink();

    await syncTestFlightFeedback(
      {
        appId: cliOptions.appId,
        bundleId: cliOptions.bundleId,
        dryRun: cliOptions.dryRun,
        maxPages: cliOptions.maxPages,
        pageLimit: cliOptions.pageLimit,
        since,
      },
      { feedbackSource, issueSink, logger },
    );
    return 0;
  } catch (error) {
    logger.error(`[testflight-feedback] ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

function dryRunIssueSink(): IssueSink {
  return {
    addIssueComment: async () => undefined,
    createIssue: async () => 0,
    ensureLabels: async () => undefined,
    issueExists: async () => false,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runCli(process.argv.slice(2), process.env, console).then((exitCode) => {
    process.exit(exitCode);
  });
}
