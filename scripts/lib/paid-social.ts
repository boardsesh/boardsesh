/**
 * Code-owned Meta (Instagram) and Reddit ad campaigns. The config in
 * app-stores/<platform>/ads.json is the source of truth; reconcile() turns the
 * gap between it and the live account into a list of operations.
 *
 * Safety rules, enforced here and not in the platform clients:
 * - Nothing is ever deleted or archived. A managed entity that leaves the
 *   config is paused.
 * - A campaign is managed only when its name starts with the config namespace
 *   or its id is listed under adoptCampaignIds. Everything else is read by
 *   audit and never written.
 * - Every create starts PAUSED; activation is a separate, last step.
 * - Spend caps are checked on the config (validateConfig) and again on the
 *   live plan before the first write (planGuardrails).
 *
 * See docs/paid-social-ads.md.
 */
import { createHash } from 'node:crypto';
import {
  META_AD_NAME_MACRO,
  PAID_SOCIAL_LANDING,
  assertAdId,
  assertCampaignCode,
  buildPaidSocialUrl,
  paidSocialUrlTags,
  type PaidSocialSource,
} from './paid-social-urls';

export type Platform = 'meta' | 'reddit';
export type ConfigStatus = 'ACTIVE' | 'PAUSED';
export type CampaignStatus = ConfigStatus | 'ADOPT_PENDING';

export const PLATFORM_SOURCE: Record<Platform, PaidSocialSource> = { meta: 'instagram', reddit: 'reddit' };
const OBJECTIVES: Record<Platform, string[]> = { meta: ['OUTCOME_TRAFFIC'], reddit: ['CLICKS'] };
const PLACEMENTS: Record<Platform, string[]> = {
  meta: ['stream', 'story', 'reels', 'explore', 'explore_home', 'profile_feed', 'ig_search'],
  reddit: ['FEED', 'COMMENTS_PAGE'],
};
/** Two-decimal currencies only: Meta budgets are minor units (x100), Reddit's are micros. */
const CURRENCIES = ['USD', 'AUD', 'EUR', 'GBP', 'CAD', 'NZD'];
const META_CALLS_TO_ACTION = ['LEARN_MORE', 'DOWNLOAD', 'SIGN_UP', 'INSTALL_MOBILE_APP', 'GET_STARTED'];
export const CREATIVE_DIRECTORY = 'app-stores/paid-social/creatives/';
/** A budget may at most double in one apply unless the config sets allowBudgetJump. */
export const MAX_BUDGET_MULTIPLIER = 2;
export const MANAGED_NAMESPACE = 'Boardsesh Managed';

export interface MetaInterest {
  id: string;
  name: string;
}
export interface TargetingConfig {
  countries: string[];
  placements: string[];
  /** Meta: [{ id, name }] from the Targeting Search API. Reddit: interest ids as the audit prints them. */
  interests: (MetaInterest | string)[];
  /** Reddit only: community (subreddit) values as the audit prints them. */
  communities?: string[];
  /** Meta only. */
  ageMin?: number;
  ageMax?: number;
}
export interface MetaFileCreative {
  image: string;
  headline: string;
  body: string;
  callToAction: string;
}
export interface MetaExistingCreative {
  existingCreativeId: string | null;
}
export interface RedditPostCreative {
  postId: string | null;
}
export type CreativeConfig = MetaFileCreative | MetaExistingCreative | RedditPostCreative;
export interface AdConfig {
  name: string;
  status: ConfigStatus;
  creative: CreativeConfig;
}
export interface AdGroupConfig {
  name: string;
  status: ConfigStatus;
  dailyBudget?: string;
  targeting: TargetingConfig;
  ads: AdConfig[];
}
export interface CampaignConfig {
  '//'?: string;
  code: string;
  status: CampaignStatus;
  objective: string;
  dailyBudget?: string;
  startDate: string;
  endDate: string | null;
  adGroups: AdGroupConfig[];
}
export interface AdoptEntry {
  id: string;
  code: string;
}
export interface PaidSocialConfig {
  '//'?: string;
  version: 1;
  platform: Platform;
  /** null until the account exists or is known; every live action refuses to run without it. */
  adAccountId: string | null;
  currency: string;
  namespace: string;
  maxDailyBudgetTotal: string;
  allowBudgetJump: boolean;
  adoptCampaignIds: AdoptEntry[];
  meta?: { pageId: string | null; instagramUserId: string | null };
  reddit?: { pixelId: string | null };
  campaigns: CampaignConfig[];
}

// ---------------------------------------------------------------------------
// Config validation

type Row = Record<string, unknown>;

function asRow(input: unknown, where: string): Row {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(`${where} must be an object`);
  return input as Row;
}
function onlyKeys(input: Row, allowed: string[], where: string) {
  const unknownKeys = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknownKeys.length)
    throw new Error(`${where} has unsupported field(s): ${unknownKeys.join(', ')} (lifetime budgets are refused)`);
}
function identifier(input: unknown, where: string): string {
  if (typeof input !== 'string' || !/^[A-Za-z0-9_]{1,40}$/.test(input)) throw new Error(`${where} must be an id`);
  return input;
}
function nullableIdentifier(input: unknown, where: string): string | null {
  return input === null ? null : identifier(input, where);
}

/** "12.50" -> 1250. Positive, at most two decimals. */
export function toCents(amount: unknown, where = 'Budget'): number {
  if (typeof amount !== 'string' || !/^\d{1,5}(\.\d{1,2})?$/.test(amount))
    throw new Error(`${where} must be a decimal string like "10.00"`);
  const [whole, fraction = ''] = amount.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (cents <= 0) throw new Error(`${where} must be greater than zero`);
  return cents;
}
export function formatCents(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}
function isoDate(input: unknown, where: string): string {
  if (typeof input !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input) || Number.isNaN(Date.parse(`${input}T00:00:00Z`)))
    throw new Error(`${where} must be YYYY-MM-DD`);
  if (new Date(`${input}T00:00:00Z`).toISOString().slice(0, 10) !== input)
    throw new Error(`${where} is not a real date`);
  return input;
}
function stringList(input: unknown, where: string, pattern: RegExp, allowEmpty: boolean): string[] {
  if (!Array.isArray(input) || (!allowEmpty && input.length === 0)) throw new Error(`${where} must be a list`);
  for (const entry of input)
    if (typeof entry !== 'string' || !pattern.test(entry)) throw new Error(`${where} has an invalid entry`);
  if (new Set(input).size !== input.length) throw new Error(`${where} has duplicates`);
  return input as string[];
}

