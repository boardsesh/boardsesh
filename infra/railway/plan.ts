/// <reference types="node" />

// Pure planning logic for the Railway apply tool: diff desired-vs-live and decide
// what may be converged automatically and what may only be reported. No I/O, no
// globals — everything here is deterministic and unit-tested in
// scripts/railway-apply.test.ts. The I/O (fetching live state, applying changes)
// lives in scripts/railway-apply.ts.
//
// Three safety rules are encoded here rather than in the apply layer, so they are
// testable without a live project and cannot be bypassed by a caller:
//
//   1. Never delete. A live service or variable absent from config is reported and
//      left alone, the way the Cloudflare tool preserves foreign rules verbatim.
//   2. Never overwrite a value that is already set and not a placeholder. Only
//      `absent` and `placeholder` are drift this tool will fix.
//   3. Never surface a secret value. Variables are reduced to a three-state
//      classification before they reach a PlannedChange, so no code path can print
//      a DSN or a token.

import {
  PLACEHOLDER_PATTERN,
  type RailwayDesiredState,
  type ServiceDesired,
  type TableRetentionDesired,
} from './config';

/** A service as Railway reports it. */
export interface LiveService {
  id: string;
  name: string;
}

/**
 * Live state for one environment.
 *
 * `variables` maps service name -> variable name -> raw value. The raw values are
 * needed to classify placeholder-vs-set and never leave this module: `classifyVar`
 * is the only thing that reads them, and it returns a state, not a value.
 */
export interface LiveState {
  services: LiveService[];
  variables: Record<string, Record<string, string>>;
  /**
   * Live TTL expressions keyed by table name, as read from ClickHouse's
   * system.tables. `null` means the retention check did not run — no ClickHouse
   * DSN was available to the tool — which is a skip, not a failure.
   */
  clickhouseTtl: Record<string, string> | null;
}

export type VarState = 'set' | 'absent' | 'placeholder';

export interface PlannedChange {
  resource: 'service' | 'env-var' | 'volume' | 'clickhouse-ttl';
  /** One-line human-readable summary of what would change. Never contains a secret value. */
  summary: string;
  /** Optional extra context printed under the summary. */
  detail?: string;
  /** Present for env-var changes so the apply layer can select the right service/variable. */
  target?: { serviceName: string; varName: string };
  /**
   * true = a change that is NOT auto-applied. Creating a stateful service, and
   * anything that would remove live configuration, are reported for a human.
   */
  blocked?: boolean;
}

export interface PlanOptions {
  /**
   * Keys (`"<service>:<VAR>"`) whose value the apply layer actually holds, having
   * found it in its own environment as `RAILWAY_VAR_<VAR>`.
   *
   * This is what separates "drift we can fix" from "drift we can only report".
   * Keeping it a plain set of keys — never the values — is what lets the whole plan
   * layer stay pure and keeps secrets out of every PlannedChange.
   */
  suppliedVars: ReadonlySet<string>;
}

/** The key shape used by PlanOptions.suppliedVars. */
export function varKey(serviceName: string, varName: string): string {
  return `${serviceName}:${varName}`;
}

/**
 * Reduce a raw variable to the only three states this tool distinguishes.
 *
 * A placeholder is treated as absent-with-a-hint rather than as set: it passes a
 * naive "is it defined?" check and then fails at boot, which is the confusing
 * failure this classification exists to prevent.
 */
export function classifyVar(rawValue: string | undefined): VarState {
  if (rawValue === undefined) return 'absent';
  const trimmed = rawValue.trim();
  if (trimmed === '') return 'absent';
  if (PLACEHOLDER_PATTERN.test(trimmed)) return 'placeholder';
  return 'set';
}

/** Find a live service by name. Names are Railway-unique within an environment. */
export function findService(live: LiveState, name: string): LiveService | null {
  return live.services.find((service) => service.name === name) ?? null;
}

/**
 * Diff one declared service's existence.
 *
 * An `assert-only` service that is missing is an error in the config or a renamed
 * service — either way a human question, so it is blocked rather than created.
 */
export function diffService(desired: ServiceDesired, live: LiveState): PlannedChange | null {
  if (findService(live, desired.name)) return null;

  if (desired.management === 'report-only' && desired.expected) {
    return {
      resource: 'service',
      summary: `Service "${desired.name}" does not exist`,
      detail:
        `Create it in Railway with image ${desired.expected.image} and a persistent volume ` +
        `mounted at ${desired.expected.volumeMountPath}, in the same project so private ` +
        `networking reaches it.\n` +
        `Not created automatically: a ClickHouse service without a volume looks healthy and ` +
        `loses every row on redeploy.`,
      blocked: true,
    };
  }

  return {
    resource: 'service',
    summary: `Service "${desired.name}" does not exist`,
    detail:
      `Expected an existing service to assert against. Either it was renamed, or this tool is ` +
      `pointed at the wrong Railway project/environment.`,
    blocked: true,
  };
}

