/// <reference types="node" />
/** vp exec node --import tsx scripts/posthog/export-community-dashboard.ts [--fixtures] */
import process from 'node:process';
import { communityFixtures } from './community-fixtures';
import { communityQueries } from './community-queries';

const live = Object.fromEntries(Object.entries(communityQueries).map(([name, build]) => [name, build()]));
process.stdout.write(JSON.stringify(process.argv.includes('--fixtures') ? communityFixtures : live, null, 2));