function validateTargeting(platform: Platform, input: unknown, where: string): TargetingConfig {
  const targeting = asRow(input, where);
  onlyKeys(
    targeting,
    platform === 'meta'
      ? ['countries', 'placements', 'interests', 'ageMin', 'ageMax']
      : ['countries', 'placements', 'interests', 'communities'],
    where,
  );
  stringList(targeting.countries, `${where}.countries`, /^[A-Z]{2}$/, false);
  const placements = stringList(targeting.placements, `${where}.placements`, /^[A-Za-z_]+$/, false);
  if (placements.some((placement) => !PLACEMENTS[platform].includes(placement)))
    throw new Error(`${where}.placements must be from ${PLACEMENTS[platform].join(', ')}`);
  if (!Array.isArray(targeting.interests)) throw new Error(`${where}.interests must be a list`);
  if (platform === 'meta') {
    const interestIds = targeting.interests.map((interest, index) => {
      const entry = asRow(interest, `${where}.interests[${index}]`);
      onlyKeys(entry, ['id', 'name'], `${where}.interests[${index}]`);
      if (typeof entry.id !== 'string' || !/^\d{1,20}$/.test(entry.id) || typeof entry.name !== 'string')
        throw new Error(`${where}.interests[${index}] needs a numeric id and a name`);
      return entry.id;
    });
    if (new Set(interestIds).size !== interestIds.length) throw new Error(`${where}.interests has duplicates`);
    for (const key of ['ageMin', 'ageMax'] as const) {
      const age = targeting[key];
      if (age !== undefined && (!Number.isInteger(age) || (age as number) < 18 || (age as number) > 65))
        throw new Error(`${where}.${key} must be an integer from 18 to 65`);
    }
    if (
      typeof targeting.ageMin === 'number' &&
      typeof targeting.ageMax === 'number' &&
      targeting.ageMin > targeting.ageMax
    )
      throw new Error(`${where}.ageMin is above ageMax`);
  } else {
    stringList(targeting.interests, `${where}.interests`, /^[A-Za-z0-9_:.-]{1,80}$/, true);
    stringList(targeting.communities ?? [], `${where}.communities`, /^[A-Za-z0-9_]{2,40}$/, true);
  }
  return targeting as unknown as TargetingConfig;
}

function validateCreative(platform: Platform, input: unknown, where: string): CreativeConfig {
  const creative = asRow(input, where);
  if (platform === 'reddit') {
    onlyKeys(creative, ['postId'], where);
    if (
      creative.postId !== null &&
      (typeof creative.postId !== 'string' || !/^t3_[a-z0-9]{1,20}$/.test(creative.postId))
    )
      throw new Error(`${where}.postId must be a t3_ post id or null`);
    return creative as unknown as RedditPostCreative;
  }
  if ('existingCreativeId' in creative) {
    onlyKeys(creative, ['existingCreativeId'], where);
    nullableIdentifier(creative.existingCreativeId, `${where}.existingCreativeId`);
    return creative as unknown as MetaExistingCreative;
  }
  onlyKeys(creative, ['image', 'headline', 'body', 'callToAction'], where);
  if (
    typeof creative.image !== 'string' ||
    !creative.image.startsWith(CREATIVE_DIRECTORY) ||
    creative.image.includes('..') ||
    !/\.(jpe?g|png)$/i.test(creative.image)
  )
    throw new Error(`${where}.image must be a .jpg or .png under ${CREATIVE_DIRECTORY}`);
  if (typeof creative.headline !== 'string' || !creative.headline.trim() || creative.headline.length > 40)
    throw new Error(`${where}.headline must be 1-40 characters`);
  if (typeof creative.body !== 'string' || !creative.body.trim() || creative.body.length > 500)
    throw new Error(`${where}.body must be 1-500 characters`);
  if (typeof creative.callToAction !== 'string' || !META_CALLS_TO_ACTION.includes(creative.callToAction))
    throw new Error(`${where}.callToAction must be one of ${META_CALLS_TO_ACTION.join(', ')}`);
  return creative as unknown as MetaFileCreative;
}

/** Active spend the config asks for, in cents. ADOPT_PENDING campaigns are not ours yet and spend nothing through us. */
export function plannedActiveCents(config: PaidSocialConfig): number {
  let total = 0;
  for (const campaign of config.campaigns) {
    if (campaign.status !== 'ACTIVE') continue;
    const activeGroups = campaign.adGroups.filter((group) => group.status === 'ACTIVE');
    if (campaign.dailyBudget !== undefined) {
      if (activeGroups.length) total += toCents(campaign.dailyBudget);
    } else for (const group of activeGroups) total += toCents(group.dailyBudget);
  }
  return total;
}