/**
 * Diff the variables one service must carry.
 *
 * Returns nothing for a service that does not exist — diffService already reported
 * that, and repeating it once per variable buries the real message.
 */
export function diffServiceVars(desired: ServiceDesired, live: LiveState, options: PlanOptions): PlannedChange[] {
  if (!findService(live, desired.name)) return [];

  const serviceVars = live.variables[desired.name] ?? {};
  const changes: PlannedChange[] = [];

  for (const required of desired.requiredVars) {
    const state = classifyVar(serviceVars[required.name]);
    if (state === 'set') continue;

    const supplied = options.suppliedVars.has(varKey(desired.name, required.name));

    changes.push({
      resource: 'env-var',
      summary: `${desired.name}: ${required.name} is ${state}`,
      detail:
        `${required.reason}\n` +
        (state === 'placeholder'
          ? 'The variable still holds an unfilled <placeholder> value and will fail at boot.'
          : 'The variable is not set on this service.') +
        `\n` +
        (supplied
          ? `A value is available as RAILWAY_VAR_${required.name}; --apply will set it.`
          : `No value available. Export RAILWAY_VAR_${required.name} to let --apply set it, ` +
            `or set it directly in Railway.`),
      target: { serviceName: desired.name, varName: required.name },
      // Convergeable only when the caller actually supplied a value. Without one
      // this is a report, not a fix — the tool never invents a secret.
      blocked: !supplied,
    });
  }

  return changes;
}

/**
 * Diff one table's retention against the live TTL expression.
 *
 * The comparison is intentionally loose — ClickHouse normalizes a TTL expression
 * when it stores it, so matching the column name and the day count is the honest
 * check. An exact string match would report drift on every server that formats it
 * differently.
 */
export function diffTableRetention(
  desired: TableRetentionDesired,
  liveExpression: string | undefined,
): PlannedChange | null {
  // toDateTime() is not cosmetic: these columns are DateTime64, and ClickHouse
  // rejects a TTL whose result is not Date or DateTime ("TTL expression result
  // column should have DateTime or Date type"). A remediation line that fails
  // when pasted is worse than none, so emit the form that actually runs. On a
  // plain DateTime column the wrapper is a no-op.
  const expected = `toDateTime(${desired.column}) + toIntervalDay(${desired.ttlDays})`;
  const fix = `ALTER TABLE ${desired.table} MODIFY TTL toDateTime(${desired.column}) + INTERVAL ${desired.ttlDays} DAY;`;

  if (liveExpression === undefined || liveExpression.trim() === '') {
    return {
      resource: 'clickhouse-ttl',
      summary: `${desired.table}: no TTL set`,
      detail: `${desired.reason}\n` + `Expected roughly: ${expected}\n` + `Fix: ${fix}`,
      blocked: true,
    };
  }

  const normalized = liveExpression.replace(/\s+/g, '');
  const mentionsColumn = normalized.includes(desired.column);
  const mentionsDays = new RegExp(`toIntervalDay\\(${desired.ttlDays}\\)`).test(normalized);
  if (mentionsColumn && mentionsDays) return null;

  return {
    resource: 'clickhouse-ttl',
    summary: `${desired.table}: TTL is not ${desired.ttlDays} days`,
    detail:
      `Live: ${liveExpression}\n` +
      `Expected roughly: ${expected}\n` +
      `A server upgrade can recreate these tables and drop a TTL we set out of band.\n` +
      `Fix: ${fix}`,
    blocked: true,
  };
}

/**
 * Build the full plan.
 *
 * Order is service existence -> variables -> retention, so the output reads
 * outside-in: a missing service explains its own missing variables, and the
 * retention rows only make sense once ClickHouse exists at all.
 */
export function buildPlan(desired: RailwayDesiredState, live: LiveState, options: PlanOptions): PlannedChange[] {
  const changes: PlannedChange[] = [];

  for (const service of desired.services) {
    const serviceChange = diffService(service, live);
    if (serviceChange) changes.push(serviceChange);
  }

  for (const service of desired.services) {
    changes.push(...diffServiceVars(service, live, options));
  }

  // A null map means the check was skipped for want of a DSN, which must not read
  // as "retention is fine". The apply layer prints the skip separately.
  if (live.clickhouseTtl !== null) {
    for (const table of desired.clickhouseRetention) {
      const change = diffTableRetention(table, live.clickhouseTtl[table.table]);
      if (change) changes.push(change);
    }
  }

  return changes;
}

/**
 * Live services this repo does not declare.
 *
 * Reported so a human can decide, never removed — the Railway project holds
 * Postgres and other services on purpose, and a tool that deleted what it did not
 * recognise would be a catastrophe rather than a convenience.
 */
export function undeclaredServices(desired: RailwayDesiredState, live: LiveState): string[] {
  const declared = new Set(desired.services.map((service) => service.name));
  return live.services.map((service) => service.name).filter((name) => !declared.has(name));
}
