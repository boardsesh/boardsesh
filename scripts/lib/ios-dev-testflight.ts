import { createPrivateKey, sign } from 'node:crypto';

export const IOS_DEV_BUNDLE_ID = 'com.boardsesh.app.dev';
export const IOS_DEV_RELEASE_PREFIX = 'rn-ios-dev-';
const RENEW_AFTER_MS = 60 * 24 * 60 * 60 * 1000;

export interface IosDevBaseline {
  bundleId: string;
  fingerprint: string;
  commit: string;
  appId: string;
  buildId: string;
  buildNumber: string;
  version: string;
}

export interface AppleBuild {
  id: string;
  number: string;
  version: string;
  uploadedDate: string;
  expirationDate: string;
  expired: boolean;
  processingState: string;
  buildAudienceType: string;
  internalBuildState: string;
}

export type AppleApiFetchRequest = (
  url: string,
  options: { headers: Record<string, string>; signal: AbortSignal; redirect: 'error' },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export function isReusableDevBuild(
  baseline: IosDevBaseline,
  fingerprint: string,
  build: AppleBuild,
  now = Date.now(),
): boolean {
  const uploadedAt = Date.parse(build.uploadedDate);
  const expiresAt = Date.parse(build.expirationDate);
  return (
    baseline.bundleId === IOS_DEV_BUNDLE_ID &&
    baseline.fingerprint === fingerprint &&
    baseline.buildId === build.id &&
    baseline.buildNumber === build.number &&
    baseline.version === build.version &&
    isReadyDevBuild(build) &&
    Number.isFinite(uploadedAt) &&
    Number.isFinite(expiresAt) &&
    uploadedAt <= now &&
    now - uploadedAt < RENEW_AFTER_MS &&
    expiresAt > now
  );
}

export function isReadyDevBuild(build: AppleBuild): boolean {
  return (
    build.processingState === 'VALID' &&
    build.buildAudienceType === 'INTERNAL_ONLY' &&
    !build.expired &&
    ['READY_FOR_BETA_TESTING', 'IN_BETA_TESTING'].includes(build.internalBuildState)
  );
}

export function parseDevBaseline(contents: string): IosDevBaseline {
  const baseline = JSON.parse(contents) as unknown;
  if (!isRecord(baseline)) throw new Error('Invalid iOS Dev baseline');
  const fields = ['bundleId', 'fingerprint', 'commit', 'appId', 'buildId', 'buildNumber', 'version'] as const;
  for (const field of fields) {
    if (typeof baseline[field] !== 'string' || !baseline[field]) throw new Error(`Invalid baseline ${field}`);
  }
  if (baseline.bundleId !== IOS_DEV_BUNDLE_ID || !/^[a-f0-9]{40}$/i.test(String(baseline.fingerprint))) {
    throw new Error('Baseline is not a fingerprinted iOS Dev build');
  }
  return baseline as unknown as IosDevBaseline;
}

export function createAppleApiToken(environment: NodeJS.ProcessEnv, now = Date.now()): string {
  const keyId = environment.APP_STORE_CONNECT_API_KEY_ID;
  const issuer = environment.APP_STORE_CONNECT_ISSUER_ID;
  const encodedKey = environment.APP_STORE_CONNECT_API_KEY_BASE64;
  if (!keyId || !issuer || !encodedKey) throw new Error('App Store Connect API credentials are required');
  const issuedAt = Math.floor(now / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' })).toString('base64url');
  const claims = Buffer.from(
    JSON.stringify({ iss: issuer, iat: issuedAt, exp: issuedAt + 600, aud: 'appstoreconnect-v1' }),
  ).toString('base64url');
  const unsignedToken = `${header}.${claims}`;
  const key = createPrivateKey(Buffer.from(encodedKey, 'base64'));
  const signature = sign('sha256', Buffer.from(unsignedToken), { key, dsaEncoding: 'ieee-p1363' });
  return `${unsignedToken}.${signature.toString('base64url')}`;
}

type AppleResource = {
  id: string;
  type: string;
  attributes: Record<string, unknown>;
  relationships?: Record<string, { data?: { id: string } }>;
};

function isRecord(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate);
}

function stringAttribute(candidate: unknown): string {
  return typeof candidate === 'string' ? candidate : '';
}

function appleResource(candidate: unknown): AppleResource {
  if (!isRecord(candidate) || typeof candidate.id !== 'string' || typeof candidate.type !== 'string') {
    throw new Error('Invalid App Store Connect resource');
  }
  if (!isRecord(candidate.attributes)) throw new Error('Missing App Store Connect attributes');
  return candidate as unknown as AppleResource;
}

export class AppleDevBuildClient {
  constructor(
    private readonly environment: NodeJS.ProcessEnv,
    private readonly fetchRequest: AppleApiFetchRequest = (url, options) => fetch(url, options),
  ) {}

  private async get(path: string): Promise<{ resources: AppleResource[]; included: AppleResource[] }> {
    const response = await this.fetchRequest(`https://api.appstoreconnect.apple.com${path}`, {
      headers: { Authorization: `Bearer ${createAppleApiToken(this.environment)}` },
      signal: AbortSignal.timeout(30_000),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`App Store Connect ${response.status} for ${path.split('?')[0]}`);
    const payload = (await response.json()) as unknown;
    if (!isRecord(payload)) throw new Error('Invalid App Store Connect response');
    const resources = (Array.isArray(payload.data) ? payload.data : [payload.data]).map(appleResource);
    const included = Array.isArray(payload.included) ? payload.included.map(appleResource) : [];
    return { resources, included };
  }

  async appId(): Promise<string> {
    const query = new URLSearchParams({ 'filter[bundleId]': IOS_DEV_BUNDLE_ID, limit: '2' });
    const { resources } = await this.get(`/v1/apps?${query}`);
    if (resources.length !== 1 || resources[0].attributes.bundleId !== IOS_DEV_BUNDLE_ID) {
      throw new Error(`Create the ${IOS_DEV_BUNDLE_ID} app record in App Store Connect first`);
    }
    return resources[0].id;
  }

  private parseBuild(resource: AppleResource, included: AppleResource[]): AppleBuild {
    const versionId = resource.relationships?.preReleaseVersion?.data?.id;
    const betaDetailId = resource.relationships?.buildBetaDetail?.data?.id;
    const version = included.find((candidate) => candidate.type === 'preReleaseVersions' && candidate.id === versionId);
    const betaDetails = included.find(
      (candidate) => candidate.type === 'buildBetaDetails' && candidate.id === betaDetailId,
    );
    const attributes = resource.attributes;
    return {
      id: resource.id,
      number: stringAttribute(attributes.version),
      version: stringAttribute(version?.attributes.version),
      uploadedDate: stringAttribute(attributes.uploadedDate),
      expirationDate: stringAttribute(attributes.expirationDate),
      expired: attributes.expired !== false,
      processingState: stringAttribute(attributes.processingState),
      buildAudienceType: stringAttribute(attributes.buildAudienceType),
      internalBuildState: stringAttribute(betaDetails?.attributes.internalBuildState),
    };
  }

  async build(appId: string, buildNumber: string, version: string): Promise<AppleBuild | null> {
    const query = new URLSearchParams({
      'filter[app]': appId,
      'filter[version]': buildNumber,
      include: 'preReleaseVersion,buildBetaDetail',
      limit: '200',
    });
    const { resources, included } = await this.get(`/v1/builds?${query}`);
    return (
      resources.map((resource) => this.parseBuild(resource, included)).find((build) => build.version === version) ??
      null
    );
  }
}