export function validateConfig(input: unknown, expectedPlatform?: Platform): PaidSocialConfig {
  const config = asRow(input, 'Config');
  onlyKeys(
    config,
    [
      '//',
      'version',
      'platform',
      'adAccountId',
      'currency',
      'namespace',
      'maxDailyBudgetTotal',
      'allowBudgetJump',
      'adoptCampaignIds',
      'meta',
      'reddit',
      'campaigns',
    ],
    'Config',
  );
  if (config.version !== 1) throw new Error('Config version must be 1');
  if (config.platform !== 'meta' && config.platform !== 'reddit')
    throw new Error('Config platform must be meta or reddit');
  const platform: Platform = config.platform;
  if (expectedPlatform && platform !== expectedPlatform)
    throw new Error(`Config is for ${platform}, not ${expectedPlatform}`);
  nullableIdentifier(config.adAccountId, 'adAccountId');
  if (typeof config.currency !== 'string' || !CURRENCIES.includes(config.currency))
    throw new Error(`currency must be one of ${CURRENCIES.join(', ')}`);
  // Pinned: changing it would orphan every managed campaign (still spending, outside the cap) and create copies.
  if (config.namespace !== MANAGED_NAMESPACE) throw new Error(`namespace must be "${MANAGED_NAMESPACE}"`);
  const capCents = toCents(config.maxDailyBudgetTotal, 'maxDailyBudgetTotal');
  if (typeof config.allowBudgetJump !== 'boolean') throw new Error('allowBudgetJump must be true or false');

  if (platform === 'meta') {
    if (config.reddit !== undefined) throw new Error('A Meta config cannot carry a reddit block');
    const meta = asRow(config.meta, 'meta');
    onlyKeys(meta, ['pageId', 'instagramUserId'], 'meta');
    nullableIdentifier(meta.pageId, 'meta.pageId');
    nullableIdentifier(meta.instagramUserId, 'meta.instagramUserId');
  } else {
    if (config.meta !== undefined) throw new Error('A Reddit config cannot carry a meta block');
    const reddit = asRow(config.reddit, 'reddit');
    onlyKeys(reddit, ['pixelId'], 'reddit');
    nullableIdentifier(reddit.pixelId, 'reddit.pixelId');
  }

  if (!Array.isArray(config.campaigns) || config.campaigns.length === 0) throw new Error('No campaigns configured');
  const codes = new Set<string>();
  for (const [campaignIndex, rawCampaign] of config.campaigns.entries()) {
    const where = `campaigns[${campaignIndex}]`;
    const campaign = asRow(rawCampaign, where);
    onlyKeys(campaign, ['//', 'code', 'status', 'objective', 'dailyBudget', 'startDate', 'endDate', 'adGroups'], where);
    const code = assertCampaignCode(campaign.code as string);
    if (codes.has(code)) throw new Error(`Duplicate campaign code ${code}`);
    codes.add(code);
    if (!['ACTIVE', 'PAUSED', 'ADOPT_PENDING'].includes(campaign.status as string))
      throw new Error(`${where}.status must be ACTIVE, PAUSED or ADOPT_PENDING`);
    if (!OBJECTIVES[platform].includes(campaign.objective as string))
      throw new Error(`${where}.objective must be ${OBJECTIVES[platform].join(' or ')}`);
    const startDate = isoDate(campaign.startDate, `${where}.startDate`);
    if (campaign.endDate !== null && isoDate(campaign.endDate, `${where}.endDate`) < startDate)
      throw new Error(`${where}.endDate is before startDate`);
    const campaignBudget = campaign.dailyBudget;
    if (campaignBudget !== undefined && toCents(campaignBudget, `${where}.dailyBudget`) > capCents)
      throw new Error(`${where}.dailyBudget is above maxDailyBudgetTotal`);
    if (!Array.isArray(campaign.adGroups) || campaign.adGroups.length === 0)
      throw new Error(`${where} needs ad groups`);
    const groupNames = new Set<string>();
    const adNames = new Set<string>();
    for (const [groupIndex, rawGroup] of campaign.adGroups.entries()) {
      const groupWhere = `${where}.adGroups[${groupIndex}]`;
      const group = asRow(rawGroup, groupWhere);
      onlyKeys(group, ['name', 'status', 'dailyBudget', 'targeting', 'ads'], groupWhere);
      if (typeof group.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 _-]{0,59}$/.test(group.name))
        throw new Error(`${groupWhere}.name must be 1-60 letters, digits, spaces, _ or -`);
      if (groupNames.has(group.name)) throw new Error(`Duplicate ad group name ${group.name} in ${code}`);
      groupNames.add(group.name);
      if (!['ACTIVE', 'PAUSED'].includes(group.status as string))
        throw new Error(`${groupWhere}.status must be ACTIVE or PAUSED`);
      if (campaignBudget === undefined) {
        if (group.dailyBudget === undefined)
          throw new Error(
            `${groupWhere} needs a dailyBudget (or set one on the campaign); unbounded budgets are refused`,
          );
        if (toCents(group.dailyBudget, `${groupWhere}.dailyBudget`) > capCents)
          throw new Error(`${groupWhere}.dailyBudget is above maxDailyBudgetTotal`);
      } else if (group.dailyBudget !== undefined)
        throw new Error(`${groupWhere}.dailyBudget conflicts with the campaign budget: set one level only`);
      validateTargeting(platform, group.targeting, `${groupWhere}.targeting`);
      if (!Array.isArray(group.ads) || group.ads.length === 0) throw new Error(`${groupWhere} needs ads`);
      for (const [adIndex, rawAd] of group.ads.entries()) {
        const adWhere = `${groupWhere}.ads[${adIndex}]`;
        const ad = asRow(rawAd, adWhere);
        onlyKeys(ad, ['name', 'status', 'creative'], adWhere);
        assertAdId(ad.name as string);
        if (adNames.has(ad.name as string)) throw new Error(`Duplicate ad name ${String(ad.name)} in ${code}`);
        adNames.add(ad.name as string);
        if (!['ACTIVE', 'PAUSED'].includes(ad.status as string))
          throw new Error(`${adWhere}.status must be ACTIVE or PAUSED`);
        validateCreative(platform, ad.creative, `${adWhere}.creative`);
      }
    }
  }

  if (!Array.isArray(config.adoptCampaignIds)) throw new Error('adoptCampaignIds must be a list');
  const adoptIds = new Set<string>();
  const adoptCodes = new Set<string>();
  for (const [index, rawEntry] of config.adoptCampaignIds.entries()) {
    const entry = asRow(rawEntry, `adoptCampaignIds[${index}]`);
    onlyKeys(entry, ['id', 'code'], `adoptCampaignIds[${index}]`);
    const adoptId = identifier(entry.id, `adoptCampaignIds[${index}].id`);
    const campaign = (config.campaigns as Row[]).find((candidate) => candidate.code === entry.code);
    if (!campaign) throw new Error(`adoptCampaignIds[${index}].code does not name a configured campaign`);
    if (campaign.status === 'ADOPT_PENDING')
      throw new Error(`Campaign ${String(entry.code)} is adopted: set its status to PAUSED or ACTIVE`);
    if (adoptIds.has(adoptId) || adoptCodes.has(entry.code as string))
      throw new Error('adoptCampaignIds has a duplicate id or code');
    adoptIds.add(adoptId);
    adoptCodes.add(entry.code as string);
  }

  const typed = config as unknown as PaidSocialConfig;
  const planned = plannedActiveCents(typed);
  if (planned > capCents)
    throw new Error(
      `Active daily budgets total ${formatCents(planned)} ${typed.currency}, above maxDailyBudgetTotal ${typed.maxDailyBudgetTotal}`,
    );
  return typed;
}

// ---------------------------------------------------------------------------
// Names, destinations, creatives

export function campaignName(config: PaidSocialConfig, campaign: CampaignConfig): string {
  return `${config.namespace} ${campaign.code}`;
}
export function isManagedName(config: PaidSocialConfig, name: string): boolean {
  return name.startsWith(`${config.namespace} `);
}
/** Reddit carries a literal ad id; Meta carries the {{ad.name}} macro in url_tags. */
export function adDestination(config: PaidSocialConfig, campaign: CampaignConfig, ad: AdConfig): string {
  return buildPaidSocialUrl({
    source: PLATFORM_SOURCE[config.platform],
    campaignCode: campaign.code,
    adId: config.platform === 'meta' ? META_AD_NAME_MACRO : ad.name,
  });
}
export function metaUrlTags(campaign: CampaignConfig): string {
  return paidSocialUrlTags({ source: 'instagram', campaignCode: campaign.code, adId: META_AD_NAME_MACRO });
}
export function isFileCreative(creative: CreativeConfig): creative is MetaFileCreative {
  return 'image' in creative;
}
export type ReadCreativeFile = (path: string) => Promise<Uint8Array>;

export interface CreativeWrite {
  name: string;
  image: Uint8Array;
  imageName: string;
  headline: string;
  body: string;
  callToAction: string;
  link: string;
  urlTags: string;
  pageId: string;
  instagramUserId: string;
}

/** Content-addressed name: a re-apply with the same file and copy finds the creative already on the ad and uploads nothing. */
export function fileCreativeName(
  config: PaidSocialConfig,
  ad: AdConfig,
  creative: MetaFileCreative,
  image: Uint8Array,
  campaign: CampaignConfig,
): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        image: createHash('sha256').update(image).digest('hex'),
        headline: creative.headline,
        body: creative.body,
        callToAction: creative.callToAction,
        link: PAID_SOCIAL_LANDING,
        urlTags: metaUrlTags(campaign),
        pageId: config.meta?.pageId,
        instagramUserId: config.meta?.instagramUserId,
      }),
    )
    .digest('hex')
    .slice(0, 12);
  return `${config.namespace} ${ad.name} ${digest}`;
}

