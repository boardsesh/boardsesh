import type {
  EwallsApiOptions,
  EwallsBootstrap,
  EwallsChanges,
  EwallsDelta,
  EwallsIdentifiedRecord,
  EwallsRecord,
  EwallsScope,
} from './api-types';

export const EWALLS_API_BASE_URL = 'https://e-walls.eu/api/v1/';
const PAGE_SIZE = 500;
const MAX_PAGES = 50;

type ErrorCode =
  | 'expired'
  | 'authentication'
  | 'http'
  | 'transport'
  | 'aborted'
  | 'timeout'
  | 'limit'
  | 'invalid'
  | 'unstable';

export class EwallsApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly status?: number,
  ) {
    super(`eWalls API request failed (${code})`);
    this.name = 'EwallsApiError';
  }
}

function invalid(): never {
  throw new EwallsApiError('invalid');
}

function record(input: unknown): EwallsRecord {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid();
  return input as EwallsRecord;
}

function nonempty(input: unknown): string {
  if (typeof input !== 'string' || !input.trim()) return invalid();
  return input;
}

function list(input: unknown): unknown[] {
  if (!Array.isArray(input)) return invalid();
  return input;
}

function identified<K extends string>(input: unknown, key: K): EwallsRecord & Readonly<Record<K, string>> {
  const row = record(input);
  nonempty(row[key]);
  return row as EwallsRecord & Readonly<Record<K, string>>;
}

function changes<K extends string>(
  collection: unknown,
  key: K,
  addition: 'changed' | 'added',
  initial: boolean,
): EwallsChanges<EwallsRecord & Readonly<Record<K, string>>> {
  let additions: unknown[];
  let removals: unknown[] = [];
  if (collection === undefined) additions = [];
  else if (Array.isArray(collection)) additions = collection;
  else {
    if (initial) return invalid();
    const group = record(collection);
    if (!(addition in group) && !('deleted' in group)) return invalid();
    additions = group[addition] === undefined ? [] : list(group[addition]);
    removals = group.deleted === undefined ? [] : list(group.deleted);
  }
  const seen = new Set<string>();
  function parseRow(input: unknown) {
    const row = identified(input, key);
    if (seen.has(row[key])) return invalid();
    seen.add(row[key]);
    return row;
  }
  return { upsert: additions.map(parseRow), deleted: removals.map((input) => parseRow(input)[key]) };
}

function account(body: EwallsRecord, initial: boolean): EwallsBootstrap['account'] {
  return {
    ascents: changes(body.ascents, 'id', 'changed', initial),
    favorites: changes(body.favorites, 'routeId', 'added', initial),
    projects: changes(body.projects, 'routeId', 'added', initial),
  };
}

function diodes(body: EwallsRecord) {
  const rows = body.diodes === undefined ? [] : list(body.diodes).map(record);
  return rows.length ? rows : null;
}

function scopeParams(scope: EwallsScope) {
  if (typeof scope.board !== 'string') return invalid();
  return new URLSearchParams({ board: scope.board, forcedType: nonempty(scope.forcedType) });
}

export class EwallsApiClient {
  private readonly fetcher: typeof fetch;
  readonly #token?: string;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly maxTotalBytes: number;
  private readonly includeAccountCollections: boolean;

  constructor(options: EwallsApiOptions = {}) {
    this.fetcher = options.fetch ?? fetch;
    this.#token = options.token;
    this.includeAccountCollections = options.includeAccountCollections ?? true;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 32 * 1024 * 1024;
    this.maxTotalBytes = options.maxTotalBytes ?? 128 * 1024 * 1024;
    if (
      ![this.timeoutMs, this.maxResponseBytes, this.maxTotalBytes].every((n) => Number.isSafeInteger(n) && n > 0) ||
      this.timeoutMs > 2_147_483_647
    )
      invalid();
  }

