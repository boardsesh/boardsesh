import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { assertLocalOnly, type Environment } from '../../partner-oauth-e2e/server-environment';
import { recordHarnessRetry } from './harness-retries';
import { probe, startProcess, stopProcess, waitUntil, type ManagedProcess } from './processes';
import { WS_HOST, WWW_HOST } from './stack';

/**
 * The backend and www as one unit that can be stopped and started again with a
 * changed environment, while the database, the edge and the browsers stay up.
 * The ports never change, so the edge's upstreams stay valid across a restart.
 */

const BACKEND_READY_MS = 120_000;
/** `next dev` compiles each route on its first request. */
const WEB_READY_MS = 300_000;

export interface ServerSpec {
  name: 'backend' | 'web';
  command: string;
  args: string[];
  cwd: string;
  port: number;
  /** The host header the readiness probe sends, and the page it waits for a 200 on. */
  readyHost: string;
  readyPath: string;
  readyTimeoutMs: number;
  /** The run's own environment for this server. A restart changes it only by what the caller overrides. */
  environment: Environment;
}

/** Names to a value, or to null to unset one. */
export type EnvironmentOverrides = Record<string, string | null>;

/** `env` applies to both servers; `backendEnv` and `webEnv` to one each, after `env`. */
export interface RestartOverrides {
  env?: EnvironmentOverrides;
  backendEnv?: EnvironmentOverrides;
  webEnv?: EnvironmentOverrides;
}

/** Pages www compiles on first use under `next dev`, visited once so no spec pays for it. */
const WARM_PATHS = ['/settings', '/auth/signout', '/api/auth/csrf', '/api/auth/session', '/api/internal/ws-auth'];

export function backendReadiness() {
  return { readyHost: WS_HOST, readyPath: '/health', readyTimeoutMs: BACKEND_READY_MS };
}

export function webReadiness() {
  return { readyHost: WWW_HOST, readyPath: '/auth/login', readyTimeoutMs: WEB_READY_MS };
}

function withOverrides(base: Environment, overrides: EnvironmentOverrides): Environment {
  const merged: Environment = { ...base };
  for (const [name, value] of Object.entries(overrides)) {
    if (value === null) delete merged[name];
    else merged[name] = value;
  }
  return merged;
}

export class ServerSet {
  private running: ManagedProcess[] = [];
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly specs: readonly ServerSpec[],
    private readonly logDirectory: string,
  ) {}

  /** Every process, for a caller that wants to watch for one dying. */
  get processes(): ManagedProcess[] {
    return this.running;
  }

  async start({ env = {}, backendEnv = {}, webEnv = {} }: RestartOverrides = {}): Promise<void> {
    for (const spec of this.specs) {
      // `next dev` keeps a Turbopack cache on disk (turbopackFileSystemCacheForDev, on by default in
      // Next 16) and writes it while it runs. A dev server stopped by a restart can leave it half
      // written, and the next one then answered 404 for routes that exist (/auth/login,
      // /api/auth/session) after its first recompile (run 44314377751). Each dev start begins cold.
      if (spec.name === 'web' && spec.args.includes('dev'))
        rmSync(join(spec.cwd, '.next', 'dev'), { recursive: true, force: true });
    }
    this.running = this.specs.map((spec) => {
      const environment = withOverrides(
        withOverrides(spec.environment, env),
        spec.name === 'backend' ? backendEnv : webEnv,
      );
      // The same guard the first start went through: an override cannot point a server off this machine.
      assertLocalOnly(spec.name, { environment, forcedCredentials: [] });
      return startProcess(spec.name, spec.command, spec.args, spec.cwd, environment, this.logDirectory);
    });
    for (const spec of this.specs) {
      await waitUntil(
        spec.name === 'backend' ? 'the backend' : 'www',
        async () =>
          (await probe(spec.port, spec.readyPath, spec.readyHost, spec.name === 'backend' ? 5_000 : 180_000)) === 200,
        spec.readyTimeoutMs,
        this.running,
      );
    }
    const web = this.specs.find((spec) => spec.name === 'web');
    if (web) for (const path of WARM_PATHS) await probe(web.port, path, WWW_HOST);
  }

  async stop(): Promise<void> {
    const stopping = this.running;
    this.running = [];
    await Promise.all(stopping.map(stopProcess));
  }

  /** For teardown: lets a restart a spec left running finish (each wait is bounded), then stops everything. */
  async shutdown(): Promise<void> {
    await this.queue;
    await this.stop();
  }

  /** Stops both servers and starts them again; one at a time, however many callers ask. */
  restart(overrides: RestartOverrides = {}): Promise<void> {
    const next = this.queue.then(async () => {
      await this.stop();
      try {
        await this.start(overrides);
      } catch (error) {
        // One named infrastructure retry: www not answering in time. Counted; the run fails past two.
        if (!(error instanceof Error) || !/Timed out after \d+ ms waiting for www/.test(error.message)) throw error;
        recordHarnessRetry('restart-www-timeout');
        await this.stop();
        await this.start(overrides);
      }
    });
    this.queue = next.catch(() => undefined);
    return next;
  }
}