// ---------------------------------------------------------------------------
// Live model and client contract

export interface Targeting {
  countries: string[];
  placements: string[];
  interests: string[];
  communities: string[];
  ageMin: number | null;
  ageMax: number | null;
  /** Live targeting fields the config cannot express (custom audiences, regions, exclusions...). A rewrite would drop them, so they block. */
  unmanaged?: string[];
}
export interface LiveCampaign {
  id: string;
  name: string;
  status: string;
  objective: string;
  dailyBudgetCents: number | null;
  lifetimeBudget: boolean;
}
export interface LiveAdGroup {
  id: string;
  name: string;
  campaignId: string;
  status: string;
  dailyBudgetCents: number | null;
  lifetimeBudget: boolean;
  endDate: string | null;
  targeting: Targeting;
}
export interface LiveAd {
  id: string;
  name: string;
  adGroupId: string;
  status: string;
  /** Reddit: click_url. Meta: creative link + url_tags. */
  destination: string | null;
  /** Reddit: post id. Meta: creative id. */
  creativeId: string | null;
  creativeName: string | null;
}
export interface CampaignWrite {
  name: string;
  objective: string;
  dailyBudgetCents: number | null;
  /** Reddit needs both on a campaign-budget (CBO) campaign; Meta schedules on the ad set. */
  startTime: string;
  endTime: string | null;
}
export interface CampaignPatch {
  name?: string;
  status?: ConfigStatus;
  dailyBudgetCents?: number;
}
export interface AdGroupWrite {
  name: string;
  dailyBudgetCents: number | null;
  startTime: string;
  endTime: string | null;
  targeting: Targeting;
}
export interface AdGroupPatch {
  name?: string;
  status?: ConfigStatus;
  dailyBudgetCents?: number;
  endTime?: string | null;
  targeting?: Targeting;
}
export interface AdWrite {
  name: string;
  status: ConfigStatus;
  destination: string;
  creativeId: string;
}
export interface AdPatch {
  status?: ConfigStatus;
  destination?: string;
  creativeId?: string;
}
export interface PaidSocialClient {
  platform: Platform;
  account(): Promise<{ id: string; currency: string }>;
  listCampaigns(): Promise<LiveCampaign[]>;
  listAdGroups(campaignId: string): Promise<LiveAdGroup[]>;
  listAds(adGroupId: string): Promise<LiveAd[]>;
  /** Created PAUSED, always. */
  createCampaign(spec: CampaignWrite): Promise<string>;
  updateCampaign(id: string, patch: CampaignPatch): Promise<void>;
  /** Created PAUSED, always. */
  createAdGroup(campaignId: string, spec: AdGroupWrite): Promise<string>;
  updateAdGroup(id: string, patch: AdGroupPatch): Promise<void>;
  createCreative(spec: CreativeWrite): Promise<string>;
  createAd(adGroupId: string, spec: AdWrite): Promise<string>;
  updateAd(id: string, patch: AdPatch): Promise<void>;
}

const GONE = new Set(['DELETED', 'ARCHIVED']);
function present<T extends { status: string }>(entities: T[]): T[] {
  return entities.filter((entity) => !GONE.has(entity.status));
}
function isActive(status: string) {
  return status === 'ACTIVE';
}

/** Meta reports its 18-65 default ages back on every ad set; Reddit has no age targeting. */
export function desiredTargeting(targeting: TargetingConfig, platform: Platform): Targeting {
  return normalizeTargeting({
    countries: targeting.countries,
    placements: targeting.placements,
    interests: targeting.interests.map((interest) => (typeof interest === 'string' ? interest : interest.id)),
    communities: targeting.communities ?? [],
    ageMin: targeting.ageMin ?? (platform === 'meta' ? 18 : null),
    ageMax: targeting.ageMax ?? (platform === 'meta' ? 65 : null),
  });
}
export function normalizeTargeting(targeting: Targeting): Targeting {
  const sorted = (values: string[]) => [...new Set(values)].sort();
  return {
    countries: sorted(targeting.countries),
    placements: sorted(targeting.placements),
    interests: sorted(targeting.interests),
    communities: sorted(targeting.communities.map((community) => community.toLowerCase())),
    ageMin: targeting.ageMin,
    ageMax: targeting.ageMax,
  };
}
function sameTargeting(left: Targeting, right: Targeting) {
  return JSON.stringify(normalizeTargeting(left)) === JSON.stringify(normalizeTargeting(right));
}
function endTime(endDate: string | null): string | null {
  return endDate === null ? null : `${endDate}T23:59:00Z`;
}

// ---------------------------------------------------------------------------
// Planning

export type Target = { id: string } | { ref: string };
interface OperationBase {
  /** 1 pauses, 2 creates and field updates, 3 activations (children before parents). */
  phase: 1 | 2 | 3;
  path: string;
}
export type Operation =
  | (OperationBase & { kind: 'campaign'; action: 'create'; ref: string; spec: CampaignWrite })
  | (OperationBase & {
      kind: 'campaign';
      action: 'update';
      target: Target;
      patch: CampaignPatch;
      liveDailyBudgetCents: number | null;
    })
  | (OperationBase & { kind: 'adGroup'; action: 'create'; ref: string; parent: Target; spec: AdGroupWrite })
  | (OperationBase & {
      kind: 'adGroup';
      action: 'update';
      target: Target;
      patch: AdGroupPatch;
      liveDailyBudgetCents: number | null;
    })
  | (OperationBase & { kind: 'creative'; action: 'create'; ref: string; spec: CreativeWrite })
  | (OperationBase & {
      kind: 'ad';
      action: 'create';
      ref: string;
      parent: Target;
      spec: Omit<AdWrite, 'creativeId'>;
      creative: Target;
    })
  | (OperationBase & {
      kind: 'ad';
      action: 'update';
      target: Target;
      patch: Omit<AdPatch, 'creativeId'>;
      creative?: Target;
    });

export interface PlanResult {
  operations: Operation[];
  pending: string[];
  blocked: string[];
  warnings: string[];
  liveActiveCents: number;
  plannedActiveCents: number;
}

export interface PlanOptions {
  readCreativeFile: ReadCreativeFile;
  now: () => Date;
}

interface MatchedCampaign {
  config: CampaignConfig;
  live: LiveCampaign;
  groups: LiveAdGroup[];
  adsByGroup: Map<string, LiveAd[]>;
}

/**
 * What the live tree can spend today: an ad group counts only when it is ACTIVE, has an ACTIVE ad and has not
 * ended. The 2x jump rule compares against this, so switching on ads under an idle group, or extending an ended
 * group, counts as new spend.
 */
