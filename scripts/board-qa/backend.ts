import WebSocket from 'ws';
import { Kind, parse } from 'graphql';
import { getAuroraBluetoothPacket } from '../../packages/shared/ble-protocol/src/aurora';
import { getMoonboardBluetoothPacket } from '../../packages/shared/ble-protocol/src/moonboard';
import { getLedPlacements } from '../../packages/board-constants/src/led-placements';
import { KEEP_ALIVE_MS } from '../../packages/shared/graphql-client/src/constants';
import { record, string, type Board, type CatalogClimb, type Led, type QaConfig } from './config';
import { canonical, Evidence, QaFailure } from './evidence';

const CLIMB_FIELDS = 'climbUuid name angle mirrored sentByUserId seq sentAt';
export type Presence = {
  climbUuid: string;
  angle: number | null;
  mirrored: boolean | null;
  sentByUserId: string | null;
  seq: number;
  sentAt: string;
};
export type Snapshot = { holder: { userId: string | null } | null; recent: Presence[]; history: Presence[] };
export const QA_QUERIES = {
  profile: 'query QaProfile { profile { id displayName avatarUrl } }',
  board:
    'query QaBoard($slug: String!) { boardBySlug(slug: $slug) { uuid boardId boardType gymUuid layoutId sizeId setIds angle } }',
  climbs:
    'query QaClimbs($input: ClimbSearchInput!) { searchClimbs(input: $input) { climbs { uuid name frames framesCount } } }',
  climb:
    'query QaClimb($boardName: String!, $layoutId: Int!, $sizeId: Int!, $setIds: String!, $angle: Int!, $climbUuid: ID!) { climb(boardName: $boardName, layoutId: $layoutId, sizeId: $sizeId, setIds: $setIds, angle: $angle, climbUuid: $climbUuid) { uuid name frames framesCount } }',
  wall: `query QaWall($boardId: Int!, $boardUuid: ID!) {
    holder: boardConnection(boardId: $boardId, boardUuid: $boardUuid) { userId }
    recent: boardRecentClimbs(boardId: $boardId, boardUuid: $boardUuid) { ${CLIMB_FIELDS} }
    durable: boardHistoryPage(boardId: $boardId, boardUuid: $boardUuid, limit: 100) { entries { ${CLIMB_FIELDS} } }
  }`,
  session:
    'query QaSession($id: ID!) { session(sessionId: $id) { id boardPath users { userId username avatarUrl connectionState } } sessionStatus(sessionId: $id) }',
} as const;
export const QA_SUBSCRIPTION = `subscription QaWallEvents($boardId: Int!, $boardUuid: ID!) {
  boardNowPlaying(boardId: $boardId, boardUuid: $boardUuid) {
    __typename
    ... on BoardClimbSet { climb { ${CLIMB_FIELDS} } }
    ... on BoardConnectionChanged { seq holder { userId } }
    ... on BoardClimbCleared { seq climbUuid clearedAt }
    ... on BoardHistoryUpdated { seq }
  }
}`;

export function requireReadOnlyQuery(query: string): void {
  const operations = parse(query).definitions.filter((definition) => definition.kind === Kind.OPERATION_DEFINITION);
  if (operations.length !== 1 || operations[0].operation !== 'query')
    throw new Error('QA observers require exactly one query, never a mutation');
}

