/// <reference types="node" />
/** vp exec node --import tsx scripts/posthog/export-growth-dashboard.ts [--fixtures] */
import process from 'node:process';
import { growthDashboard } from './growth-dashboard';
import { growthFixtures } from './growth-fixtures';

process.stdout.write(JSON.stringify(process.argv.includes('--fixtures') ? growthFixtures : growthDashboard, null, 2));