export function liveSpendCents(
  campaign: LiveCampaign,
  groups: LiveAdGroup[],
  adsByGroup: Map<string, LiveAd[]>,
  today: string,
): number {
  if (!isActive(campaign.status)) return 0;
  const activeGroups = groups.filter(
    (group) =>
      isActive(group.status) &&
      (group.endDate === null || group.endDate >= today) &&
      (adsByGroup.get(group.id) ?? []).some((ad) => isActive(ad.status)),
  );
  if (campaign.dailyBudgetCents !== null) return activeGroups.length ? campaign.dailyBudgetCents : 0;
  return activeGroups.reduce((sum, group) => sum + (group.dailyBudgetCents ?? 0), 0);
}

function uniqueByName<T extends { name: string }>(entities: T[], name: string, what: string): T | undefined {
  const matches = entities.filter((entity) => entity.name === name);
  if (matches.length > 1) throw new Error(`Ambiguous ${what} "${name}": rename or pause the duplicate by hand`);
  return matches[0];
}

export async function buildPlan(
  config: PaidSocialConfig,
  client: PaidSocialClient,
  options: PlanOptions,
): Promise<PlanResult> {
  const result: PlanResult = {
    operations: [],
    pending: [],
    blocked: [],
    warnings: [],
    liveActiveCents: 0,
    plannedActiveCents: plannedActiveCents(config),
  };
  const account = await client.account();
  if (account.id !== config.adAccountId || account.currency !== config.currency)
    throw new Error('Ad account id or currency does not match the config');
  const liveCampaigns = present(await client.listCampaigns());
  const today = options.now().toISOString().slice(0, 10);
  const adoptIds = new Set(config.adoptCampaignIds.map((entry) => entry.id));
  const claimed = new Set<string>();
  const matched: MatchedCampaign[] = [];
  const toCreate: CampaignConfig[] = [];

  for (const campaign of config.campaigns) {
    const managedName = campaignName(config, campaign);
    const adoptId = config.adoptCampaignIds.find((entry) => entry.code === campaign.code)?.id;
    const candidates = liveCampaigns.filter((live) => live.id === adoptId || live.name === managedName);
    if (candidates.length > 1) throw new Error(`More than one live campaign claims ${campaign.code}`);
    const live = candidates[0];
    if (live) claimed.add(live.id);
    if (campaign.status === 'ADOPT_PENDING') {
      result.pending.push(`${campaign.code}: adoption pending; run audit and add its live id to adoptCampaignIds`);
      continue;
    }
    if (adoptId && !live) {
      result.blocked.push(`${campaign.code}: adopted campaign ${adoptId} was not found in the account`);
      continue;
    }
    if (!live) {
      const lookalikes = liveCampaigns.filter(
        (candidate) => !isManagedName(config, candidate.name) && candidate.name.toLowerCase().includes(campaign.code),
      );
      if (lookalikes.length) {
        result.blocked.push(
          `${campaign.code}: live campaign ${lookalikes.map((candidate) => candidate.id).join(', ')} already carries this code; adopt it (adoptCampaignIds) instead of creating a duplicate`,
        );
        continue;
      }
      toCreate.push(campaign);
      continue;
    }
    const groups = present(await client.listAdGroups(live.id));
    const adsByGroup = new Map<string, LiveAd[]>();
    for (const group of groups) adsByGroup.set(group.id, present(await client.listAds(group.id)));
    matched.push({ config: campaign, live, groups, adsByGroup });
    result.liveActiveCents += liveSpendCents(live, groups, adsByGroup, today);
  }

  // Managed campaigns that left the config: pause, never delete.
  for (const live of liveCampaigns) {
    if (claimed.has(live.id) || !(isManagedName(config, live.name) || adoptIds.has(live.id))) continue;
    if (isActive(live.status)) {
      const groups = present(await client.listAdGroups(live.id));
      const adsByGroup = new Map<string, LiveAd[]>();
      for (const group of groups) adsByGroup.set(group.id, present(await client.listAds(group.id)));
      result.liveActiveCents += liveSpendCents(live, groups, adsByGroup, today);
    }
    if (isActive(live.status))
      result.operations.push({
        phase: 1,
        kind: 'campaign',
        action: 'update',
        path: live.name,
        target: { id: live.id },
        patch: { status: 'PAUSED' },
        liveDailyBudgetCents: live.dailyBudgetCents,
      });
  }

  const now = options.now();
  const startTime = (startDate: string) => {
    const configured = new Date(`${startDate}T00:00:00Z`);
    return (configured > now ? configured : now).toISOString();
  };

  let refCounter = 0;
  const nextRef = (prefix: string) => `${prefix}-${++refCounter}`;

  async function planAds(
    campaign: CampaignConfig,
    group: AdGroupConfig,
    groupTarget: Target,
    liveAds: LiveAd[],
    groupPath: string,
  ): Promise<{ readyAds: number }> {
    let readyAds = 0;
    for (const ad of group.ads) {
      const path = `${groupPath} / ${ad.name}`;
      const destination = adDestination(config, campaign, ad);
      const live = uniqueByName(liveAds, ad.name, 'ad');
      // Resolve the creative this ad should point at.
      let creative: Target | undefined;
      let creativeMatches = false;
      // A live ad whose configured creative cannot be built yet may be paused but never switched on.
      let creativePending = false;
      const spec = ad.creative;
      if ('postId' in spec || 'existingCreativeId' in spec) {
        const creativeId = 'postId' in spec ? spec.postId : spec.existingCreativeId;
        if (creativeId === null) {
          if (!live) {
            result.pending.push(`${path}: needs a ${config.platform === 'reddit' ? 'postId' : 'existingCreativeId'}`);
            continue;
          }
          // Adopted ad whose creative the config does not pin yet: leave the creative alone.
          creativeMatches = true;
        } else {
          creative = { id: creativeId };
          creativeMatches = live?.creativeId === creativeId;
        }
      } else {
        const pageId = config.meta?.pageId;
        const instagramUserId = config.meta?.instagramUserId;
        if (!pageId || !instagramUserId) {
          result.pending.push(`${path}: meta.pageId and meta.instagramUserId are needed to build a creative`);
          if (!live) continue;
          creativeMatches = true;
          creativePending = true;
        } else {
          const image = await options.readCreativeFile(spec.image);
          const name = fileCreativeName(config, ad, spec, image, campaign);
          creativeMatches = live?.creativeName === name;
          if (!creativeMatches) {
            const ref = nextRef('creative');
            result.operations.push({
              phase: 2,
              kind: 'creative',
              action: 'create',
              path,
              ref,
              spec: {
                name,
                image,
                imageName: spec.image.slice(spec.image.lastIndexOf('/') + 1),
                headline: spec.headline,
                body: spec.body,
                callToAction: spec.callToAction,
                link: PAID_SOCIAL_LANDING,
                urlTags: metaUrlTags(campaign),
                pageId,
                instagramUserId,
              },
            });
            creative = { ref };
          }
        }
      }
      if (config.platform === 'meta' && live && live.destination !== null && live.destination !== destination)
        result.warnings.push(`${path}: live destination ${live.destination} differs from ${destination}`);

      if (!live) {
        if (!creative) continue;
        const ref = nextRef('ad');
        result.operations.push({
          phase: 2,
          kind: 'ad',
          action: 'create',
          path,
          ref,
          parent: groupTarget,
          spec: { name: ad.name, status: 'PAUSED', destination },
          creative,
        });
        if (ad.status === 'ACTIVE')
          result.operations.push({
            phase: 3,
            kind: 'ad',
            action: 'update',
            path,
            target: { ref },
            patch: { status: 'ACTIVE' },
          });
        readyAds++;
        continue;
      }
      readyAds++;
      const patch: Omit<AdPatch, 'creativeId'> = {};
      if (config.platform === 'reddit' && live.destination !== destination) patch.destination = destination;
      const changesCreative = !creativeMatches && creative !== undefined;
      if (Object.keys(patch).length || changesCreative)
        result.operations.push({
          phase: 2,
          kind: 'ad',
          action: 'update',
          path,
          target: { id: live.id },
          patch,
          ...(changesCreative ? { creative } : {}),
        });
      if (live.status !== ad.status && !(creativePending && ad.status === 'ACTIVE'))
        result.operations.push({
          phase: ad.status === 'PAUSED' ? 1 : 3,
          kind: 'ad',
          action: 'update',
          path,
          target: { id: live.id },
          patch: { status: ad.status },
        });
    }
    for (const live of liveAds)
      if (!group.ads.some((ad) => ad.name === live.name) && isActive(live.status))
        result.operations.push({
          phase: 1,
          kind: 'ad',
          action: 'update',
          path: `${groupPath} / ${live.name} (not in config)`,
          target: { id: live.id },
          patch: { status: 'PAUSED' },
        });
    return { readyAds };
  }

  async function planGroups(campaign: CampaignConfig, campaignTarget: Target, existing?: MatchedCampaign) {
    const usesCampaignBudget = campaign.dailyBudget !== undefined;
    for (const group of campaign.adGroups) {
      const path = `${campaign.code} / ${group.name}`;
      const desired = desiredTargeting(group.targeting, config.platform);
      const budgetCents = usesCampaignBudget ? null : toCents(group.dailyBudget);
      const live = existing ? uniqueByName(existing.groups, group.name, 'ad group') : undefined;
      if (!live) {
        if (config.platform === 'reddit' && !config.reddit?.pixelId) {
          result.pending.push(`${path}: reddit.pixelId is needed to create an ad group`);
          continue;
        }
        const ref = nextRef('adGroup');
        result.operations.push({
          phase: 2,
          kind: 'adGroup',
          action: 'create',
          path,
          ref,
          parent: campaignTarget,
          spec: {
            name: group.name,
            dailyBudgetCents: budgetCents,
            startTime: startTime(campaign.startDate),
            endTime: endTime(campaign.endDate),
            targeting: desired,
          },
        });
        const { readyAds } = await planAds(campaign, group, { ref }, [], path);
        if (group.status === 'ACTIVE' && readyAds)
          result.operations.push({
            phase: 3,
            kind: 'adGroup',
            action: 'update',
            path,
            target: { ref },
            patch: { status: 'ACTIVE' },
            liveDailyBudgetCents: budgetCents,
          });
        continue;
      }
      if (live.lifetimeBudget)
        result.blocked.push(`${path}: live ad group uses a lifetime budget; switch it to daily by hand`);
      if (live.targeting.unmanaged?.length)
        result.blocked.push(
          `${path}: live targeting uses ${live.targeting.unmanaged.join(', ')}, which the config cannot express; remove them by hand first`,
        );
      if (usesCampaignBudget !== (live.dailyBudgetCents === null))
        result.blocked.push(`${path}: budget level differs from the live ad group; match the config to the live level`);
      const patch: AdGroupPatch = {};
      if (budgetCents !== null && live.dailyBudgetCents !== budgetCents) patch.dailyBudgetCents = budgetCents;
      if ((live.endDate ?? null) !== campaign.endDate) {
        if (campaign.endDate === null)
          result.blocked.push(`${path}: clearing a live end date is not supported; set endDate or clear it by hand`);
        else patch.endTime = endTime(campaign.endDate);
      }
      if (!sameTargeting(live.targeting, desired)) patch.targeting = desired;
      if (Object.keys(patch).length)
        result.operations.push({
          phase: 2,
          kind: 'adGroup',
          action: 'update',
          path,
          target: { id: live.id },
          patch,
          liveDailyBudgetCents: live.dailyBudgetCents,
        });
      await planAds(campaign, group, { id: live.id }, existing?.adsByGroup.get(live.id) ?? [], path);
      if (live.status !== group.status)
        result.operations.push({
          phase: group.status === 'PAUSED' ? 1 : 3,
          kind: 'adGroup',
          action: 'update',
          path,
          target: { id: live.id },
          patch: { status: group.status },
          liveDailyBudgetCents: live.dailyBudgetCents,
        });
    }
    for (const live of existing?.groups ?? [])
      if (!campaign.adGroups.some((group) => group.name === live.name) && isActive(live.status))
        result.operations.push({
          phase: 1,
          kind: 'adGroup',
          action: 'update',
          path: `${campaign.code} / ${live.name} (not in config)`,
          target: { id: live.id },
          patch: { status: 'PAUSED' },
          liveDailyBudgetCents: live.dailyBudgetCents,
        });
  }

  for (const entry of matched) {
    const { config: campaign, live } = entry;
    if (live.objective !== campaign.objective)
      result.blocked.push(`${campaign.code}: live objective ${live.objective} cannot change to ${campaign.objective}`);
    if (live.lifetimeBudget) result.blocked.push(`${campaign.code}: live campaign uses a lifetime budget`);
    const usesCampaignBudget = campaign.dailyBudget !== undefined;
    if (usesCampaignBudget !== (live.dailyBudgetCents !== null))
      result.blocked.push(
        `${campaign.code}: budget level differs from the live campaign; match the config to the live level`,
      );
    const patch: CampaignPatch = {};
    const name = campaignName(config, campaign);
    if (live.name !== name) patch.name = name;
    if (usesCampaignBudget && live.dailyBudgetCents !== toCents(campaign.dailyBudget))
      patch.dailyBudgetCents = toCents(campaign.dailyBudget);
    const desiredStatus = campaign.status as ConfigStatus;
    if (desiredStatus === 'PAUSED' && live.status !== 'PAUSED')
      result.operations.push({
        phase: 1,
        kind: 'campaign',
        action: 'update',
        path: campaign.code,
        target: { id: live.id },
        patch: { status: 'PAUSED' },
        liveDailyBudgetCents: live.dailyBudgetCents,
      });
    if (Object.keys(patch).length)
      result.operations.push({
        phase: 2,
        kind: 'campaign',
        action: 'update',
        path: campaign.code,
        target: { id: live.id },
        patch,
        liveDailyBudgetCents: live.dailyBudgetCents,
      });
    await planGroups(campaign, { id: live.id }, entry);
    if (desiredStatus === 'ACTIVE' && live.status !== 'ACTIVE')
      result.operations.push({
        phase: 3,
        kind: 'campaign',
        action: 'update',
        path: campaign.code,
        target: { id: live.id },
        patch: { status: 'ACTIVE' },
        liveDailyBudgetCents: live.dailyBudgetCents,
      });
  }

  for (const campaign of toCreate) {
    const ref = nextRef('campaign');
    const budgetCents = campaign.dailyBudget === undefined ? null : toCents(campaign.dailyBudget);
    result.operations.push({
      phase: 2,
      kind: 'campaign',
      action: 'create',
      path: campaign.code,
      ref,
      spec: {
        name: campaignName(config, campaign),
        objective: campaign.objective,
        dailyBudgetCents: budgetCents,
        startTime: startTime(campaign.startDate),
        endTime: endTime(campaign.endDate),
      },
    });
    await planGroups(campaign, { ref });
    if (campaign.status === 'ACTIVE')
      result.operations.push({
        phase: 3,
        kind: 'campaign',
        action: 'update',
        path: campaign.code,
        target: { ref },
        patch: { status: 'ACTIVE' },
        liveDailyBudgetCents: budgetCents,
      });
  }

  // Stable sort: pauses first with parents before children (spend stops at the first write), then creates and
  // edits, then activations with children before parents (nothing spends until the campaign switches on last).
  const pauseOrder = { campaign: 0, adGroup: 1, ad: 2, creative: 2 };
  const activationOrder = { ad: 0, creative: 0, adGroup: 1, campaign: 2 };
  const rank = (operation: Operation) =>
    operation.phase === 1 ? pauseOrder[operation.kind] : operation.phase === 3 ? activationOrder[operation.kind] : 0;
  result.operations = result.operations
    .map((operation, index) => ({ operation, index }))
    .sort(
      (left, right) =>
        left.operation.phase - right.operation.phase ||
        rank(left.operation) - rank(right.operation) ||
        left.index - right.index,
    )
    .map(({ operation }) => operation);

  result.blocked.push(...planGuardrails(config, result));
  return result;
}

