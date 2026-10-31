import { join } from 'node:path';
import type { Board, CatalogClimb, QaConfig, Role } from './config';
import { record } from './config';
import type { Backend } from './backend';
import type { Driver } from './drivers';
import type { Fixture, FixtureBoard, FixtureStatus } from './fixture';
import { canonical, Evidence, QaFailure, until } from './evidence';
import { requirePhysicalDelivery, requireSessionIdentity } from './confirmation';

export const SIMULATOR_PEER_UNRUN = [
  'Physical Android BLE holder and board switching',
  'Physical handoff, takeover and superseded-writer cleanup',
  'Android background delivery and notification controls',
  'Suspended iOS cross-device wake and foreground recovery',
] as const;

type Phones = { ios: Driver; android?: Driver };
type FixtureAccess = Pick<Fixture, 'request' | 'start'>;
type BackendAccess = Pick<Backend, 'users' | 'profiles' | 'snapshot' | 'events' | 'session' | 'query'>;
const roles: Role[] = ['ios', 'android'];
const label = (climb: CatalogClimb) => `.*${climb.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*`;

/** Separate foreground-only schedule. The Android participant is an emulator, never a BLE holder. */
export class SimulatorPeerSuite {
  private sessionId = '';
  private runtimes = new Map<Role, string>();
  private leased = false;
  constructor(
    private config: QaConfig,
    private phones: Phones,
    private fixture: FixtureAccess,
    private backend: BackendAccess,
    private boards: Board[],
    private evidence: Evidence,
    private peerEnabled = true,
  ) {}
  private activeRoles(): Role[] {
    return this.peerEnabled ? roles : ['ios'];
  }
  private phone(role: Role): Driver {
    const phone = this.phones[role];
    if (!phone || (role === 'android' && !this.peerEnabled))
      throw new QaFailure('This profile has no enabled simulator peer', 'blocked');
    return phone;
  }
  private user(role: Role): string {
    const user = this.backend.users.get(this.config.phones[role].email);
    if (!user) throw new QaFailure('Expected signed-in QA account is absent', 'blocked');
    return user;
  }
  private device(snapshot: FixtureStatus, board: Board): FixtureBoard {
    const actual = snapshot.boards.find((candidate) => candidate.uuid === board.uuid);
    if (!actual) throw new QaFailure('Configured saved wall is absent from the physical fixture', 'blocked');
    return actual;
  }
  private url(role: Role, path: string): string {
    return `${this.phone(role).phone.scheme}://${path.replace(/^\//, '')}`;
  }
  private async open(role: Role, board: Board, climb: CatalogClimb): Promise<void> {
    await this.phone(role).flow('open-climb', {
      CLIMB_URL: this.url(role, `/b/${board.slug}/${board.angle}/play/${climb.uuid}`),
      CLIMB_LABEL_PATTERN: label(climb),
    });
  }
  private async assertId(role: Role, id: string): Promise<void> {
    await this.phone(role).flow('assert-id', { EXPECTED_ID: id });
  }
  async identity(role: Role): Promise<void> {
    try {
      await this.phone(role).flow('inspect-account', {
        ACCOUNT_URL: this.url(role, '/account'),
        USER_ID: this.user(role),
      });
    } catch (error) {
      if (error instanceof QaFailure && error.kind === 'failed')
        throw new QaFailure(
          'Sign into the configured QA account normally and use a current app with account/runtime selectors',
          'blocked',
        );
      throw error;
    }
    const runtime = (await this.phone(role).hierarchy()).match(/app-runtime-[a-zA-Z0-9_.-]+/)?.[0];
    if (!runtime || (this.runtimes.has(role) && this.runtimes.get(role) !== runtime))
      throw new QaFailure('Launched app runtime is missing or changed during this profile', 'blocked');
    if (role === 'android' && !runtime.startsWith('app-runtime-metro-'))
      throw new QaFailure('Simulator peer must run the inspected normal Metro development client', 'blocked');
    this.runtimes.set(role, runtime);
    this.evidence.event('runtime', { participant: role === 'ios' ? 'physical-holder' : 'simulator-peer', runtime });
  }
  async prepare(): Promise<void> {
    for (const role of this.activeRoles()) await this.identity(role);
    for (const board of this.boards) {
      for (const role of this.activeRoles()) await this.open(role, board, board.catalog[0]);
      this.evidence.event('dwell-start', { boardUuid: board.uuid });
      const finish = Date.now() + 65_000;
      await until(
        async () => Date.now(),
        (now) => now >= finish,
        66_000,
        'real durable-history dwell',
      );
    }
    const before = await this.fixture.request('status', undefined, true);
    if (before.runId || before.boards.some((board) => board.connections))
      throw new QaFailure('Fixture is already connected or leased', 'blocked');
    await this.fixture.start();
    this.leased = true;
  }
  private unrelated(
    before: FixtureStatus,
    after: FixtureStatus,
    board: Board,
    movingFrom?: string,
    released = true,
  ): void {
    for (const configured of this.boards.filter((candidate) => candidate.uuid !== board.uuid)) {
      const initial = this.device(before, configured),
        latest = this.device(after, configured);
      if (configured.uuid === movingFrom) {
        if (
          (released && latest.connections !== 0) ||
          latest.rejected !== initial.rejected ||
          latest.writes - initial.writes > 1 ||
          latest.updates - initial.updates > 1 ||
          (latest.writes > initial.writes && (latest.updates !== initial.updates + 1 || latest.commands.length !== 0))
        )
          throw new QaFailure('Moving boards did not safely release the old physical link');
      } else if (latest.writes !== initial.writes || latest.updates !== initial.updates)
        throw new QaFailure('A send reached an unrelated board');
    }
  }
  private async unchanged(board: Board, action: () => Promise<void>): Promise<void> {
    const before = await this.fixture.request('status');
    const presence = await this.backend.snapshot(board);
    await action();
    const finish = Date.now() + 2000;
    await until(
      async () => {
        const after = await this.fixture.request('status');
        for (const previous of before.boards) {
          const actual = after.boards.find((candidate) => candidate.uuid === previous.uuid);
          if (!actual || actual.writes !== previous.writes || actual.updates !== previous.updates)
            throw new QaFailure('Private preview unexpectedly wrote to the physical fixture');
        }
        return Date.now();
      },
      (now) => now >= finish,
      4000,
      'private preview isolation',
    );
    if (JSON.stringify(presence) !== JSON.stringify(await this.backend.snapshot(board)))
      throw new QaFailure('Private preview changed live presence or durable history');
  }
  private async send(
    role: Role,
    board: Board,
    climb: CatalogClimb,
    flow: string,
    options: { connect?: boolean; movingFrom?: string } = {},
  ): Promise<void> {
    if (role === 'android' && (flow !== 'put' || options.connect || options.movingFrom))
      throw new QaFailure('Simulator peer cannot acquire or move a Bluetooth connection', 'blocked');
    const before = await this.fixture.request('status');
    const previous = this.device(before, board);
    if (role === 'android' && previous.connections !== 1)
      throw new QaFailure('Simulator relay requires the physical iPhone holder', 'blocked');
    const presence = await this.backend.snapshot(board);
    const baselineSeq = Math.max(0, ...presence.recent.map((entry) => entry.seq));
    await this.phone(role).flow(flow);
    if (options.connect)
      await until(
        async () => {
          const snapshot = await this.fixture.request('status');
          if (this.device(snapshot, board).sequence > previous.sequence) return true;
          if ((await this.phones.ios.hierarchy()).includes(`ble-device-${board.uuid}`)) {
            await this.phones.ios.flow('select-device', { BOARD_UUID: board.uuid });
            return true;
          }
          return false;
        },
        Boolean,
        30_000,
        'exact named-board picker or remembered connection',
      );
    const after = await until(
      () => this.fixture.request('status'),
      (snapshot) => {
        const actual = this.device(snapshot, board);
        return (
          actual.sequence > previous.sequence &&
          actual.updates > previous.updates &&
          canonical(actual.commands) === canonical(climb.commands)
        );
      },
      30_000,
      'fresh exact physical delivery',
    );
    const actual = this.device(after, board);
    requirePhysicalDelivery(
      previous,
      actual,
      climb,
      Boolean(options.connect),
      board.family === 'moonboard' && climb.packetBytes > 20,
    );
    this.unrelated(before, after, board, options.movingFrom);
    const eligible = (entry: Awaited<ReturnType<Backend['snapshot']>>['recent'][number]) =>
      entry.seq > baselineSeq &&
      entry.climbUuid === climb.uuid &&
      entry.sentByUserId === this.user('ios') &&
      entry.angle === board.angle &&
      entry.mirrored === false;
    const observed = await until(
      () => this.backend.snapshot(board),
      (snapshot) => snapshot.holder?.userId === this.user('ios') && snapshot.recent.some(eligible),
      30_000,
      'physical holder and climb attribution',
    );
    const entry = observed.recent.find(eligible)!;
    await until(
      async () => this.backend.events,
      (events) =>
        events.some(
          (event) =>
            event.boardUuid === board.uuid &&
            event.event.__typename === 'BoardClimbSet' &&
            record(event.event.climb).seq === entry.seq,
        ),
      30_000,
      'matching live subscription',
    );
    await until(
      () => this.backend.snapshot(board),
      (snapshot) => snapshot.history.some((item) => eligible(item) && item.seq === entry.seq),
      30_000,
      'matching durable history',
    );
    this.evidence.event('confirmed-send', {
      participant: role === 'ios' ? 'physical-holder' : 'simulator-peer',
      writer: 'physical-ios',
      boardUuid: board.uuid,
      climbUuid: climb.uuid,
      backendSeq: entry.seq,
      sequence: actual.sequence,
      connectionGeneration: actual.connectionGeneration,
    });
  }
  private async ensureDriving(board: Board, climb: CatalogClimb): Promise<void> {
    await this.assertId('ios', 'wall-control-.*-self-(idle|driving)');
    if (!/wall-control-[a-z_]+-self-driving/.test(await this.phones.ios.hierarchy())) {
      const before = await this.fixture.request('status');
      await this.phones.ios.flow('drive');
      const after = await until(
        () => this.fixture.request('status'),
        (snapshot) => this.device(snapshot, board).sequence > this.device(before, board).sequence,
        30_000,
        'physical Drive setup',
      );
      requirePhysicalDelivery(this.device(before, board), this.device(after, board), climb, false, false);
      this.unrelated(before, after, board);
      this.evidence.event('physical-drive-setup', {
        boardUuid: board.uuid,
        note: 'Same-climb history may be deduplicated; Next separately requires the full chain.',
      });
    }
    await this.assertId('ios', 'wall-control-.*-self-driving');
  }
  private async disconnect(board: Board): Promise<void> {
    await this.phones.ios.flow('disconnect');
    await until(
      () => this.fixture.request('status'),
      (status) => this.device(status, board).connections === 0,
      30_000,
      'physical disconnect',
    );
    await until(
      () => this.backend.snapshot(board),
      (snapshot) => snapshot.holder === null,
      30_000,
      'holder release',
    );
  }
  private async caseBoundary(): Promise<void> {
    if (this.sessionId || (await this.fixture.request('status')).boards.some((board) => board.connections !== 0))
      throw new QaFailure('Case boundary requires ended QA sessions and zero physical links', 'blocked');
    // A normal Record route must also show no retained session from another run.
    this.evidence.save(
      'inspect-record.yaml',
      'appId: ${APP_ID}\n---\n- openLink: ${RECORD_URL}\n- extendedWaitUntil:\n    visible:\n      id: session-start\n    timeout: 10000\n- assertNotVisible:\n    id: session-active-.+\n',
    );
    try {
      await this.phones.ios.flow(join(this.evidence.directory, 'inspect-record.yaml'), {
        RECORD_URL: this.url('ios', '/record'),
      });
    } catch (error) {
      if (error instanceof QaFailure && error.kind === 'failed')
        throw new QaFailure('Record must show no retained session before the safe case restart', 'blocked');
      throw error;
    }
    if ((await this.fixture.request('status')).boards.some((board) => board.connections !== 0))
      throw new QaFailure('A physical connection appeared before the safe case restart', 'blocked');
    // Public previews push play routes. Bound the native tree only after the
    // real UI/session and physical-link prerequisites have both been checked.
    await this.phones.ios.restart();
    await this.identity('ios');
  }
  async solo(): Promise<void> {
    for (const board of this.boards)
      await this.evidence.scenario(`fallback/solo/${board.family}/physical-ios`, [7023], async () => {
        await this.caseBoundary();
        await this.open('ios', board, board.catalog[0]);
        await this.send('ios', board, board.catalog[0], 'connect', { connect: true });
        await this.unchanged(board, async () => {
          await this.open('ios', board, board.catalog[1]);
          await this.phones.ios.flow('queue-next', {
            CLIMB_ACTIONS_LABEL: 'Climb actions',
            PLAY_NEXT_LABEL: 'Play next',
          });
          await this.phones.ios.flow('return-current', {
            CURRENT_CLIMB_UUID: board.catalog[0].uuid,
            CURRENT_CLIMB_LABEL_PATTERN: label(board.catalog[0]),
          });
        });
        await this.ensureDriving(board, board.catalog[0]);
        await this.send('ios', board, board.catalog[1], 'next');
        await this.assertId('ios', 'wall-control-.*-self-driving');
        await this.phones.ios.screenshot(`fallback-${board.family}-driving`);
        await this.phones.ios.flow('stop-driving');
        await this.unchanged(board, () => this.open('ios', board, board.catalog[2]));
        await this.assertId('ios', 'wall-control-put_on_wall-self-idle');
        await this.phones.ios.screenshot(`fallback-${board.family}-preview-plain`);
        await this.send('ios', board, board.catalog[2], 'put');
        if (this.peerEnabled) {
          await this.unchanged(board, () => this.open('android', board, board.catalog[2]));
          await this.history('android', board, board.catalog[2]);
        }
        await this.disconnect(board);
      });
  }
  async isolation(): Promise<void> {
    for (let index = 0; index < this.boards.length; index++) {
      const source = this.boards[index],
        target = this.boards[(index + 1) % this.boards.length];
      await this.evidence.scenario(
        `fallback/isolation/${source.family}-to-${target.family}/physical-ios`,
        [7001, 7076, 7047],
        async () => {
          await this.caseBoundary();
          await this.open('ios', source, source.catalog[0]);
          await this.send('ios', source, source.catalog[0], 'connect', { connect: true });
          const before = await this.fixture.request('status');
          await this.open('ios', target, target.catalog[0]);
          const afterPreview = await this.fixture.request('status');
          const initialTarget = this.device(before, target),
            previewTarget = this.device(afterPreview, target);
          if (initialTarget.writes !== previewTarget.writes || initialTarget.updates !== previewTarget.updates)
            throw new QaFailure('Foreign preview prematurely wrote to the destination board');
          this.unrelated(before, afterPreview, target, source.uuid, false);
          if ((await this.backend.snapshot(source)).recent.some((entry) => entry.climbUuid === target.catalog[0].uuid))
            throw new QaFailure('Foreign climb was reported on the old saved wall');
          await this.send('ios', target, target.catalog[0], 'put', { connect: true, movingFrom: source.uuid });
          await this.disconnect(target);
        },
      );
    }
  }
  private async roster(count: number): Promise<void> {
    const session = await until(
      () => this.backend.session(this.sessionId),
      (session) => Array.isArray(session?.users) && session.users.length === count,
      30_000,
      `session roster ${count}`,
    );
    const users = (session!.users as unknown[]).map(record);
    for (const role of count === 2 ? roles : (['ios'] as Role[])) {
      const profile = this.backend.profiles.get(this.config.phones[role].email);
      if (!profile) throw new QaFailure('Authenticated profile is absent', 'blocked');
      requireSessionIdentity(users, { userId: this.user(role), ...profile });
      await this.phone(role).flow('open-roster', {
        RECORD_URL: this.url(role, '/record'),
        SESSION_ID: this.sessionId,
        EXPECTED_ROSTER_COUNT: String(count),
        USER_ID: this.user(role),
      });
    }
  }
  private async history(role: Role, board: Board, climb: CatalogClimb): Promise<void> {
    const snapshot = await this.backend.snapshot(board);
    const entry = snapshot.history.find(
      (item) => item.climbUuid === climb.uuid && item.sentByUserId === this.user('ios'),
    );
    if (!entry) throw new QaFailure('Confirmed climb absent from saved wall history');
    const names = {
      kilter: 'Boardsesh QA Kilter Homewall Full',
      tension: 'Boardsesh QA Tension 2 Mirror',
      moonboard: 'Boardsesh QA MoonBoard 2024',
    };
    await this.phone(role).flow('open-history', {
      BOARD_URL: this.url(role, `/b/${board.slug}`),
      BOARD_UUID: board.uuid,
      BOARD_HISTORY_LABEL: `Board history, ${names[board.family]}`,
    });
    await this.assertId(
      role,
      snapshot.recent[0]?.seq === entry.seq
        ? `board-current-${climb.uuid}-${this.user('ios')}`
        : `board-history-${climb.uuid}-${entry.seq}`,
    );
  }
  private async clear(board: Board): Promise<void> {
    const lit = (await this.backend.snapshot(board)).recent[0];
    if (!lit || lit.climbUuid !== board.catalog[1].uuid || lit.sentByUserId !== this.user('ios'))
      throw new QaFailure('Clear requires the freshly confirmed shared climb');
    // Keep the peer's history panel at its top: absence after scrolling could
    // merely mean the current hero moved offscreen.
    await this.assertId('android', `board-current-${lit.climbUuid}-${this.user('ios')}`);
    const before = await this.fixture.request('status');
    const previous = this.device(before, board);
    const eventIndex = this.backend.events.length;
    await this.phones.ios.flow('clear');
    const after = await until(
      () => this.fixture.request('status'),
      (snapshot) => {
        const actual = this.device(snapshot, board);
        return (
          actual.sequence > previous.sequence &&
          actual.updates > previous.updates &&
          actual.writes > previous.writes &&
          actual.commands.length === 0 &&
          actual.connections === 1
        );
      },
      30_000,
      'fresh physical clear',
    );
    requirePhysicalDelivery(previous, this.device(after, board), { ...board.catalog[1], commands: [] }, false, false);
    this.unrelated(before, after, board);
    await until(
      async () => this.backend.events.slice(eventIndex),
      (events) =>
        events.some(
          (entry) =>
            entry.boardUuid === board.uuid &&
            entry.event.__typename === 'BoardClimbCleared' &&
            Number(entry.event.seq) > lit.seq,
        ),
      30_000,
      'shared clear event',
    );
    if ((await this.backend.snapshot(board)).holder?.userId !== this.user('ios'))
      throw new QaFailure('Clear lost the physical iPhone holder');
    await this.assertId('ios', 'wall-control-dark-self-idle');
    await this.phone('android').flow('observe-clear-history', {
      BOARD_UUID: board.uuid,
      CLIMB_UUID: lit.climbUuid,
      WRITER_ID: this.user('ios'),
      HISTORY_SEQ: String(lit.seq),
    });
    await this.unchanged(board, () => this.open('android', board, board.catalog[1]));
    await this.assertId('android', 'wall-control-crew-crew-idle');
  }
  async sessions(): Promise<void> {
    if (!this.peerEnabled) throw new QaFailure('Crew scenarios are unrun in holder-only mode', 'blocked');
    for (const board of this.boards)
      await this.evidence.scenario(
        `fallback/session/${board.family}/simulator-peer`,
        [7013, 7018, 7114, 7019, 7015],
        async () => {
          await this.caseBoundary();
          await this.open('ios', board, board.catalog[0]);
          await this.send('ios', board, board.catalog[0], 'connect', { connect: true });
          await this.phones.ios.flow('start-session', { RECORD_URL: this.url('ios', '/record') });
          this.sessionId = (await this.phones.ios.hierarchy()).match(/session-active-([0-9a-f-]{36})/i)?.[1] ?? '';
          if (!this.sessionId) throw new QaFailure('Real session ID absent after creation');
          const join = () =>
            this.phone('android').flow('join-session', {
              SESSION_URL: this.url('android', `/join/${this.sessionId}`),
              SESSION_ID: this.sessionId,
            });
          await this.unchanged(board, join);
          await this.roster(2);
          const session = await this.backend.session(this.sessionId);
          if (session?.boardPath !== `/b/${board.slug}/${board.angle}`)
            throw new QaFailure('Session lost the exact named saved-wall binding');
          await this.open('android', board, board.catalog[0]);
          await this.assertId('android', 'wall-control-.*-crew-idle');
          await this.history('android', board, board.catalog[0]);
          await this.unchanged(board, () => this.open('android', board, board.catalog[1]));
          await this.send('android', board, board.catalog[1], 'put');
          await this.history('android', board, board.catalog[0]);
          await this.open('ios', board, board.catalog[1]);
          await this.clear(board);
          await this.send('android', board, board.catalog[1], 'put');
          await this.phone('android').flow('leave-session', {
            RECORD_URL: this.url('android', '/record'),
            SESSION_ID: this.sessionId,
            SESSION_EXIT_LABEL: 'Leave session',
          });
          await this.roster(1);
          await this.unchanged(board, join);
          await this.roster(2);
          await this.history('android', board, board.catalog[1]);
          await this.phones.ios.flow('end-session', {
            RECORD_URL: this.url('ios', '/record'),
            SESSION_ID: this.sessionId,
            SESSION_EXIT_LABEL: 'End session',
          });
          const ended = this.sessionId;
          await until(
            () => this.backend.query('query QaEnded($id: ID!) { sessionStatus(sessionId: $id) }', { id: ended }),
            (snapshot) => snapshot.sessionStatus === 'ended',
            30_000,
            'session ended durably',
          );
          this.sessionId = '';
          await this.open('ios', board, board.catalog[1]);
          await this.disconnect(board);
        },
      );
  }
  /** Failure cleanup never restarts a holder with a live link or releases ownership first. */
  async cleanup(): Promise<void> {
    if (!this.leased) return;
    for (const board of this.boards) {
      if (!this.device(await this.fixture.request('status'), board).connections) continue;
      try {
        await this.open('ios', board, board.catalog[0]);
        await this.disconnect(board);
      } catch {
        if (this.device(await this.fixture.request('status'), board).connections) {
          this.evidence.event('cleanup-owned-drop', { boardUuid: board.uuid });
          if (this.device(await this.fixture.request('drop', board.uuid), board).connections !== 0)
            throw new QaFailure('Owned cleanup drop did not release the physical link', 'infrastructure');
        }
      }
    }
    this.evidence.save('recovery.json', {
      retainedSessionId: this.sessionId || null,
      note: this.sessionId ? 'End this QA session normally on its creator iPhone.' : 'No retained QA session.',
    });
  }
  async failureArtifacts(): Promise<void> {
    for (const role of this.activeRoles())
      try {
        this.evidence.save(
          `${role === 'ios' ? 'physical-holder' : 'simulator-peer'}-failure-tree.json`,
          await this.phone(role).hierarchy(),
        );
        await this.phone(role).screenshot(`${role === 'ios' ? 'physical-holder' : 'simulator-peer'}-failure`);
      } catch {
        this.evidence.event('artifact-unavailable', { role });
      }
  }
}