// Independent wire decoder: golden tests pin manufacturer positions and RGB
// quantization, rather than comparing the app encoder with its own output.
export function decodePacket(packet: Uint8Array, moonboard: boolean): Led[] {
  if (!packet.length) throw new Error('Empty transport payload is not a clear');
  if (moonboard) {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(packet);
    if (!/^l#(?:[SPE]\d+(?:,[SPE]\d+)*)?#$/.test(text)) throw new Error('Expected plain static MoonBoard packet');
    const colors = { S: [0, 255, 0], P: [0, 0, 255], E: [255, 0, 0] };
    const commands = [...text.matchAll(/([SPE])(\d+)/g)].map((match) => {
      const position = Number(match[2]);
      if (!Number.isSafeInteger(position) || position >= 198)
        throw new Error('MoonBoard position outside Standard geometry');
      const color = colors[match[1] as keyof typeof colors];
      return { position, r: color[0], g: color[1], b: color[2] };
    });
    if (commands.length > 198) throw new Error('MoonBoard payload exceeds Standard geometry');
    return commands;
  }
  const commands: Led[] = [];
  let multipart = false;
  let completed = false;
  for (let offset = 0; offset < packet.length;) {
    const size = packet[offset + 1];
    const command = packet[offset + 4];
    if (
      completed ||
      size < 1 ||
      offset + size + 5 > packet.length ||
      packet[offset] !== 1 ||
      packet[offset + 3] !== 2 ||
      packet[offset + size + 4] !== 3 ||
      ![81, 82, 83, 84].includes(command)
    )
      throw new Error('Expected one complete Aurora v3 update');
    let sum = 0;
    for (let index = offset + 4; index < offset + 4 + size; index++) sum = (sum + packet[index]) & 255;
    if ((sum ^ 255) !== packet[offset + 2] || (size - 1) % 3 !== 0) throw new Error('Invalid Aurora payload');
    if (command === 82 || command === 84) {
      if (offset !== 0) throw new Error('Aurora update restarted before completion');
      multipart = command === 82;
    } else if (!multipart) throw new Error('Aurora continuation has no first frame');
    completed = command === 83 || command === 84;
    for (let index = offset + 5; index < offset + size + 4; index += 3) {
      const color = packet[index + 2];
      commands.push({
        position: packet[index] | (packet[index + 1] << 8),
        r: ((color >> 5) & 7) * 36,
        g: ((color >> 2) & 7) * 36,
        b: (color & 3) * 85,
      });
    }
    if (commands.length > 1024) throw new Error('Aurora update exceeds fixture capacity');
    offset += size + 5;
  }
  if (!completed) throw new Error('Aurora update is incomplete');
  return commands;
}

export function requireStaticFrames(frames: string, framesCount: unknown): void {
  if ((framesCount != null && framesCount !== 1) || !/^(?:p[0-9]+r[0-9]+)+$/.test(frames))
    throw new QaFailure('Fixture requires one complete static climb frame', 'blocked');
}

function finiteInteger(candidate: unknown, label: string, minimum = 0): number {
  if (typeof candidate !== 'number' || !Number.isSafeInteger(candidate) || candidate < minimum)
    throw new QaFailure(`Invalid backend ${label}`, 'infrastructure');
  return candidate;
}
export function parseSnapshot(candidate: unknown): Snapshot {
  const result = record(candidate);
  const parsePresence = (entries: unknown): Presence[] => {
    if (!Array.isArray(entries)) throw new QaFailure('Invalid backend presence list', 'infrastructure');
    return entries.map((entry) => {
      const presence = record(entry);
      if (presence.mirrored !== null && typeof presence.mirrored !== 'boolean')
        throw new QaFailure('Invalid mirrored state', 'infrastructure');
      if (presence.sentByUserId !== null && typeof presence.sentByUserId !== 'string')
        throw new QaFailure('Invalid sender identity', 'infrastructure');
      return {
        climbUuid: string(presence.climbUuid),
        angle: presence.angle === null ? null : finiteInteger(presence.angle, 'angle'),
        mirrored: presence.mirrored,
        sentByUserId: presence.sentByUserId,
        seq: finiteInteger(presence.seq, 'sequence', 1),
        sentAt: string(presence.sentAt),
      };
    });
  };
  const holder = result.holder === null ? null : record(result.holder);
  if (holder && holder.userId !== null && typeof holder.userId !== 'string')
    throw new QaFailure('Invalid holder identity', 'infrastructure');
  return {
    holder: holder ? { userId: holder.userId as string | null } : null,
    recent: parsePresence(result.recent),
    history: parsePresence(record(result.durable).entries),
  };
}
export class Backend {
  readonly users = new Map<string, string>();
  readonly profiles = new Map<string, { displayName: string; avatarUrl: string | null }>();
  private tokens = new Map<string, string>();
  private socket?: WebSocket;
  private socketError?: Error;
  private ack?: () => void;
  private cancelObserverAck?: () => void;
  private observerKeepalive?: ReturnType<typeof setInterval>;
  private observerPongDeadline?: ReturnType<typeof setTimeout>;
  private observerClosing = false;
  readonly events: Array<{ boardUuid: string; event: Record<string, unknown> }> = [];
  constructor(
    private config: QaConfig,
    private evidence: Evidence,
  ) {}
  async signIn(email: string, password: string): Promise<void> {
    this.evidence.secret(password);
    const response = await fetch(new URL('/auth/native/credentials', this.config.backendUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new QaFailure(`Test account authentication rejected (HTTP ${response.status})`, 'blocked');
    const token = string(record(await response.json()).jwt);
    this.evidence.secret(token);
    this.tokens.set(email, token);
    const profile = record((await this.query(QA_QUERIES.profile, {}, email)).profile);
    this.users.set(email, string(profile.id));
    this.profiles.set(email, {
      displayName: typeof profile.displayName === 'string' && profile.displayName ? profile.displayName : email,
      avatarUrl: typeof profile.avatarUrl === 'string' ? profile.avatarUrl : null,
    });
  }
  async query(
    query: string,
    variables: Record<string, unknown> = {},
    email = this.config.phones.ios.email,
  ): Promise<Record<string, unknown>> {
    requireReadOnlyQuery(query);
    const response = await fetch(this.config.backendUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${this.tokens.get(email) ?? ''}` },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new QaFailure(`Backend observer HTTP ${response.status}`, 'infrastructure');
    const payload = record(await response.json());
    if (payload.errors)
      throw new QaFailure(
        'Backend observer GraphQL request rejected; verify deployed schema and account access',
        'infrastructure',
      );
    return record(payload.data);
  }
  async catalog(): Promise<Board[]> {
    const boards: Board[] = [];
    for (const fixture of this.config.boards) {
      const selected = record((await this.query(QA_QUERIES.board, { slug: fixture.slug })).boardBySlug);
      if (selected.gymUuid !== 'ef8b823e-8d2e-4840-8218-761369f9c059' || selected.boardType !== fixture.family)
        throw new QaFailure('Fixture slug does not belong to the approved QA gym', 'blocked');
      const board: Board = {
        ...fixture,
        uuid: string(selected.uuid),
        boardId: finiteInteger(selected.boardId, 'board ID', 1),
        layoutId: finiteInteger(selected.layoutId, 'layout ID', 1),
        sizeId: finiteInteger(selected.sizeId, 'size ID', 1),
        setIds: string(selected.setIds),
        angle: finiteInteger(selected.angle, 'angle'),
        catalog: [],
      };
      if (fixture.family === 'moonboard' && (board.layoutId !== 3 || board.sizeId !== 1))
        throw new QaFailure('MoonBoard QA oracle requires the approved 2024 Standard geometry', 'blocked');
      for (const configuredClimb of fixture.climbs) {
        const name = typeof configuredClimb === 'string' ? configuredClimb : configuredClimb.name;
        const expectedUuid = typeof configuredClimb === 'string' ? undefined : configuredClimb.uuid;
        const configuration = {
          boardName: fixture.family,
          layoutId: board.layoutId,
          sizeId: board.sizeId,
          setIds: board.setIds,
          angle: board.angle,
        };
        let candidates: unknown[];
        if (expectedUuid) {
          const response = await this.query(QA_QUERIES.climb, { ...configuration, climbUuid: expectedUuid });
          candidates = response.climb ? [response.climb] : [];
        } else {
          const search = record(
            (await this.query(QA_QUERIES.climbs, { input: { ...configuration, name, pageSize: 50 } })).searchClimbs,
          );
          if (!Array.isArray(search.climbs)) throw new Error('Invalid climb search');
          candidates = search.climbs;
        }
        const matches = candidates
          .map(record)
          .filter(
            (candidate) =>
              (expectedUuid === undefined || candidate.uuid === expectedUuid) &&
              String(candidate.name).toLowerCase().replace(/\s/g, '') === name.toLowerCase().replace(/\s/g, '') &&
              Number(candidate.framesCount ?? 1) === 1,
          );
        if (matches.length > 1) throw new QaFailure(`Ambiguous fixture climb name: ${name}`, 'blocked');
        const climb = matches[0];
        if (!climb) throw new QaFailure(`Pinned static fixture climb missing: ${fixture.family}/${name}`, 'blocked');
        const frames = string(climb.frames);
        requireStaticFrames(frames, climb.framesCount);
        const result =
          fixture.family === 'moonboard'
            ? getMoonboardBluetoothPacket(frames)
            : getAuroraBluetoothPacket(
                frames,
                getLedPlacements(fixture.family, board.layoutId, board.sizeId),
                fixture.family,
                3,
              );
        if (
          result.skippedPositionCount ||
          ('skippedRoleCount' in result && result.skippedRoleCount) ||
          !result.packet.length
        )
          throw new QaFailure(`Fixture climb has incompatible holds: ${name}`, 'blocked');
        const catalog: CatalogClimb = {
          uuid: string(climb.uuid),
          name: string(climb.name),
          frames,
          commands: decodePacket(result.packet, fixture.family === 'moonboard'),
          packetBytes: result.packet.length,
        };
        if (!catalog.commands.length) throw new QaFailure('Fixture climb encoded no LEDs', 'blocked');
        board.catalog.push(catalog);
      }
      if (new Set(board.catalog.map((climb) => canonical(climb.commands))).size !== board.catalog.length)
        throw new Error('Fixture climbs need distinct physical patterns');
      boards.push(board);
    }
    this.evidence.save('catalog.json', boards);
    return boards;
  }
  async snapshot(board: Board): Promise<Snapshot> {
    this.requireHealthyObserver();
    const result = await this.query(QA_QUERIES.wall, { boardId: board.boardId, boardUuid: board.uuid });
    this.requireHealthyObserver();
    return parseSnapshot(result);
  }
  async observe(boards: Board[]): Promise<void> {
    if (this.socket)
      throw new QaFailure('Board observer already opened; reconnect would hide an evidence gap', 'infrastructure');
    const url = new URL(this.config.backendUrl);
    url.protocol = 'wss:';
    // Match the app client's read-only protocol keepalive. Native control-frame
    // pong is also required by setup.ts/useServer and remains ws-managed.
    const socket = new WebSocket(url, 'graphql-transport-ws', { autoPong: true });
    this.socket = socket;
    const startedAt = Date.now();
    let acknowledgedAt: number | undefined;
    let lastMessageAt: number | undefined;
    let lastNativePingAt: number | undefined;
    let lastNativePongAt: number | undefined;
    let lastProtocolPongAt: number | undefined;
    let heartbeatSequence = 0;
    let pendingHeartbeat: number | undefined;
    let nextHeartbeatAt = 0;
    const lifecycle = (state: string, details: Record<string, unknown> = {}) => {
      const now = Date.now();
      this.evidence.event('board-observer', {
        state,
        elapsedMs: now - startedAt,
        acknowledgedAgoMs: acknowledgedAt === undefined ? null : now - acknowledgedAt,
        lastMessageAgoMs: lastMessageAt === undefined ? null : now - lastMessageAt,
        lastNativePingAgoMs: lastNativePingAt === undefined ? null : now - lastNativePingAt,
        lastNativePongAgoMs: lastNativePongAt === undefined ? null : now - lastNativePongAt,
        lastProtocolPongAgoMs: lastProtocolPongAt === undefined ? null : now - lastProtocolPongAt,
        ...details,
      });
    };
    lifecycle('connecting', {
      boardUuids: boards.map((board) => board.uuid),
      protocolKeepaliveMs: KEEP_ALIVE_MS,
      autoPong: true,
    });
    socket.on('ping', () => {
      lastNativePingAt = Date.now();
      lifecycle('native-ping-received');
    });
    socket.on('pong', () => {
      lastNativePongAt = Date.now();
      lifecycle('native-pong-received');
    });
    socket.on('message', (raw) => {
      try {
        const bytes = Array.isArray(raw)
          ? Buffer.concat(raw)
          : Buffer.from(raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw);
        const message = record(JSON.parse(bytes.toString('utf8')));
        lastMessageAt = Date.now();
        if (message.type === 'connection_ack') this.ack?.();
        else if (message.type === 'ping') {
          lifecycle('protocol-ping-received');
          socket.send(
            JSON.stringify({ type: 'pong', ...(message.payload === undefined ? {} : { payload: message.payload }) }),
          );
        } else if (message.type === 'pong') {
          lastProtocolPongAt = Date.now();
          const payload = message.payload === undefined ? {} : record(message.payload);
          const matched = pendingHeartbeat !== undefined && payload.qaSequence === pendingHeartbeat;
          if (matched) {
            pendingHeartbeat = undefined;
            if (this.observerPongDeadline) clearTimeout(this.observerPongDeadline);
            this.observerPongDeadline = undefined;
          }
          lifecycle('protocol-pong-received', { matched });
        } else if (message.type === 'next') {
          const payload = record(message.payload);
          if (payload.errors) throw new Error('Board subscription rejected');
          if (!boards.some((board) => board.uuid === message.id))
            throw new Error('Unexpected board subscription identity');
          const event = record(record(payload.data).boardNowPlaying);
          if (
            ![
              'BoardClimbSet',
              'BoardConnectionChanged',
              'BoardClimbCleared',
              'BoardHistoryUpdated',
              'BoardStatsUpdated',
            ].includes(string(event.__typename))
          )
            throw new Error('Unknown board event');
          this.events.push({ boardUuid: string(message.id), event });
          this.evidence.event('board-subscription', { boardUuid: message.id, event });
        } else if (message.type === 'error' || message.type === 'complete')
          throw new Error('Board subscription ended unexpectedly');
      } catch {
        this.socketError ??= new Error('Invalid or rejected board subscription evidence');
        lifecycle('protocol-failure');
        this.clearObserverTimers();
      }
    });
    await new Promise<void>((resolveAck, reject) => {
      const timer = setTimeout(() => {
        this.ack = undefined;
        this.cancelObserverAck = undefined;
        this.socketError ??= new Error('Observer connection acknowledgement timed out');
        lifecycle('acknowledgement-timeout');
        reject(new QaFailure(this.socketError.message, 'infrastructure'));
      }, 20_000);
      this.cancelObserverAck = () => {
        clearTimeout(timer);
        this.ack = undefined;
        reject(new QaFailure('Board observer closed before acknowledgement', 'infrastructure'));
      };
      this.ack = () => {
        if (this.observerClosing) {
          this.cancelObserverAck?.();
          return;
        }
        clearTimeout(timer);
        this.ack = undefined;
        this.cancelObserverAck = undefined;
        acknowledgedAt = Date.now();
        lifecycle('acknowledged');
        nextHeartbeatAt = Date.now() + KEEP_ALIVE_MS;
        this.observerKeepalive = setInterval(() => {
          const lagMs = Math.max(0, Date.now() - nextHeartbeatAt);
          nextHeartbeatAt = Date.now() + KEEP_ALIVE_MS;
          if (socket.readyState !== WebSocket.OPEN || pendingHeartbeat !== undefined) return;
          pendingHeartbeat = ++heartbeatSequence;
          lifecycle('protocol-ping-sent', { sequence: pendingHeartbeat, eventLoopLagMs: lagMs });
          this.observerPongDeadline = setTimeout(() => {
            this.socketError ??= new Error('Board observer protocol heartbeat response timed out');
            lifecycle('protocol-pong-timeout', { sequence: pendingHeartbeat });
            this.clearObserverTimers();
            socket.close(1000, 'QA observer heartbeat timeout');
          }, 20_000);
          socket.send(JSON.stringify({ type: 'ping', payload: { qaSequence: pendingHeartbeat } }));
        }, KEEP_ALIVE_MS);
        resolveAck();
      };
      socket.on('error', (error) => {
        clearTimeout(timer);
        this.ack = undefined;
        this.cancelObserverAck = undefined;
        this.socketError ??= new Error('Board observer socket failed');
        this.clearObserverTimers();
        lifecycle('error', { message: this.evidence.redact(error.message).slice(0, 512) });
        reject(new QaFailure('Board observer socket failed', 'infrastructure'));
      });
      socket.on('close', (code, reason) => {
        clearTimeout(timer);
        this.ack = undefined;
        this.cancelObserverAck = undefined;
        this.clearObserverTimers();
        const description = this.evidence.redact(reason.toString('utf8')).slice(0, 256);
        lifecycle('closed', { code, reason: description, requestedByRunner: this.observerClosing });
        if (!this.observerClosing) {
          this.socketError ??= new Error(
            `Board observer socket closed (code ${code}, reason ${description || 'none'})`,
          );
          reject(new QaFailure(this.socketError.message, 'infrastructure'));
        }
      });
      socket.on('open', () => {
        lifecycle('opened');
        socket.send(
          JSON.stringify({
            type: 'connection_init',
            payload: {
              authToken: this.tokens.get(this.config.phones.ios.email),
              clientIdentity: 'boardsesh-local-qa-observer',
            },
          }),
        );
      });
    });
    for (const board of boards)
      socket.send(
        JSON.stringify({
          id: board.uuid,
          type: 'subscribe',
          payload: { query: QA_SUBSCRIPTION, variables: { boardId: board.boardId, boardUuid: board.uuid } },
        }),
      );
    lifecycle('subscribed', { boardUuids: boards.map((board) => board.uuid) });
  }
  async session(id: string): Promise<Record<string, unknown> | null> {
    return (await this.query(QA_QUERIES.session, { id })).session as Record<string, unknown> | null;
  }
  close(): void {
    this.observerClosing = true;
    this.cancelObserverAck?.();
    this.cancelObserverAck = undefined;
    this.ack = undefined;
    this.clearObserverTimers();
    this.socket?.close(1000, 'QA observer finished');
  }
  private clearObserverTimers(): void {
    if (this.observerKeepalive) clearInterval(this.observerKeepalive);
    if (this.observerPongDeadline) clearTimeout(this.observerPongDeadline);
    this.observerKeepalive = undefined;
    this.observerPongDeadline = undefined;
  }
  private requireHealthyObserver(): void {
    if (this.socketError) throw new QaFailure(this.socketError.message, 'infrastructure');
  }
}