/** The spend checks that run on the live plan, before any write. */
export function planGuardrails(
  config: PaidSocialConfig,
  plan: Pick<PlanResult, 'operations' | 'liveActiveCents' | 'plannedActiveCents'>,
): string[] {
  const violations: string[] = [];
  const capCents = toCents(config.maxDailyBudgetTotal);
  if (plan.plannedActiveCents > capCents)
    violations.push(
      `Planned active daily budgets ${formatCents(plan.plannedActiveCents)} exceed maxDailyBudgetTotal ${config.maxDailyBudgetTotal}`,
    );
  for (const operation of plan.operations) {
    if (operation.action !== 'update' || (operation.kind !== 'campaign' && operation.kind !== 'adGroup')) continue;
    const desired = operation.patch.dailyBudgetCents;
    if (desired === undefined || desired > capCents) {
      if (desired !== undefined) violations.push(`${operation.path}: daily budget above maxDailyBudgetTotal`);
      continue;
    }
    const live = operation.liveDailyBudgetCents;
    if (!config.allowBudgetJump && live !== null && desired > live * MAX_BUDGET_MULTIPLIER)
      violations.push(
        `${operation.path}: daily budget ${formatCents(live)} -> ${formatCents(desired)} is more than ${MAX_BUDGET_MULTIPLIER}x; set allowBudgetJump in this PR to allow it`,
      );
  }
  if (
    !config.allowBudgetJump &&
    plan.plannedActiveCents > plan.liveActiveCents &&
    plan.plannedActiveCents > plan.liveActiveCents * MAX_BUDGET_MULTIPLIER
  )
    violations.push(
      `Active daily spend ${formatCents(plan.liveActiveCents)} -> ${formatCents(plan.plannedActiveCents)} is more than ${MAX_BUDGET_MULTIPLIER}x (starting spend from zero counts); set allowBudgetJump in this PR to allow it`,
    );
  return violations;
}

