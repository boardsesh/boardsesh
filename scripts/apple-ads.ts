import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { appleAdsClient } from './lib/apple-ads-client';
import { campaignName, groupName, reconcile, row, validateConfig } from './lib/apple-ads';
export async function main(args: string[]) {
  const allowed = new Set(['--action', '--config', '--output', '--offline']);
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (!allowed.has(key) || options.has(key)) throw new Error('Unknown or duplicate Apple Ads argument');
    if (key === '--offline') options.set(key, 'true');
    else {
      const argument = args[++index];
      if (!argument || argument.startsWith('--')) throw new Error('Missing Apple Ads argument');
      options.set(key, argument);
    }
  }
  const action = options.get('--action') ?? 'plan';
  if (!['audit', 'plan', 'apply'].includes(action)) throw new Error('Action must be audit, plan or apply');
  const config = validateConfig(
    JSON.parse(await readFile(resolve(options.get('--config') ?? 'app-stores/apple/ads.json'), 'utf8')),
  );
  const manifest = row(JSON.parse(await readFile(resolve('app-stores/apple/custom-product-pages.json'), 'utf8')));
  const targets = row(manifest.targets);
  const references = Object.fromEntries(
    Object.entries(targets).map(([target, definition]) => [target, String(row(definition).referenceName)]),
  );
  let report: unknown;
  if (options.has('--offline')) {
    if (action !== 'plan') throw new Error('Offline mode supports plan only');
    report = {
      action: 'plan',
      offline: true,
      adAccountId: config.adAccountId,
      appId: config.appId,
      currency: config.currency,
      campaigns: config.campaigns.map((campaign) => ({
        name: campaignName(config, campaign),
        country: campaign.country,
        status: campaign.status,
        dailyBudget: campaign.dailyBudget,
        groups: campaign.groups.map((group) => ({
          name: groupName(group),
          cppReferenceName: references[group.target],
          maxCptBid: group.maxCptBid,
          status: group.status,
          keywords: group.keywords,
          matchType: 'EXACT',
          searchMatch: false,
        })),
      })),
    };
  } else
    report = await reconcile(config, references, await appleAdsClient(config), action as 'audit' | 'plan' | 'apply');
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (options.has('--output')) await writeFile(resolve(options.get('--output')!), serialized);
  process.stdout.write(serialized);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Apple Ads operation failed');
    process.exitCode = 1;
  });
}
