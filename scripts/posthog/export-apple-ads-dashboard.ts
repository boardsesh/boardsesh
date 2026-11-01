/// <reference types="node" />
/** vp exec node --import tsx scripts/posthog/export-apple-ads-dashboard.ts [--fixtures] */
import process from 'node:process';
import { appleAdsDashboard } from './apple-ads-dashboard';
import { appleAdsFixtures } from './apple-ads-fixtures';

process.stdout.write(
  JSON.stringify(process.argv.includes('--fixtures') ? appleAdsFixtures : appleAdsDashboard, null, 2),
);
