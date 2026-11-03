/// <reference types="node" />
/** vp exec node --import tsx scripts/posthog/export-paid-social-dashboard.ts [--validation] */
import process from 'node:process';
import { paidSocialDashboard } from './paid-social-dashboard';
import { paidSocialValidationQueries } from './paid-social-validation';

process.stdout.write(
  JSON.stringify(process.argv.includes('--validation') ? paidSocialValidationQueries : paidSocialDashboard, null, 2),
);
