/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  INVENTORY_SERVICES,
  OTA_BASE_URL,
  OTA_FORBIDDEN_VARS,
  OTA_IMAGE,
  OTA_REQUIRED_VARS,
  OTA_SERVICE_NAME,
  desiredRailwayState,
} from '../../infra/railway/config';

/**
 * The declared state and the human runbook describe the same server, and nothing
 * else keeps them in step.
 *
 * `scripts/mobile-ota-setup.ts` prints the env block you paste into Railway when
 * standing up a replacement; `infra/railway/config.ts` is what the apply tool
 * asserts against the live one. If they drift, the runbook quietly tells you to
 * deploy a server the drift check will then complain about — or worse, omits a
 * variable whose absence only shows up at boot.
 */
const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function readRepoFile(relativePath: string): string {
  return readFileSync(join(ROOT_DIR, relativePath), 'utf-8');
}

/** The `NAME=` keys of the env block the setup runbook prints. */
function runbookVariableNames(): string[] {
  const source = readRepoFile('scripts/mobile-ota-setup.ts');
  return [...source.matchAll(/^\s*`([A-Z][A-Z0-9_]*)=/gm)].map(([, name]) => name);
}

describe('the OTA env contract', () => {
  it('declares every variable the setup runbook tells you to paste into Railway', () => {
    const declared = new Set(OTA_REQUIRED_VARS.map((variable) => variable.name));
    const missing = runbookVariableNames().filter((name) => !declared.has(name));

    expect(missing).toEqual([]);
  });

  it('gives every declared variable a reason, so drift explains itself in the plan', () => {
    const unexplained = OTA_REQUIRED_VARS.filter((variable) => variable.reason.trim().length < 20);
    expect(unexplained.map((variable) => variable.name)).toEqual([]);
  });

  it('keeps every secret value out of the repo', () => {
    // A variable carrying a value in config.ts is non-secret BY CONSTRUCTION —
    // that is the property the plan layer relies on when it prints a declared
    // value. So the credential-shaped names must never acquire one.
    const mustStayValueless = [
      'JWT_SECRET',
      'DB_URL',
      'DB_KEYS_MASTER_KEY_B64',
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'ADMIN_PASSWORD',
      'CLICKHOUSE_URL',
    ];

    for (const name of mustStayValueless) {
      const variable = OTA_REQUIRED_VARS.find((candidate) => candidate.name === name);
      expect(variable, `${name} should be declared`).toBeDefined();
      expect(variable?.value, `${name} must not carry a value in the repo`).toBeUndefined();
    }
  });

  it('forbids the variables that would switch xprem off DB-sealed signing keys', () => {
    // The private key that signs every OTA manifest exists only in Postgres,
    // sealed under DB_KEYS_MASTER_KEY_B64. Handing xprem an explicit keypair or a
    // different key-storage mode takes it off that path.
    const forbidden = new Set(OTA_FORBIDDEN_VARS.map((variable) => variable.name));
    for (const name of ['PRIVATE_EXPO_KEY_B64', 'PUBLIC_EXPO_KEY_B64', 'KEYS_STORAGE_TYPE']) {
      expect(forbidden).toContain(name);
    }
  });

  it('never declares a variable as both required and forbidden', () => {
    const required = new Set(OTA_REQUIRED_VARS.map((variable) => variable.name));
    const contradictory = OTA_FORBIDDEN_VARS.filter((variable) => required.has(variable.name));
    expect(contradictory.map((variable) => variable.name)).toEqual([]);
  });
});

describe('the declared services', () => {
  it('points the OTA service at the image the version constants compose', () => {
    const ota = desiredRailwayState.services.find((service) => service.name === OTA_SERVICE_NAME);
    expect(ota?.image).toBe(OTA_IMAGE);
  });

  it('serves the public origin its own BASE_URL names', () => {
    // xprem signs manifests and builds asset URLs against BASE_URL, so a domain
    // that disagrees with it produces manifests pointing at the wrong host.
    const ota = desiredRailwayState.services.find((service) => service.name === OTA_SERVICE_NAME);
    const baseHost = new URL(OTA_BASE_URL).host;
    expect(ota?.domains?.map((domain) => domain.domain)).toContain(baseHost);
  });

  it('gives every inventory service a note saying who does configure it', () => {
    // An inventory entry with no owner is just a way of silencing the undeclared
    // report, which is the opposite of what it is for.
    for (const service of INVENTORY_SERVICES) {
      expect(service.managedBy, `${service.name} needs a managedBy note`).toBeTruthy();
      expect(service.management).toBe('inventory');
    }
  });

  it('asserts nothing about an inventory service', () => {
    for (const service of INVENTORY_SERVICES) {
      expect(service.requiredVars).toEqual([]);
      expect(service.forbiddenVars).toBeUndefined();
      expect(service.image).toBeUndefined();
      expect(service.deploy).toBeUndefined();
    }
  });

  it('accounts for every service live in the project today', () => {
    // Not a rule about Railway — a rule about this file. A service added to the
    // project should either be managed here or listed as inventory; the nightly
    // run reports anything that is neither, and this keeps that report meaningful
    // by making the local list explicit.
    const declared = desiredRailwayState.services.map((service) => service.name);
    for (const name of [
      'boardsesh-ota-v3',
      'boardsesh-ota-clickhouse',
      'Postgres',
      'boardsesh-web',
      'boardsesh-backend',
      'boardsesh-scheduler',
      'PostGIS - PROD',
      'Redis',
    ]) {
      expect(declared).toContain(name);
    }
  });
});
