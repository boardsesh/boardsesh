import { appendFileSync, mkdirSync, writeFileSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import type { Led } from './config';

export type Verdict = 'passed' | 'failed' | 'blocked' | 'infrastructure';
let interrupted = false;
export function abortRun(): void {
  interrupted = true;
}
export function requireRunning(): void {
  if (interrupted) throw new QaFailure('QA run interrupted', 'blocked');
}
export class QaFailure extends Error {
  constructor(
    message: string,
    readonly kind: Exclude<Verdict, 'passed'> = 'failed',
  ) {
    super(message);
  }
}
export function canonical(commands: Led[]): string {
  return JSON.stringify(
    [...commands].sort(
      (left, right) => left.position - right.position || left.r - right.r || left.g - right.g || left.b - right.b,
    ),
  );
}
export async function until<T>(
  read: () => Promise<T>,
  matches: (snapshot: T) => boolean,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  do {
    requireRunning();
    const snapshot = await read();
    if (matches(snapshot)) return snapshot;
    if (Date.now() >= deadline) break;
    await new Promise((resume) => setTimeout(resume, 250));
  } while (Date.now() <= deadline);
  throw new QaFailure(`Deadline exceeded: ${label}`);
}
export class Evidence {
  private secrets = new Set<string>();
  readonly results: Array<{ name: string; verdict: Verdict; message?: string; issues: number[] }> = [];
  constructor(readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  secret(secret: string): void {
    if (secret) this.secrets.add(secret);
  }
  redact(candidate: string): string {
    let output = candidate;
    for (const secret of this.secrets) output = output.replaceAll(secret, '[REDACTED]');
    return output.replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [REDACTED]');
  }
  event(kind: string, payload: unknown): void {
    appendFileSync(
      join(this.directory, 'events.jsonl'),
      this.redact(JSON.stringify({ at: new Date().toISOString(), kind, payload })) + '\n',
      { mode: 0o600 },
    );
  }
  save(name: string, payload: unknown): void {
    if (!/^[a-zA-Z0-9_.-]+$/.test(name)) throw new Error('Invalid evidence filename');
    writeFileSync(
      join(this.directory, name),
      this.redact(typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2)) + '\n',
      { mode: 0o600 },
    );
  }
  async scenario(name: string, issues: number[], execute: () => Promise<void>): Promise<void> {
    console.log(`[qa:boards] ${name}`);
    try {
      await execute();
      this.results.push({ name, issues, verdict: 'passed' });
    } catch (error) {
      const message = this.redact(error instanceof Error ? error.message : String(error));
      this.results.push({ name, issues, verdict: error instanceof QaFailure ? error.kind : 'infrastructure', message });
      this.event('scenario-error', { name, message });
      throw error;
    } finally {
      this.save('report.json', { schemaVersion: 1, results: this.results });
    }
  }
}
export function lease(resources: string[]): () => void {
  const owned: string[] = [];
  try {
    for (const resource of [...resources].sort()) {
      const filename = join(
        tmpdir(),
        `boardsesh-board-qa-${createHash('sha256').update(resource).digest('hex').slice(0, 24)}.lock`,
      );
      const descriptor = openSync(filename, 'wx', 0o600);
      owned.push(filename);
      writeFileSync(descriptor, JSON.stringify({ pid: process.pid, resource, startedAt: new Date().toISOString() }));
      closeSync(descriptor);
    }
  } catch {
    for (const filename of owned) unlinkSync(filename);
    throw new QaFailure(
      'Phone or fixture is leased by another run; inspect the lock owner before removing a stale lock',
      'blocked',
    );
  }
  return () => {
    for (const filename of owned) unlinkSync(filename);
  };
}
