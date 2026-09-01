#!/usr/bin/env node
import { validateProductionMigrationActivationEnvironment } from './lib/production-migration-activation-contract.mjs';

if (process.argv.length !== 2) {
  console.error('error: production migration activation validation accepts no arguments');
  process.exitCode = 1;
} else {
  try {
    const phase = validateProductionMigrationActivationEnvironment(process.env);
    console.info(`Production migration owner contract validated (${phase}).`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown migration activation validation error';
    console.error(`error: ${message}`);
    process.exitCode = 1;
  }
}