  private async request(
    path: string,
    init: RequestInit,
    bearer: boolean,
    budget: { remaining: number },
    signal?: AbortSignal,
  ) {
    if (bearer && !this.#token) throw new EwallsApiError('authentication');
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      combined.throwIfAborted();
      const headers = new Headers(init.headers);
      if (bearer) headers.set('Authorization', `Bearer ${this.#token}`);
      const response = await this.fetcher(new URL(path, EWALLS_API_BASE_URL), {
        ...init,
        headers,
        redirect: 'error',
        credentials: 'omit',
        signal: combined,
      });
      const limit = Math.min(this.maxResponseBytes, budget.remaining);
      if (!response.ok || Number(response.headers.get('content-length')) > limit) {
        void response.body?.cancel().catch(() => {});
        if (!response.ok)
          throw new EwallsApiError(
            response.status === 401 ? (bearer ? 'expired' : 'authentication') : 'http',
            response.status,
          );
        throw new EwallsApiError('limit');
      }
      if (!response.body) return invalid();
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          combined.throwIfAborted();
          const chunk = await reader.read();
          combined.throwIfAborted();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > limit) throw new EwallsApiError('limit');
          chunks.push(chunk.value);
        }
      } catch (error) {
        void reader.cancel().catch(() => {});
        throw error;
      } finally {
        reader.releaseLock();
      }
      budget.remaining -= bytes;
      try {
        return record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))));
      } catch {
        return invalid();
      }
    } catch (error) {
      if (signal?.aborted) throw new EwallsApiError('aborted');
      if (timeout.aborted) throw new EwallsApiError('timeout');
      if (error instanceof EwallsApiError) throw error;
      throw new EwallsApiError('transport');
    }
  }

  async login(email: string, password: string, signal?: AbortSignal) {
    const result = await this.request(
      'auth/email/login',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      },
      false,
      { remaining: this.maxTotalBytes },
      signal,
    );
    return { token: nonempty(result.token), user: identified(result.user, 'id') };
  }

  async currentUser(signal?: AbortSignal) {
    return identified(
      await this.request('users/current-user', {}, true, { remaining: this.maxTotalBytes }, signal),
      'id',
    );
  }

  private readAccount(body: EwallsRecord, initial: boolean) {
    return account(this.includeAccountCollections ? body : {}, initial);
  }

  async bootstrap(scope: EwallsScope, signal?: AbortSignal): Promise<EwallsBootstrap> {
    const requestScope = { ...scope };
    const params = scopeParams(requestScope);
    const budget = { remaining: this.maxTotalBytes };
    const routes = new Map<string, EwallsIdentifiedRecord>();
    let first:
      | { checkpoint: string; total: number; diodes: EwallsBootstrap['diodes']; account: EwallsBootstrap['account'] }
      | undefined;
    for (let page = 1; page <= MAX_PAGES; page++) {
      params.set('page', String(page));
      params.set('limit', String(PAGE_SIZE));
      const body = await this.request(`board/routes-delta?${params}`, {}, true, budget, signal);
      const total = body.totalCount;
      if (
        typeof body.initialSync !== 'boolean' ||
        (page === 1 && !body.initialSync) ||
        (body.page !== undefined && body.page !== page) ||
        !Array.isArray(body.routes) ||
        body.routes.length > PAGE_SIZE ||
        typeof body.hasMore !== 'boolean' ||
        typeof total !== 'number' ||
        !Number.isSafeInteger(total) ||
        total < 0 ||
        total > MAX_PAGES * PAGE_SIZE
      )
        return invalid();
      const checkpoint = nonempty(body.timestamp);
      if (!first) first = { checkpoint, total, diodes: diodes(body), account: this.readAccount(body, true) };
      if (first.total !== total || (body.initialSync && first.checkpoint !== checkpoint)) return invalid();
      for (const item of body.routes) {
        const row = identified(item, 'id');
        if (routes.has(row.id)) return invalid();
        routes.set(row.id, row);
      }
      if (!body.hasMore) {
        if (routes.size !== total) return invalid();
        // A route change can shift offset pages without changing the total count.
        const verification = await this.readDeltaBody(requestScope, first.checkpoint, budget, signal);
        nonempty(verification.timestamp);
        const { changed, deleted } = record(verification.routes);
        const changedRoutes = list(changed);
        const deletedRoutes = list(deleted);
        if (changedRoutes.length || deletedRoutes.length) throw new EwallsApiError('unstable');
        return {
          kind: 'bootstrap',
          scope: requestScope,
          baseCheckpoint: null,
          checkpoint: first.checkpoint,
          routes: { upsert: [...routes.values()], deleted: [] },
          diodes: first.diodes,
          account: first.account,
        };
      }
      if (!body.routes.length || routes.size >= total) return invalid();
    }
    throw new EwallsApiError('limit');
  }

  private async readDeltaBody(
    scope: EwallsScope,
    baseCheckpoint: string,
    budget: { remaining: number },
    signal?: AbortSignal,
  ) {
    const params = scopeParams(scope);
    params.set('lastFetch', nonempty(baseCheckpoint));
    const body = await this.request(`board/routes-delta?${params}`, {}, true, budget, signal);
    if (
      (body.initialSync !== undefined && body.initialSync !== false) ||
      (body.hasMore !== undefined && body.hasMore !== false) ||
      body.totalCount !== undefined
    )
      return invalid();
    return body;
  }

  async delta(scope: EwallsScope, baseCheckpoint: string, signal?: AbortSignal): Promise<EwallsDelta> {
    const requestScope = { ...scope };
    const body = await this.readDeltaBody(requestScope, baseCheckpoint, { remaining: this.maxTotalBytes }, signal);
    return {
      kind: 'delta',
      scope: requestScope,
      baseCheckpoint,
      checkpoint: nonempty(body.timestamp),
      routes: changes(body.routes, 'id', 'changed', false),
      account: this.readAccount(body, false),
      diodes: diodes(body),
    };
  }
}