// ---------------------------------------------------------------------------
// Execution and reporting

export async function executePlan(client: PaidSocialClient, operations: Operation[]): Promise<void> {
  const created = new Map<string, string>();
  const resolve = (target: Target): string => {
    if ('id' in target) return target.id;
    const createdId = created.get(target.ref);
    if (!createdId) throw new Error(`Internal: ${target.ref} was not created before use`);
    return createdId;
  };
  for (const operation of operations) {
    if (
      'patch' in operation &&
      operation.patch.status !== undefined &&
      !['ACTIVE', 'PAUSED'].includes(operation.patch.status)
    )
      throw new Error('Refusing a status other than ACTIVE or PAUSED');
    switch (operation.kind) {
      case 'campaign':
        if (operation.action === 'create') created.set(operation.ref, await client.createCampaign(operation.spec));
        else await client.updateCampaign(resolve(operation.target), operation.patch);
        break;
      case 'adGroup':
        if (operation.action === 'create')
          created.set(operation.ref, await client.createAdGroup(resolve(operation.parent), operation.spec));
        else await client.updateAdGroup(resolve(operation.target), operation.patch);
        break;
      case 'creative':
        created.set(operation.ref, await client.createCreative(operation.spec));
        break;
      case 'ad':
        if (operation.action === 'create')
          created.set(
            operation.ref,
            await client.createAd(resolve(operation.parent), {
              ...operation.spec,
              creativeId: resolve(operation.creative),
            }),
          );
        else
          await client.updateAd(resolve(operation.target), {
            ...operation.patch,
            ...(operation.creative ? { creativeId: resolve(operation.creative) } : {}),
          });
        break;
    }
  }
}

/** JSON-safe, budget-readable view of an operation. Image bytes never reach the report. */
export function describeOperation(operation: Operation): Row {
  const money = (cents: number | null | undefined) => (typeof cents === 'number' ? formatCents(cents) : cents);
  const base: Row = { kind: operation.kind, action: operation.action, path: operation.path };
  if (operation.kind === 'creative') {
    const { image, ...rest } = operation.spec;
    return { ...base, ref: operation.ref, fields: { ...rest, imageBytes: image.byteLength } };
  }
  if (operation.action === 'create') {
    const spec = operation.spec as unknown as Row;
    return {
      ...base,
      ref: operation.ref,
      status: 'PAUSED',
      fields: {
        ...spec,
        ...('dailyBudgetCents' in spec ? { dailyBudget: money(spec.dailyBudgetCents as number | null) } : {}),
      },
      ...('creative' in operation ? { creative: operation.creative } : {}),
    };
  }
  const patch = operation.patch as unknown as Row;
  return {
    ...base,
    target: operation.target,
    fields: {
      ...patch,
      ...('dailyBudgetCents' in patch ? { dailyBudget: money(patch.dailyBudgetCents as number) } : {}),
    },
    ...('liveDailyBudgetCents' in operation ? { liveDailyBudget: money(operation.liveDailyBudgetCents) } : {}),
    ...('creative' in operation && operation.creative ? { creative: operation.creative } : {}),
  };
}

