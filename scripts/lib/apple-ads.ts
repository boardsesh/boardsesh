/** Code-owned Apple Ads reconciliation. Remote payloads are validated at the boundary. */
export type Row = Record<string, unknown>;
export type Kind = 'campaigns' | 'adgroups' | 'keywords' | 'creatives' | 'ads' | 'pages' | 'locales' | 'eligibilities';
export interface AdsClient {
  list(kind: Kind, filters?: Row): Promise<Row[]>;
  account(): Promise<Row>;
  create(kind: Kind, payload: Row): Promise<Row>;
  update(kind: Kind, id: string, payload: Row): Promise<Row>;
}
export interface GroupConfig {
  target: string;
  maxCptBid: string;
  status: 'ENABLED' | 'PAUSED';
  keywords: string[];
}
export interface CampaignConfig {
  country: string;
  dailyBudget: string;
  status: 'ENABLED' | 'PAUSED';
  locale: string;
  groups: GroupConfig[];
}
export interface AdsConfig {
  version: number;
  adAccountId: number;
  appId: number;
  currency: string;
  namespace: string;
  legacyCampaignIds: number[];
  campaigns: CampaignConfig[];
}
export function row(input: unknown): Row {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid Apple Ads object');
  return input as Row;
}
export function at(input: unknown, ...keys: string[]): unknown {
  return keys.reduce<unknown>(
    (current, key) => (current && typeof current === 'object' ? (current as Row)[key] : undefined),
    input,
  );
}
export function money(amount: unknown): string {
  if (typeof amount !== 'string' || !/^\d{1,6}(\.\d{1,2})?$/.test(amount) || Number(amount) <= 0)
    throw new Error('Money must be a positive decimal string');
  return Number(amount).toFixed(2);
}
export function validateConfig(input: unknown): AdsConfig {
  const config = row(input) as unknown as AdsConfig;
  if (
    config.version !== 1 ||
    !Number.isSafeInteger(config.adAccountId) ||
    config.adAccountId <= 0 ||
    !Number.isSafeInteger(config.appId) ||
    config.appId <= 0 ||
    !/^[A-Z]{3}$/.test(config.currency) ||
    !/^[A-Za-z][A-Za-z0-9 ]{2,50}$/.test(config.namespace)
  )
    throw new Error('Invalid ads manifest identity');
  if (
    !Array.isArray(config.legacyCampaignIds) ||
    config.legacyCampaignIds.some((identifier) => !Number.isSafeInteger(identifier) || identifier <= 0)
  )
    throw new Error('Invalid legacy campaign IDs');
  if (!Array.isArray(config.campaigns) || config.campaigns.length === 0) throw new Error('No campaigns configured');
  const countries = new Set<string>();
  for (const campaign of config.campaigns) {
    if (
      !/^[A-Z]{2}$/.test(campaign.country) ||
      countries.has(campaign.country) ||
      !['ENABLED', 'PAUSED'].includes(campaign.status) ||
      typeof campaign.locale !== 'string'
    )
      throw new Error('Invalid or duplicate country campaign');
    countries.add(campaign.country);
    money(campaign.dailyBudget);
    if (!Array.isArray(campaign.groups) || !campaign.groups.length) throw new Error('Campaign needs groups');
    const targets = new Set<string>();
    for (const group of campaign.groups) {
      if (
        !['kilter', 'tension', 'moonboard', 'spray'].includes(group.target) ||
        targets.has(group.target) ||
        !['ENABLED', 'PAUSED'].includes(group.status)
      )
        throw new Error('Invalid or duplicate board group');
      targets.add(group.target);
      money(group.maxCptBid);
      if (
        !Array.isArray(group.keywords) ||
        !group.keywords.length ||
        group.keywords.some((term) => typeof term !== 'string' || term !== term.trim() || !term || term.length > 80) ||
        new Set(group.keywords.map((term) => term.toLowerCase())).size !== group.keywords.length
      )
        throw new Error('Invalid or duplicate keywords');
    }
  }
  return config;
}
export function campaignName(config: AdsConfig, campaign: CampaignConfig) {
  return `${config.namespace} ${campaign.country} Search Results`;
}
export function groupName(group: GroupConfig) {
  return `${group.target} Exact`;
}
function identifier(resource: Row): string {
  if (!['string', 'number'].includes(typeof resource.id) || !String(resource.id))
    throw new Error('Apple resource missing identity');
  return String(resource.id);
}
function unique(resources: Row[], name: string): Row | undefined {
  const matches = resources.filter((resource) => resource.name === name && resource.deleted !== true);
  if (matches.length > 1) throw new Error(`Ambiguous Apple resource: ${name}`);
  return matches[0];
}
function subset(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) return JSON.stringify(actual) === JSON.stringify(expected);
  if (expected && typeof expected === 'object')
    return Object.entries(expected).every(([key, entry]) => subset(at(actual, key), entry));
  if (
    typeof actual === 'string' &&
    typeof expected === 'string' &&
    /^\d+(\.\d+)?$/.test(actual) &&
    /^\d+(\.\d+)?$/.test(expected)
  )
    return Number(actual) === Number(expected);
  return actual === expected;
}
function snapshot(resource: Row) {
  return JSON.stringify(resource);
}
export interface AdsReport {
  action: string;
  changes: Row[];
  groups: Row[];
  campaigns: Row[];
  pending: string[];
}
export async function reconcile(
  config: AdsConfig,
  references: Record<string, string>,
  client: AdsClient,
  action: 'audit' | 'plan' | 'apply',
): Promise<AdsReport> {
  const report: AdsReport = { action, changes: [], groups: [], campaigns: [], pending: [] };
  const account = await client.account();
  if (String(account.id) !== String(config.adAccountId) || account.currency !== config.currency)
    throw new Error('Apple Ads account or currency mismatch');
  const inventory = (await client.list('campaigns', { promotedObjectId: String(config.appId) })).filter(
    (resource) => String(resource.promotedObjectId) === String(config.appId) && resource.deleted !== true,
  );
  if (action === 'audit') {
    const creatives = await client.list('creatives');
    for (const campaign of inventory) {
      report.campaigns.push({
        id: campaign.id,
        name: campaign.name,
        status: campaign.status,
        systemStatus: campaign.systemStatus,
        dailyBudget: campaign.dailyBudget,
        managed: !config.legacyCampaignIds.includes(Number(campaign.id)),
      });
      for (const group of await client.list('adgroups', { campaignId: Number(campaign.id) })) {
        const ads = await client.list('ads', { adGroupId: Number(group.id) });
        report.groups.push({
          id: group.id,
          name: group.name,
          campaignId: campaign.id,
          status: group.status,
          systemStatus: group.systemStatus,
          ads: ads.map((ad) => {
            const creative = creatives.find((candidate) => String(candidate.id) === String(ad.creativeId));
            return {
              id: ad.id,
              name: ad.name,
              status: ad.status,
              systemStatus: ad.systemStatus,
              systemStatusReasons: ad.systemStatusReasons,
              creativeType: creative?.creativeType,
              productPageId: at(creative, 'destination', 'parameters', 'productPageId'),
              eligibility: creative?.eligibility,
              fallbackRisk: creative?.creativeType !== 'CUSTOM_PRODUCT_PAGE' || ad.systemStatus !== 'RUNNING',
            };
          }),
        });
      }
    }
    return report;
  }
  const desiredNames = config.campaigns.map((campaign) => campaignName(config, campaign));
  if (
    inventory.some(
      (resource) =>
        !config.legacyCampaignIds.includes(Number(resource.id)) && !desiredNames.includes(String(resource.name)),
    )
  )
    throw new Error('Unexpected app campaign: preserve its configuration as paused or resolve identity before apply');
  const needsContent = config.campaigns.some(
    (campaign) => campaign.status === 'ENABLED' && campaign.groups.some((group) => group.status === 'ENABLED'),
  );
  const pages = needsContent ? await client.list('pages', { adamId: config.appId }) : [];
  const eligibility = needsContent ? await client.list('eligibilities', { adamId: config.appId }) : [];
  const prepared: { campaign: CampaignConfig; existing?: Row; groups: Row[]; pages: Map<string, Row> }[] = [];
  // Complete preflight before the first write.
  for (const campaign of config.campaigns) {
    const existing = unique(inventory, campaignName(config, campaign));
    if (
      existing &&
      (String(existing.adAccountId) !== String(config.adAccountId) ||
        existing.promotedObjectType !== 'APPSTORE_APP' ||
        existing.billingEvent !== 'TAPS' ||
        !subset(existing.targeting, {
          countryOrRegion: { include: [campaign.country] },
          supplyPlacement: { include: ['APPSTORE_SEARCH_RESULTS'] },
        }) ||
        (Array.isArray(existing.sharedBudgets) && existing.sharedBudgets.length > 0) ||
        existing.endTime)
    )
      throw new Error('Managed campaign has incompatible immutable scope or schedule');
    if (existing && config.legacyCampaignIds.includes(Number(existing.id)))
      throw new Error('Managed campaign conflicts with legacy identity');
    const groups = existing
      ? (await client.list('adgroups', { campaignId: Number(existing.id) })).filter(
          (resource) => resource.deleted !== true,
        )
      : [];
    if (groups.some((resource) => !campaign.groups.some((group) => groupName(group) === resource.name)))
      throw new Error('Unexpected ad group: retain a paused configuration entry');
    const mappedPages = new Map<string, Row>();
    if (campaign.status === 'PAUSED') {
      prepared.push({ campaign, existing, groups, pages: mappedPages });
      continue;
    }
    for (const group of campaign.groups) {
      const matchedGroup = unique(groups, groupName(group));
      if (
        matchedGroup &&
        (String(matchedGroup.campaignId) !== String(existing?.id) ||
          matchedGroup.pricingModel !== 'CPT' ||
          matchedGroup.endTime)
      )
        throw new Error('Managed ad group has incompatible scope or schedule');
      if (group.status === 'PAUSED') continue;
      if (matchedGroup) {
        const existingKeywords = await client.list('keywords', { adGroupId: Number(matchedGroup.id) });
        const keywordKeys = existingKeywords
          .filter((keyword) => keyword.deleted !== true)
          .map((keyword) => `${String(keyword.text).toLowerCase()}/${String(keyword.matchType)}`);
        if (new Set(keywordKeys).size !== keywordKeys.length) throw new Error('Duplicate keyword identity');
      }
      const page = unique(
        pages.filter((resource) => resource.state === 'VISIBLE' && Number(resource.adamId) === config.appId),
        references[group.target],
      );
      if (!page) throw new Error(`Missing visible CPP for ${group.target}`);
      const locales = await client.list('locales', { productPageId: identifier(page), languageCode: campaign.locale });
      if (
        !locales.some(
          (locale) =>
            String(locale.productPageId) === identifier(page) &&
            Number(locale.adamId) === config.appId &&
            locale.languageCode === campaign.locale &&
            Array.isArray(locale.deviceClasses) &&
            locale.deviceClasses.includes('IPHONE') &&
            Object.entries(row(locale.assetsByDevice)).some(
              ([device, assets]) =>
                device.startsWith('iphone') &&
                Array.isArray(at(assets, 'assets')) &&
                (at(assets, 'assets') as unknown[]).length > 0,
            ),
        )
      )
        throw new Error(`CPP has no compatible locale for ${campaign.country}/${group.target}`);
      if (
        !eligibility.some(
          (resource) =>
            resource.state === 'ELIGIBLE' &&
            resource.countryOrRegion === campaign.country &&
            resource.supplyPlacement === 'APPSTORE_SEARCH_RESULTS' &&
            resource.supplySource === 'APPSTORE' &&
            resource.deviceClass === 'IPHONE',
        )
      )
        throw new Error(`App is not eligible for Search Results in ${campaign.country}`);
      const expectedCreativeName = `${config.namespace} ${group.target} ${identifier(page)}`;
      const expectedCreative = unique(
        await client.list('creatives', { name: expectedCreativeName }),
        expectedCreativeName,
      );
      if (
        expectedCreative &&
        (expectedCreative.creativeType !== 'CUSTOM_PRODUCT_PAGE' ||
          String(at(expectedCreative, 'destination', 'parameters', 'adamId')) !== String(config.appId) ||
          at(expectedCreative, 'destination', 'parameters', 'productPageId') !== identifier(page))
      )
        throw new Error('Creative identity does not match configured CPP');
      if (matchedGroup) {
        const expectedAdName = `${groupName(group)} ${identifier(page)}`;
        const expectedAd = unique(await client.list('ads', { adGroupId: Number(matchedGroup.id) }), expectedAdName);
        if (
          expectedAd &&
          (!expectedCreative ||
            String(expectedAd.adGroupId) !== String(matchedGroup.id) ||
            String(expectedAd.creativeId) !== String(expectedCreative.id))
        )
          throw new Error('Ad identity does not match configured creative');
      }
      mappedPages.set(group.target, page);
    }
    prepared.push({ campaign, existing, groups, pages: mappedPages });
  }
  async function ensure(kind: Kind, existing: Row | undefined, create: Row, update: Row): Promise<Row> {
    if (existing && subset(existing, update)) return existing;
    report.changes.push({
      kind,
      operation: existing ? 'update' : 'create',
      id: existing?.id,
      name: create.name,
      fields: existing ? update : create,
    });
    if (action !== 'apply') return existing ?? { ...create, id: -1 };
    if (existing) {
      const fresh = (await client.list(kind, { id: existing.id })).find(
        (resource) => String(resource.id) === identifier(existing),
      );
      if (!fresh || snapshot(fresh) !== snapshot(existing)) throw new Error('Concurrent Apple Ads edit; rerun plan');
    }
    // Never retry ambiguous writes. A rerun rediscovers successful creates by immutable name.
    const changed = existing
      ? await client.update(kind, identifier(existing), update)
      : await client.create(kind, create);
    const fresh = (await client.list(kind, { id: changed.id })).find(
      (resource) => String(resource.id) === identifier(changed),
    );
    const expectedFields = Object.fromEntries(
      Object.entries(existing ? update : create).filter(([key]) => key !== 'startTime'),
    );
    if (!fresh || !subset(fresh, expectedFields)) throw new Error('Apple Ads read-back did not confirm mutation');
    return fresh;
  }
  const bidStrategy = (bid?: string) => ({
    bidStrategyType: 'MANUAL_CPT',
    bidStrategyGoal: 'TAP',
    ...(bid ? { bid: { amount: money(bid), currency: config.currency } } : {}),
  });
  for (const entry of prepared) {
    const { campaign } = entry;
    if (campaign.status === 'PAUSED') {
      if (entry.existing) await ensure('campaigns', entry.existing, entry.existing, { status: 'PAUSED' });
      report.campaigns.push({
        id: entry.existing?.id,
        country: campaign.country,
        status: 'PAUSED',
        exists: Boolean(entry.existing),
      });
      continue;
    }
    const campaignFields = {
      dailyBudget: { value: { amount: money(campaign.dailyBudget), currency: config.currency } },
      bidStrategy: bidStrategy(),
      targeting: {
        countryOrRegion: { include: [campaign.country] },
        supplyPlacement: { include: ['APPSTORE_SEARCH_RESULTS'] },
      },
    };
    let remoteCampaign = await ensure(
      'campaigns',
      entry.existing,
      {
        name: campaignName(config, campaign),
        adAccountId: config.adAccountId,
        promotedObjectType: 'APPSTORE_APP',
        promotedObjectId: String(config.appId),
        billingEvent: 'TAPS',
        status: 'PAUSED',
        startTime: new Date().toISOString(),
        ...campaignFields,
      },
      campaignFields,
    );
    for (const group of campaign.groups) {
      if (group.status === 'PAUSED') {
        const existingGroup = unique(entry.groups, groupName(group));
        if (existingGroup) await ensure('adgroups', existingGroup, existingGroup, { status: 'PAUSED' });
        report.groups.push({
          country: campaign.country,
          target: group.target,
          id: existingGroup?.id,
          status: 'PAUSED',
          exists: Boolean(existingGroup),
        });
        continue;
      }
      const page = entry.pages.get(group.target)!;
      const groupFields = {
        bidStrategy: bidStrategy(group.maxCptBid),
        automatedKeywordsOptIn: false,
        targeting: { deviceClass: { include: ['IPHONE'] } },
      };
      let remoteGroup = await ensure(
        'adgroups',
        unique(entry.groups, groupName(group)),
        {
          name: groupName(group),
          campaignId: Number(remoteCampaign.id),
          pricingModel: 'CPT',
          startTime: new Date().toISOString(),
          status: 'PAUSED',
          ...groupFields,
        },
        groupFields,
      );
      const persisted = Number(remoteGroup.id) > 0;
      const keywords = persisted ? await client.list('keywords', { adGroupId: Number(remoteGroup.id) }) : [];
      for (const term of group.keywords) {
        const keyword = keywords.filter(
          (resource) =>
            resource.deleted !== true &&
            String(resource.text).toLowerCase() === term.toLowerCase() &&
            resource.matchType === 'EXACT',
        );
        if (keyword.length > 1) throw new Error('Duplicate keyword identity');
        const fields = { status: group.status, bid: { amount: money(group.maxCptBid), currency: config.currency } };
        await ensure(
          'keywords',
          keyword[0],
          { adGroupId: Number(remoteGroup.id), text: term, matchType: 'EXACT', ...fields },
          fields,
        );
      }
      for (const keyword of keywords.filter(
        (resource) =>
          resource.deleted !== true &&
          (!group.keywords.some((term) => term.toLowerCase() === String(resource.text).toLowerCase()) ||
            resource.matchType !== 'EXACT'),
      ))
        await ensure('keywords', keyword, keyword, { status: 'PAUSED' });
      const creativeName = `${config.namespace} ${group.target} ${identifier(page)}`;
      const creatives = await client.list('creatives', { name: creativeName });
      let creative = await ensure(
        'creatives',
        unique(creatives, creativeName),
        {
          name: creativeName,
          creativeType: 'CUSTOM_PRODUCT_PAGE',
          creativeSpec: {},
          destination: {
            destinationType: 'APP_STORE_PRODUCT_PAGE',
            parameters: { adamId: String(config.appId), productPageId: identifier(page) },
          },
        },
        {},
      );
      if (
        Number(creative.id) > 0 &&
        (creative.creativeType !== 'CUSTOM_PRODUCT_PAGE' ||
          String(at(creative, 'destination', 'parameters', 'adamId')) !== String(config.appId) ||
          at(creative, 'destination', 'parameters', 'productPageId') !== identifier(page))
      )
        throw new Error('Creative identity does not match configured CPP');
      const ads = persisted ? await client.list('ads', { adGroupId: Number(remoteGroup.id) }) : [];
      const adName = `${groupName(group)} ${identifier(page)}`;
      let ad = unique(ads, adName);
      if (ad && (String(ad.adGroupId) !== String(remoteGroup.id) || String(ad.creativeId) !== String(creative.id)))
        throw new Error('Ad identity does not match configured creative');
      const alreadyReady =
        ad &&
        at(creative, 'eligibility', 'status') === 'ELIGIBLE' &&
        creative.systemStatus === 'VALID' &&
        ad.systemStatus === 'RUNNING';
      if (!alreadyReady && remoteGroup.status === 'ENABLED')
        remoteGroup = await ensure('adgroups', remoteGroup, remoteGroup, { status: 'PAUSED' });
      for (const other of ads.filter(
        (resource) => resource.deleted !== true && resource.status === 'ENABLED' && resource.name !== adName,
      ))
        await ensure('ads', other, other, { status: 'PAUSED' });
      ad = await ensure(
        'ads',
        ad,
        { name: adName, adGroupId: Number(remoteGroup.id), creativeId: Number(creative.id), status: group.status },
        { status: group.status },
      );
      if (action === 'apply') {
        const refreshed = unique(await client.list('creatives', { name: creativeName }), creativeName);
        if (!refreshed) throw new Error('Creative disappeared before activation');
        creative = refreshed;
      }
      const ready =
        at(creative, 'eligibility', 'status') === 'ELIGIBLE' &&
        creative.systemStatus === 'VALID' &&
        Array.isArray(ad.systemStatusReasons) &&
        ad.systemStatusReasons.every((reason) => reason === 'PAUSED_BY_USER');
      const desiredStatus = ready ? group.status : 'PAUSED';
      if (!ready) report.pending.push(`${campaign.country}/${group.target}`);
      remoteGroup = await ensure('adgroups', remoteGroup, remoteGroup, { status: desiredStatus });
      report.groups.push({
        country: campaign.country,
        target: group.target,
        id: remoteGroup.id,
        productPageId: page.id,
        status: remoteGroup.status,
        adStatus: ad.status,
        systemStatus: ad.systemStatus,
        systemStatusReasons: ad.systemStatusReasons,
        ready,
        fallbackRisk: !ready || ads.some((resource) => resource.status === 'ENABLED' && resource.name !== adName),
      });
    }
    remoteCampaign = await ensure('campaigns', remoteCampaign, remoteCampaign, { status: campaign.status });
    report.campaigns.push({
      id: remoteCampaign.id,
      country: campaign.country,
      status: remoteCampaign.status,
      dailyBudget: campaign.dailyBudget,
      currency: config.currency,
    });
  }
  return report;
}
