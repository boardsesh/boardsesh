import { join } from 'node:path';
import type { Board, CatalogClimb, QaConfig, Role } from './config';
import { record, string } from './config';
import { Backend, type Snapshot } from './backend';
import type { Driver } from './drivers';
import { Fixture, type FixtureBoard, type FixtureStatus } from './fixture';
import { canonical, Evidence, QaFailure, until } from './evidence';
import { notificationPrevious } from './notifications';
import { requirePhysicalDelivery, requireSessionIdentity, requireTakeoverBaseline } from './confirmation';

const ROLES: Role[] = ['ios', 'android'];
export const QA_SESSION_QUEUE_QUERY = `query QaSessionQueue($id: ID!) {
  session(sessionId: $id) {
    queueState { queue { uuid climb { uuid } } currentClimbQueueItem { uuid climb { uuid } } }
  }
}`;
export type QaQueueSnapshot = {
  queue: Array<{ uuid: string; climb: { uuid: string } }>;
  currentClimbQueueItem: { uuid: string; climb: { uuid: string } } | null;
};
export function previousQueueWitness(
  before: QaQueueSnapshot,
  after: QaQueueSnapshot,
  currentClimbUuid: string,
  previousClimbUuid: string,
): { currentSlotUuid: string; previousSlotUuid: string } | null {
  const current = after.currentClimbQueueItem;
  if (!current || current.climb.uuid !== currentClimbUuid || before.queue.some((item) => item.uuid === current.uuid))
    return null;
  const currentSlots = after.queue.filter((item) => item.uuid === current.uuid);
  if (currentSlots.length !== 1 || currentSlots[0].climb.uuid !== currentClimbUuid) return null;
  const currentIndex = after.queue.findIndex((item) => item.uuid === current.uuid);
  const previous = after.queue[currentIndex - 1];
  if (
    !previous ||
    previous.climb.uuid !== previousClimbUuid ||
    after.queue.filter((item) => item.uuid === previous.uuid).length !== 1
  )
    return null;
  return { currentSlotUuid: current.uuid, previousSlotUuid: previous.uuid };
}