export interface PaidSocialReport {
  platform: Platform;
  action: 'audit' | 'plan' | 'apply';
  adAccountId: string | null;
  currency: string;
  maxDailyBudgetTotal: string;
  allowBudgetJump: boolean;
  liveActiveDailyBudget?: string;
  plannedActiveDailyBudget: string;
  operations: Row[];
  pending: string[];
  blocked: string[];
  warnings: string[];
  readbackMismatches?: Row[];
  campaigns?: Row[];
}

function reportBase(config: PaidSocialConfig, action: PaidSocialReport['action']): PaidSocialReport {
  return {
    platform: config.platform,
    action,
    adAccountId: config.adAccountId,
    currency: config.currency,
    maxDailyBudgetTotal: config.maxDailyBudgetTotal,
    allowBudgetJump: config.allowBudgetJump,
    plannedActiveDailyBudget: formatCents(plannedActiveCents(config)),
    operations: [],
    pending: [],
    blocked: [],
    warnings: config.allowBudgetJump ? ['allowBudgetJump is on: set it back to false in the next PR'] : [],
  };
}

/** Read-only listing of every campaign in the account, managed or not, so live campaigns can be adopted. */
export async function audit(
  config: PaidSocialConfig,
  client: PaidSocialClient,
  now: () => Date = () => new Date(),
): Promise<PaidSocialReport> {
  const report = reportBase(config, 'audit');
  const today = now().toISOString().slice(0, 10);
  const account = await client.account();
  if (account.id !== config.adAccountId) throw new Error('Ad account id does not match the config');
  // Audit still lists the account so the config can be corrected; plan and apply refuse.
  if (account.currency !== config.currency)
    report.warnings.push(`Account currency is ${account.currency}; set currency in the config to match`);
  const adoptIds = new Set(config.adoptCampaignIds.map((entry) => entry.id));
  report.campaigns = [];
  let liveCents = 0;
  for (const campaign of present(await client.listCampaigns())) {
    const groups = present(await client.listAdGroups(campaign.id));
    const adsByGroup = new Map<string, LiveAd[]>();
    for (const group of groups) adsByGroup.set(group.id, present(await client.listAds(group.id)));
    const managed = isManagedName(config, campaign.name) || adoptIds.has(campaign.id);
    if (managed) liveCents += liveSpendCents(campaign, groups, adsByGroup, today);
    const groupRows: Row[] = [];
    for (const group of groups)
      groupRows.push({
        id: group.id,
        name: group.name,
        status: group.status,
        dailyBudget: group.dailyBudgetCents === null ? null : formatCents(group.dailyBudgetCents),
        lifetimeBudget: group.lifetimeBudget,
        endDate: group.endDate,
        targeting: group.targeting,
        unmanagedTargeting: group.targeting.unmanaged ?? [],
        ads: (adsByGroup.get(group.id) ?? []).map((ad) => ({
          id: ad.id,
          name: ad.name,
          status: ad.status,
          destination: ad.destination,
          creativeId: ad.creativeId,
          creativeName: ad.creativeName,
        })),
      });
    report.campaigns.push({
      id: campaign.id,
      name: campaign.name,
      managed,
      status: campaign.status,
      objective: campaign.objective,
      dailyBudget: campaign.dailyBudgetCents === null ? null : formatCents(campaign.dailyBudgetCents),
      lifetimeBudget: campaign.lifetimeBudget,
      adGroups: groupRows,
    });
  }
  report.liveActiveDailyBudget = formatCents(liveCents);
  return report;
}

export async function reconcile(
  config: PaidSocialConfig,
  client: PaidSocialClient,
  action: 'audit' | 'plan' | 'apply',
  options: PlanOptions,
): Promise<PaidSocialReport> {
  if (client.platform !== config.platform) throw new Error('Client and config platforms differ');
  if (action === 'audit') return audit(config, client, options.now);
  // Re-validate right before planning: the guardrails must hold even if a caller skipped the CLI.
  validateConfig(config, config.platform);
  const report = reportBase(config, action);
  const plan = await buildPlan(config, client, options);
  report.liveActiveDailyBudget = formatCents(plan.liveActiveCents);
  report.operations = plan.operations.map(describeOperation);
  report.pending = plan.pending;
  report.blocked = plan.blocked;
  report.warnings.push(...plan.warnings);
  if (action === 'plan') return report;
  if (plan.blocked.length) throw new Error(`Apply refused before any write:\n- ${plan.blocked.join('\n- ')}`);
  await executePlan(client, plan.operations);
  // Read back: a second plan against the account must find nothing left to do.
  const readback = await buildPlan(config, client, options);
  report.readbackMismatches = readback.operations.map(describeOperation);
  return report;
}

/** What a PR can see without credentials: names, destinations, budgets and totals. */
export async function offlinePlan(config: PaidSocialConfig, readCreativeFile: ReadCreativeFile): Promise<Row> {
  const campaigns: Row[] = [];
  for (const campaign of config.campaigns) {
    const groups: Row[] = [];
    for (const group of campaign.adGroups) {
      const ads: Row[] = [];
      for (const ad of group.ads) {
        const creative = ad.creative;
        let creativeRow: Row = { ...creative };
        if (isFileCreative(creative)) {
          const image = await readCreativeFile(creative.image);
          creativeRow = { ...creative, contentName: fileCreativeName(config, ad, creative, image, campaign) };
        }
        ads.push({
          name: ad.name,
          status: ad.status,
          destination: adDestination(config, campaign, ad),
          ...(config.platform === 'meta' ? { link: PAID_SOCIAL_LANDING, urlTags: metaUrlTags(campaign) } : {}),
          creative: creativeRow,
        });
      }
      groups.push({
        name: group.name,
        status: group.status,
        dailyBudget: group.dailyBudget ?? null,
        targeting: group.targeting,
        ads,
      });
    }
    campaigns.push({
      name: campaignName(config, campaign),
      code: campaign.code,
      status: campaign.status,
      objective: campaign.objective,
      dailyBudget: campaign.dailyBudget ?? null,
      startDate: campaign.startDate,
      endDate: campaign.endDate,
      adopt: config.adoptCampaignIds.find((entry) => entry.code === campaign.code)?.id ?? null,
      adGroups: groups,
    });
  }
  return {
    platform: config.platform,
    action: 'plan',
    offline: true,
    adAccountId: config.adAccountId,
    currency: config.currency,
    maxDailyBudgetTotal: config.maxDailyBudgetTotal,
    plannedActiveDailyBudget: formatCents(plannedActiveCents(config)),
    allowBudgetJump: config.allowBudgetJump,
    campaigns,
  };
}