function climbLabelPattern(climb: CatalogClimb): string {
  return `.*${climb.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*`;
}
export class Suite {
  private identities = new Map<Role, string>();
  private sessionId = '';
  constructor(
    private config: QaConfig,
    private phones: Record<Role, Driver>,
    private fixture: Fixture,
    private backend: Backend,
    private boards: Board[],
    private evidence: Evidence,
  ) {}
  private user(role: Role): string {
    const id = this.backend.users.get(this.config.phones[role].email);
    if (!id) throw new Error('Account not authenticated');
    return id;
  }
  private url(role: Role, path: string): string {
    return `${this.phones[role].phone.scheme}://${path.replace(/^\//, '')}`;
  }
  private device(snapshot: FixtureStatus, board: Board): FixtureBoard {
    const device = snapshot.boards.find((candidate) => candidate.uuid === board.uuid);
    if (!device) throw new QaFailure('Fixture is missing the configured QA board', 'blocked');
    return device;
  }
  private async open(role: Role, board: Board, climb: CatalogClimb): Promise<void> {
    await this.phones[role].flow('open-climb', {
      CLIMB_URL: this.url(role, `/b/${board.slug}/${board.angle}/play/${climb.uuid}`),
      CLIMB_LABEL_PATTERN: climbLabelPattern(climb),
    });
  }
  private async assertId(role: Role, id: string): Promise<void> {
    await this.phones[role].flow('assert-id', { EXPECTED_ID: id });
  }
  private async queueNext(role: Role, board: Board, current: CatalogClimb, next: CatalogClimb): Promise<void> {
    await this.unchanged(board, async () => {
      await this.open(role, board, next);
      await this.phones[role].flow('queue-next', {
        CLIMB_ACTIONS_LABEL: 'Climb actions',
        PLAY_NEXT_LABEL: 'Play next',
      });
      await this.phones[role].flow('return-current', {
        CURRENT_CLIMB_UUID: current.uuid,
        CURRENT_CLIMB_LABEL_PATTERN: climbLabelPattern(current),
      });
    });
  }
  private async ensureDriving(role: Role, board: Board, current: CatalogClimb): Promise<void> {
    await this.assertId(role, 'wall-control-.*-self-(idle|driving)');
    if (!/wall-control-[a-z_]+-self-driving/.test(await this.phones[role].hierarchy())) {
      await this.assertId(role, 'wall-control-.*-self-idle');
      const before = await this.fixture.request('status');
      const previous = this.device(before, board);
      await this.phones[role].flow('drive');
      const after = await until(
        () => this.fixture.request('status'),
        (snapshot) => {
          const actual = this.device(snapshot, board);
          return (
            actual.sequence > previous.sequence &&
            actual.updates > previous.updates &&
            canonical(actual.commands) === canonical(current.commands)
          );
        },
        30_000,
        'fresh physical Drive setup',
      );
      const actual = this.device(after, board);
      requirePhysicalDelivery(previous, actual, current, false, false);
      for (const untouched of this.boards.filter((candidate) => candidate.uuid !== board.uuid)) {
        const initial = this.device(before, untouched),
          latest = this.device(after, untouched);
        if (latest.writes !== initial.writes || latest.updates !== initial.updates)
          throw new QaFailure('Drive setup reached an unrelated board');
      }
      // A same-climb reassert can be history-deduplicated for ten seconds.
      // This proves physical setup; the following Next requires the full chain.
      this.evidence.event('physical-drive-setup', { role, boardUuid: board.uuid, sequence: actual.sequence });
    }
    await this.assertId(role, 'wall-control-.*-self-driving');
  }
  private async sessionQueue(): Promise<QaQueueSnapshot> {
    const response = await this.backend.query(QA_SESSION_QUEUE_QUERY, { id: this.sessionId });
    const snapshot = record(record(response.session).queueState);
    if (!Array.isArray(snapshot.queue)) throw new QaFailure('Invalid observed session queue', 'infrastructure');
    const queueItem = (candidate: unknown) => {
      const item = record(candidate);
      return { uuid: string(item.uuid), climb: { uuid: string(record(item.climb).uuid) } };
    };
    return {
      queue: snapshot.queue.map(queueItem),
      currentClimbQueueItem: snapshot.currentClimbQueueItem === null ? null : queueItem(snapshot.currentClimbQueueItem),
    };
  }
  private async requirePreviousQueue(
    before: QaQueueSnapshot,
    current: CatalogClimb,
    previous: CatalogClimb,
  ): Promise<void> {
    let after: QaQueueSnapshot;
    try {
      after = await until(
        () => this.sessionQueue(),
        (snapshot) => Boolean(previousQueueWitness(before, snapshot, current.uuid, previous.uuid)),
        30_000,
        'pinned notification Previous queue slots',
      );
    } catch (error) {
      if (error instanceof QaFailure && error.kind === 'failed')
        throw new QaFailure(
          'Notification Previous requires a fresh current slot and its pinned predecessor',
          'blocked',
        );
      throw error;
    }
    this.evidence.event('notification-queue-witness', {
      ...previousQueueWitness(before, after, current.uuid, previous.uuid),
      currentClimbUuid: current.uuid,
      previousClimbUuid: previous.uuid,
      trackContext: 'source-contract-derived trackless commit from a fresh public-link preview',
    });
  }
  private async resumeIos(
    board: Board,
    peer: Role,
    suspendedBaseline: { fixture: FixtureStatus; presence: Snapshot },
    fallbackPicker: boolean,
  ): Promise<void> {
    if (!fallbackPicker) {
      // Retained pending delivery keeps the original pre-request baseline so
      // foregrounding cannot hide an already completed send.
      await this.send('ios', board, board.catalog[0], 'put', {
        baseline: suspendedBaseline,
        action: () => this.phones.ios.foreground(),
      });
      return;
    }
    await this.phones[peer].flow('dismiss-picker', { BOARD_UUID: board.uuid });
    await this.phones.ios.foreground();
    await this.open('ios', board, board.catalog[0]);
    const resumed = { fixture: await this.fixture.request('status'), presence: await this.backend.snapshot(board) };
    const original = this.device(suspendedBaseline.fixture, board);
    const actual = this.device(resumed.fixture, board);
    if (
      actual.sequence > original.sequence &&
      actual.updates > original.updates &&
      canonical(actual.commands) === canonical(board.catalog[0].commands)
    ) {
      // A picker can follow a committed queue change; foregrounding may
      // already deliver it. Validate the original request once, without a tap.
      await this.send('ios', board, board.catalog[0], 'put', {
        baseline: suspendedBaseline,
        action: () => Promise.resolve(),
      });
    } else {
      // The route only previews. If still undelivered, require the real Put UI
      // and fresh baselines before a deliberate retry.
      await this.send('ios', board, board.catalog[0], 'put', { baseline: resumed });
    }
  }
  private async identity(role: Role): Promise<void> {
    try {
      await this.phones[role].flow('inspect-account', {
        ACCOUNT_URL: this.url(role, '/account'),
        USER_ID: this.user(role),
      });
    } catch (error) {
      if (error instanceof QaFailure && error.kind === 'failed')
        throw new QaFailure(
          `${role}: expected QA account/runtime selectors are absent. Use a current app build signed into its configured QA account.`,
          'blocked',
        );
      throw error;
    }
    const tree = await this.phones[role].hierarchy();
    const runtime = tree.match(/app-runtime-[a-zA-Z0-9_.-]+/)?.[0];
    if (!runtime) throw new QaFailure(`${role}: actual launched runtime identifier absent`, 'blocked');
    const previous = this.identities.get(role);
    if (previous && previous !== runtime)
      throw new QaFailure(`${role}: running revision changed during the suite`, 'blocked');
    this.identities.set(role, runtime);
    this.evidence.event('runtime', { role, runtime });
  }
  async prepare(): Promise<void> {
    for (const role of ROLES) await this.identity(role);
    const status = await this.fixture.request('status', undefined, true);
    if (status.runId || status.boards.some((board) => board.connections !== 0))
      throw new QaFailure('Fixture is busy; release existing test links before starting', 'blocked');
    for (const board of this.boards) {
      this.device(status, board);
      for (const role of ROLES) await this.open(role, board, board.catalog[0]);
      this.evidence.event('dwell-start', { boardUuid: board.uuid });
      const finishAt = Date.now() + 65_000;
      await until(
        async () => Date.now(),
        (now) => now >= finishAt,
        66_000,
        'real durable-history dwell',
      );
    }
    await this.fixture.start();
  }
  private async requireZeroLinks(): Promise<void> {
    const snapshot = await this.fixture.request('status');
    if (
      snapshot.boards.length !== this.boards.length ||
      this.boards.some((board) => !snapshot.boards.some((actual) => actual.uuid === board.uuid)) ||
      snapshot.boards.some((board) => board.connections !== 0)
    )
      throw new QaFailure('Independent case boundary requires the exact fixture boards with zero links', 'blocked');
  }
  private async caseBoundary(): Promise<void> {
    if (this.sessionId) throw new QaFailure('Independent case boundary requires an ended QA session', 'blocked');
    await this.requireZeroLinks();
    this.evidence.save(
      'inspect-inactive-record.yaml',
      'appId: ${APP_ID}\n---\n- openLink: ${RECORD_URL}\n- extendedWaitUntil:\n    visible:\n      id: session-start\n    timeout: 10000\n- assertNotVisible:\n    id: session-active-.+\n',
    );
    // Check both real Record surfaces before restarting either participant.
    // A local empty sessionId alone does not rule out a retained session.
    for (const role of ROLES)
      try {
        await this.phones[role].flow(join(this.evidence.directory, 'inspect-inactive-record.yaml'), {
          RECORD_URL: this.url(role, '/record'),
        });
      } catch (error) {
        if (error instanceof QaFailure && error.kind === 'failed')
          throw new QaFailure(`${role}: Record must show no active session before the case restart`, 'blocked');
        throw error;
      }
    for (const role of ROLES) {
      // Recheck all boards immediately before each terminate, never while a
      // test's cross-board or active-session continuity is in progress.
      await this.requireZeroLinks();
      await this.phones[role].restart();
      // Android restart uses its mounted root View. Native iOS tab controls
      // expose visibility reliably where the root View identifier does not.
      if (role === 'ios') await this.phones[role].flow('wait-ios-app-ready');
      await this.identity(role);
    }
  }
  private async send(
    role: Role,
    board: Board,
    climb: CatalogClimb,
    flow: string,
    options: {
      picker?: boolean;
      takeoverFrom?: Role;
      writer?: Role;
      multiChunk?: boolean;
      background?: boolean;
      action?: () => Promise<void>;
      baseline?: { fixture: FixtureStatus; presence: Snapshot };
      movingFrom?: string;
    } = {},
  ): Promise<void> {
    const before = options.baseline?.fixture ?? (await this.fixture.request('status'));
    const prior = this.device(before, board);
    const started = Date.now();
    const backendBefore = options.baseline?.presence ?? (await this.backend.snapshot(board));
    const baselineSeq = Math.max(0, ...backendBefore.recent.map((entry) => entry.seq));
    if (options.takeoverFrom) {
      if (options.takeoverFrom === role || !options.picker)
        throw new QaFailure('Physical takeover requires a different peer and an exact-board connection', 'blocked');
      requireTakeoverBaseline(prior, backendBefore, climb, this.user(options.takeoverFrom), board.angle);
    }
    if (options.action) await options.action();
    else await this.phones[role].flow(flow);
    if (options.picker) {
      // Remembered devices bypass the picker. Otherwise select only the exact saved wall.
      await until(
        async () => {
          const current = await this.fixture.request('status');
          const actual = this.device(current, board);
          const connected =
            actual.sequence > prior.sequence &&
            (!options.takeoverFrom || actual.connectionGeneration > prior.connectionGeneration);
          if (!options.takeoverFrom && connected) return true;
          const tree = await this.phones[role].hierarchy();
          if (options.takeoverFrom && tree.includes('busy-wall-question'))
            throw new QaFailure('Unexpected crew busy-wall question during physical takeover', 'blocked');
          if (connected) return true;
          if (tree.includes(`ble-device-${board.uuid}`)) {
            await this.phones[role].flow('select-device', { BOARD_UUID: board.uuid });
            return true;
          }
          return false;
        },
        Boolean,
        30_000,
        'exact-board picker or remembered connection',
      );
    }
    if (options.takeoverFrom && (await this.phones[role].hierarchy()).includes('busy-wall-question'))
      throw new QaFailure('Unexpected crew busy-wall question during physical takeover', 'blocked');
    const writer = options.writer ?? role;
    const after = await until(
      () => this.fixture.request('status'),
      (snapshot) => {
        const current = this.device(snapshot, board);
        return (
          current.sequence > prior.sequence &&
          current.updates > prior.updates &&
          (!options.takeoverFrom || current.connectionGeneration > prior.connectionGeneration) &&
          canonical(current.commands) === canonical(climb.commands)
        );
      },
      options.background ? 60_000 : 30_000,
      'fresh exact decoded BLE command',
    );
    const actual = this.device(after, board);
    requirePhysicalDelivery(prior, actual, climb, Boolean(options.picker), Boolean(options.multiChunk));
    for (const untouched of this.boards.filter((candidate) => candidate.uuid !== board.uuid)) {
      const initial = this.device(before, untouched),
        current = this.device(after, untouched);
      if (untouched.uuid === options.movingFrom) {
        if (
          current.connections !== 0 ||
          current.updates - initial.updates > 1 ||
          current.writes - initial.writes > 1 ||
          (current.writes > initial.writes &&
            (current.updates !== initial.updates + 1 || current.commands.length !== 0))
        )
          throw new QaFailure('Previous board did not release safely during the move');
        continue;
      }
      if (current.writes !== initial.writes || current.updates !== initial.updates)
        throw new QaFailure('A send reached an unrelated board');
    }
    const eligible = (entry: {
      seq: number;
      climbUuid: string;
      sentByUserId: string | null;
      angle: number | null;
      mirrored: boolean | null;
    }) =>
      entry.seq > baselineSeq &&
      entry.climbUuid === climb.uuid &&
      entry.sentByUserId === this.user(writer) &&
      entry.angle === board.angle &&
      entry.mirrored === false;
    const snapshot = await until(
      () => this.backend.snapshot(board),
      (snapshot) => snapshot.holder?.userId === this.user(writer) && snapshot.recent.some(eligible),
      30_000,
      'matching live holder and climb attribution',
    );
    const event = snapshot.recent.find(eligible);
    await until(
      async () => this.backend.events,
      (events) =>
        events.some(
          (entry) =>
            entry.boardUuid === board.uuid &&
            entry.event.__typename === 'BoardClimbSet' &&
            record(entry.event.climb).seq === event?.seq,
        ),
      30_000,
      'live subscription witnessed the confirmed climb',
    );
    await until(
      () => this.backend.snapshot(board),
      (snapshot) =>
        snapshot.history.some(
          (entry) =>
            entry.seq === event?.seq && entry.climbUuid === climb.uuid && entry.sentByUserId === this.user(writer),
        ),
      30_000,
      'durable history for the confirmed write',
    );
    this.evidence.event('confirmed-send', {
      boardUuid: board.uuid,
      role,
      writer,
      climbUuid: climb.uuid,
      actionToObservationMs: Date.now() - started,
      sequence: actual.sequence,
      connectionGeneration: actual.connectionGeneration,
      writes: actual.writes - prior.writes,
    });
  }
  private async disconnect(role: Role, board: Board): Promise<void> {
    await this.phones[role].flow('disconnect');
    await until(
      () => this.fixture.request('status'),
      (snapshot) => this.device(snapshot, board).connections === 0,
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
  private async unchanged(board: Board, action: () => Promise<void>): Promise<void> {
    const before = await this.fixture.request('status');
    const presenceBefore = await this.backend.snapshot(board);
    await action();
    const end = Date.now() + 2000;
    await until(
      async () => {
        const after = await this.fixture.request('status');
        for (const fixtureBoard of before.boards) {
          const current = after.boards.find((entry) => entry.uuid === fixtureBoard.uuid);
          if (!current || current.writes !== fixtureBoard.writes || current.updates !== fixtureBoard.updates)
            throw new QaFailure('Private preview unexpectedly wrote to a board');
        }
        return Date.now();
      },
      (now) => now >= end,
      4000,
      `no unintended send on ${board.family}`,
    );
    const presenceAfter = await this.backend.snapshot(board);
    if (JSON.stringify(presenceBefore) !== JSON.stringify(presenceAfter))
      throw new QaFailure('Private preview changed live presence or durable history');
  }
  async solo(): Promise<void> {
    for (const board of this.boards)
      for (const holder of ROLES) {
        const peer: Role = holder === 'ios' ? 'android' : 'ios';
        await this.evidence.scenario(`solo/${board.family}/${holder}`, [7023], async () => {
          await this.open(holder, board, board.catalog[0]);
          await this.send(holder, board, board.catalog[0], 'connect', { picker: true });
          // Public links preview. Queue the pinned successor, reopen current,
          // then use actual Next while driving with a fresh delivery baseline.
          await this.queueNext(holder, board, board.catalog[0], board.catalog[1]);
          await this.ensureDriving(holder, board, board.catalog[0]);
          await this.send(holder, board, board.catalog[1], 'next');
          await this.phones[holder].flow('stop-driving');
          await this.unchanged(board, () => this.open(holder, board, board.catalog[2]));
          await this.send(holder, board, board.catalog[2], 'put');
          await this.unchanged(board, () => this.open(peer, board, board.catalog[2]));
          await this.disconnect(holder, board);
          await this.send(peer, board, board.catalog[2], 'connect', { picker: true });
          // The previous writer must really be driving so its supersession is
          // observable. Same-climb Drive setup is physical-only (history dedup).
          await this.ensureDriving(peer, board, board.catalog[2]);
          await this.open(holder, board, board.catalog[2]);
          await this.send(holder, board, board.catalog[2], 'connect', { picker: true, takeoverFrom: peer });
          await until(
            () => this.phones[peer].hierarchy(),
            (tree) => !tree.includes('-driving'),
            30_000,
            'superseded driver stops',
          );
          await this.assertId(peer, 'wall-control-.*-(none|crew)-idle');
          await this.unchanged(board, () => this.open(peer, board, board.catalog[0]));
          const settleUntil = Date.now() + 3000;
          await until(
            async () => {
              const snapshot = await this.backend.snapshot(board);
              if (snapshot.holder?.userId !== this.user(holder))
                throw new QaFailure('Old disconnect cleared new holder');
              return Date.now();
            },
            (now) => now >= settleUntil,
            5000,
            'new holder survives prior disconnect cleanup',
          );
          await this.disconnect(holder, board);
          await this.phones[holder].restart();
          await this.identity(holder);
        });
      }
    await this.mixedBoards();
  }
  async mixedBoards(): Promise<void> {
    for (const role of ROLES)
      for (let index = 0; index < this.boards.length; index++) {
        const source = this.boards[index],
          target = this.boards[(index + 1) % this.boards.length];
        await this.evidence.scenario(
          `mixed/${source.family}-to-${target.family}/${role}`,
          [7001, 7076, 7047],
          async () => {
            await this.caseBoundary();
            await this.open(role, source, source.catalog[0]);
            await this.send(role, source, source.catalog[0], 'connect', { picker: true });
            const beforeForeign = this.device(await this.fixture.request('status'), source);
            await this.open(role, target, target.catalog[0]);
            // A foreign climb must never be reported as lit on the old physical board.
            const oldPresence = await this.backend.snapshot(source);
            if (oldPresence.recent.some((entry) => entry.climbUuid === target.catalog[0].uuid))
              throw new QaFailure('Foreign climb polluted the previous wall history');
            const oldPhysical = this.device(await this.fixture.request('status'), source);
            if (
              oldPhysical.updates - beforeForeign.updates > 1 ||
              oldPhysical.writes - beforeForeign.writes > 1 ||
              (oldPhysical.writes > beforeForeign.writes &&
                (oldPhysical.updates !== beforeForeign.updates + 1 || oldPhysical.commands.length !== 0))
            )
              throw new QaFailure('Foreign climb was encoded onto the previous board');
            await this.send(role, target, target.catalog[0], 'put', { picker: true, movingFrom: source.uuid });
            if (this.device(await this.fixture.request('status'), source).connections !== 0)
              throw new QaFailure('Board move retained the old physical link');
            await this.send(role, source, source.catalog[0], 'previous', {
              action: async () => {
                await this.phones[role].flow('previous');
                await this.phones[role].flow('put');
              },
              picker: true,
              movingFrom: target.uuid,
            });
            await this.disconnect(role, source);
          },
        );
      }
  }
  private async roster(count: number): Promise<void> {
    for (const role of ROLES)
      if (count === 2)
        await this.phones[role].flow('open-roster', {
          RECORD_URL: this.url(role, '/record'),
          SESSION_ID: this.sessionId,
          EXPECTED_ROSTER_COUNT: String(count),
          USER_ID: this.user(role),
        });
    const session = await until(
      () => this.backend.session(this.sessionId),
      (session) => Array.isArray(session?.users) && session.users.length === count,
      30_000,
      'stable session roster',
    );
    if (count === 2) {
      if (!session || !Array.isArray(session.users))
        throw new QaFailure('Invalid session roster response', 'infrastructure');
      const users = session.users.map(record);
      for (const role of ROLES) {
        const profile = this.backend.profiles.get(this.config.phones[role].email);
        if (!profile) throw new Error('Missing authenticated profile baseline');
        requireSessionIdentity(users, { userId: this.user(role), ...profile });
      }
    }
  }
  async sessions(): Promise<void> {
    for (const board of this.boards)
      for (const holder of ROLES) {
        const peer: Role = holder === 'ios' ? 'android' : 'ios';
        await this.evidence.scenario(
          `session/${board.family}/${holder}`,
          [7013, 7018, 7114, 7019, 7015, 7046, 7025],
          async () => {
            await this.caseBoundary();
            await this.open(holder, board, board.catalog[0]);
            await this.send(holder, board, board.catalog[0], 'connect', { picker: true });
            await this.phones[holder].flow('start-session', { RECORD_URL: this.url(holder, '/record') });
            const tree = await this.phones[holder].hierarchy();
            this.sessionId = tree.match(/session-active-([0-9a-f-]{36})/i)?.[1] ?? '';
            if (!this.sessionId) throw new QaFailure('Session creation did not expose its real session ID');
            await this.unchanged(board, async () => {
              await this.phones[peer].restart();
              await this.identity(peer);
              await this.phones[peer].flow('join-session', {
                SESSION_URL: this.url(peer, `/join/${this.sessionId}`),
                SESSION_ID: this.sessionId,
              });
            });
            await this.roster(2);
            const session = await this.backend.session(this.sessionId);
            if (!String(session?.boardPath).includes(`/b/${board.slug}`))
              throw new QaFailure('Join lost the named saved wall');
            await this.open(peer, board, board.catalog[0]);
            await this.assertId(peer, 'wall-control-.*-crew-idle');
            await this.history(peer, board, board.catalog[0], this.user(holder));
            await this.unchanged(board, () => this.open(peer, board, board.catalog[1]));
            await this.send(peer, board, board.catalog[1], 'put', { writer: holder });
            await this.history(peer, board, board.catalog[0], this.user(holder));
            const lit = (await this.backend.snapshot(board)).recent[0];
            if (!lit || lit.climbUuid !== board.catalog[1].uuid || lit.sentByUserId !== this.user(holder))
              throw new QaFailure('Clear requires the freshly confirmed shared climb');
            // This exact peer hero must be visible before absence can prove a
            // clear. Keep the panel at its top until the negative assertion.
            await this.assertId(peer, `board-current-${lit.climbUuid}-${this.user(holder)}`);
            await this.open(holder, board, board.catalog[1]);
            const beforeClearStatus = await this.fixture.request('status');
            const beforeClear = this.device(beforeClearStatus, board);
            const clearEventIndex = this.backend.events.length;
            await this.phones[holder].flow('clear');
            const afterClearStatus = await until(
              () => this.fixture.request('status'),
              (snapshot) => {
                const current = this.device(snapshot, board);
                return (
                  current.sequence > beforeClear.sequence &&
                  current.updates > beforeClear.updates &&
                  current.writes > beforeClear.writes &&
                  current.commands.length === 0 &&
                  current.connections === 1
                );
              },
              30_000,
              'fresh clear retains physical connection',
            );
            requirePhysicalDelivery(
              beforeClear,
              this.device(afterClearStatus, board),
              { ...board.catalog[1], commands: [] },
              false,
              false,
            );
            for (const untouched of this.boards.filter((candidate) => candidate.uuid !== board.uuid)) {
              const initial = this.device(beforeClearStatus, untouched),
                after = this.device(afterClearStatus, untouched);
              if (initial.writes !== after.writes || initial.updates !== after.updates)
                throw new QaFailure('Clear reached an unrelated board');
            }
            await until(
              async () => this.backend.events.slice(clearEventIndex),
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
            if ((await this.backend.snapshot(board)).holder?.userId !== this.user(holder))
              throw new QaFailure('Clear lost the confirmed physical holder');
            await this.assertId(holder, 'wall-control-dark-self-idle');
            await this.phones[peer].flow('observe-clear-history', {
              BOARD_UUID: board.uuid,
              CLIMB_UUID: lit.climbUuid,
              WRITER_ID: this.user(holder),
              HISTORY_SEQ: String(lit.seq),
            });
            await this.unchanged(board, () => this.open(peer, board, board.catalog[1]));
            await this.assertId(peer, 'wall-control-crew-crew-idle');
            await this.send(peer, board, board.catalog[1], 'put', { writer: holder });
            await this.fixture.request('drop', board.uuid);
            await until(
              () => this.backend.snapshot(board),
              (snapshot) => !snapshot.holder,
              30_000,
              'forced BLE loss releases holder',
            );
            const beforeNotificationQueue =
              holder === 'android' && board.family === 'moonboard' ? await this.sessionQueue() : undefined;
            await this.open(holder, board, board.catalog[2]);
            await this.send(holder, board, board.catalog[2], 'connect', { picker: true });
            if (beforeNotificationQueue) {
              await this.ensureDriving(holder, board, board.catalog[2]);
              await this.requirePreviousQueue(beforeNotificationQueue, board.catalog[2], board.catalog[1]);
            }
            await this.phones[holder].background();
            let suspendedBaseline: { fixture: FixtureStatus; presence: Snapshot } | undefined;
            let fallbackPicker = false;
            if (holder === 'android') {
              if (board.family === 'moonboard') {
                if (board.catalog[1].packetBytes <= 20)
                  throw new QaFailure('Pinned MoonBoard previous item does not require multiple chunks', 'blocked');
                await this.send(holder, board, board.catalog[1], 'notification-previous', {
                  writer: holder,
                  background: true,
                  multiChunk: true,
                  action: () =>
                    notificationPrevious(
                      this.config.adb,
                      this.config.phones.android.id,
                      board.catalog[2].name,
                      this.evidence,
                    ),
                });
              }
              await this.open(peer, board, board.catalog[0]);
              await this.send(peer, board, board.catalog[0], 'put', {
                writer: holder,
                background: true,
                multiChunk: board.family === 'moonboard',
              });
            } else {
              const deadline = Date.now() + 70_000;
              await until(
                async () => Date.now(),
                (now) => now >= deadline,
                71_000,
                'iOS suspension window',
              );
              await this.open(peer, board, board.catalog[0]);
              const beforeRequest = await this.backend.snapshot(board);
              suspendedBaseline = { fixture: await this.fixture.request('status'), presence: beforeRequest };
              await this.phones[peer].flow('put');
              fallbackPicker = (await this.phones[peer].hierarchy()).includes(`ble-device-${board.uuid}`);
              this.evidence.event('documented-limitation', {
                issue: 2174,
                boardUuid: board.uuid,
                note: 'Suspended iOS cross-device wake is not promised; observe pending delivery on foreground, or explicitly resume driving after the picker fallback.',
              });
              const afterRequest = await this.backend.snapshot(board);
              const physical = this.device(await this.fixture.request('status'), board);
              if (
                canonical(physical.commands) !== canonical(board.catalog[0].commands) &&
                afterRequest.recent[0]?.seq !== beforeRequest.recent[0]?.seq
              )
                throw new QaFailure('Suspended holder reported a climb it did not physically light');
            }
            if (holder === 'ios') {
              if (!suspendedBaseline) throw new Error('Missing suspended request baseline');
              await this.resumeIos(board, peer, suspendedBaseline, fallbackPicker);
            } else await this.phones[holder].foreground();
            await this.phones[peer].flow('leave-session', {
              RECORD_URL: this.url(peer, '/record'),
              SESSION_ID: this.sessionId,
              SESSION_EXIT_LABEL: 'Leave session',
            });
            await this.phones[peer].flow('join-session', {
              SESSION_URL: this.url(peer, `/join/${this.sessionId}`),
              SESSION_ID: this.sessionId,
            });
            await this.roster(2);
            await this.phones[holder].restart();
            await this.identity(holder);
            await this.roster(2);
            await this.history(holder, board, board.catalog[0], this.user(holder));
            await this.phones[holder].flow('end-session', {
              RECORD_URL: this.url(holder, '/record'),
              SESSION_ID: this.sessionId,
              SESSION_EXIT_LABEL: 'End session',
            });
            const id = this.sessionId;
            this.sessionId = '';
            await until(
              () => this.backend.query('query QaEnded($id: ID!) { sessionStatus(sessionId: $id) }', { id }),
              (snapshot) => snapshot.sessionStatus === 'ended',
              30_000,
              'session ended durably',
            );
            // End does not promise BLE teardown; explicitly release the remaining link.
            await this.open(holder, board, board.catalog[0]);
            if (this.device(await this.fixture.request('status'), board).connections)
              await this.disconnect(holder, board);
          },
        );
      }
  }
  private async history(role: Role, board: Board, climb: CatalogClimb, writer: string): Promise<void> {
    const snapshot = await this.backend.snapshot(board);
    const entry = snapshot.history.find((entry) => entry.climbUuid === climb.uuid && entry.sentByUserId === writer);
    if (!entry) throw new QaFailure('Expected confirmed climb missing from saved wall history');
    const boardName = {
      kilter: 'Boardsesh QA Kilter Homewall Full',
      tension: 'Boardsesh QA Tension 2 Mirror',
      moonboard: 'Boardsesh QA MoonBoard 2024',
    }[board.family];
    await this.phones[role].flow('open-history', {
      BOARD_URL: this.url(role, `/b/${board.slug}`),
      BOARD_UUID: board.uuid,
      BOARD_HISTORY_LABEL: `Board history, ${boardName}`,
    });
    if (snapshot.recent[0]?.seq === entry.seq) await this.assertId(role, `board-current-${climb.uuid}-${writer}`);
    else await this.assertId(role, `board-history-${climb.uuid}-${entry.seq}`);
  }
  async failureArtifacts(): Promise<void> {
    for (const role of ROLES) {
      try {
        this.evidence.save(`${role}-failure-tree.json`, await this.phones[role].hierarchy());
        await this.phones[role].screenshot(`${role}-failure`);
      } catch {
        this.evidence.event('artifact-unavailable', { role });
      }
    }
    if (this.sessionId)
      this.evidence.event('retained-session', {
        id: this.sessionId,
        recovery: 'End the QA session normally on its creator phone; no record deletion is performed.',
      });
    this.evidence.save('recovery.json', {
      sessionId: this.sessionId || null,
      directory: join(this.evidence.directory),
    });
  }
}
