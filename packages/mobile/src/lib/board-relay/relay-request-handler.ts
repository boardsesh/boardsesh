import type { BoardClimbRelayRequested, ClimbQueueItemInput } from '@boardsesh/shared-schema';

/**
 * The holder doesn't know where another climber's drive starts or ends, so
 * "one line per relayed drive" is read as one line per relayer per run of
 * relays: a relayer heard from within this long is still the same drive.
 */
export const RELAYER_LINE_QUIET_MS = 5 * 60_000;

/** What the holder's phone needs to answer a relay, read fresh for every request. */
export type RelayRequestHandlerDeps = {
  /** This phone's own link holds a Relay mode MoonBoard, the flag is on and the holder setting allows it. */
  canLight: () => boolean;
  /** The board presence is bound to, or null. */
  boardId: () => number | null;
  /**
   * Capture the wall's operation (link and board) before the write. The
   * returned check is false once a clear, a reconnect or a board switch moved
   * it on, so neither the write's report nor a stale echo goes out.
   */
  fence: () => () => boolean;
  /** Write the frames over Bluetooth. Resolves whether they went out. */
  write: (frames: string, mirrored: boolean, climbUuid: string) => Promise<boolean>;
  /** Report the lit climb with the request's id, exactly as received, fenced by `isCurrent`. */
  report: (
    boardId: number,
    climb: ClimbQueueItemInput,
    angle: number,
    relayRequestId: string,
    isCurrent: () => boolean,
  ) => Promise<boolean>;
  /** "{name} is driving", or the anonymous line for a null name. */
  showRelayerLine: (name: string | null) => void;
  now?: () => number;
};

export type RelayRequestResult = 'lit' | 'ignored' | 'superseded' | 'write_failed' | 'report_failed';

function relayClimbToQueueInput(request: BoardClimbRelayRequested): ClimbQueueItemInput {
  const { climb } = request;
  return {
    uuid: climb.queueItemUuid ?? `relay:${request.relayRequestId}`,
    climb: {
      uuid: climb.climbUuid,
      setter_username: climb.setter ?? '',
      name: climb.name ?? '',
      frames: climb.frames ?? '',
      angle: request.angle,
      ascensionist_count: 0,
      difficulty: climb.grade ?? '',
      quality_average: '',
      stars: 0,
      difficulty_error: '',
      mirrored: request.mirrored,
    },
  };
}

/** The relayer's name under the board-holder privacy rule (the server names only a non-anonymous profile). */
function relayerNameOf(request: BoardClimbRelayRequested): string | null {
  if (request.relayer.anonymous) return null;
  const name = request.relayer.displayName?.trim();
  return name ? name : null;
}

/**
 * Relay mode (#7220): the holder's answer to one relay request. Lights the
 * climb over this phone's link and reports it with the request's id, so the
 * relaying phone sees the echo. A request this phone can't light (no link, the
 * setting off, the flag off, another board, a climb with no frames) is
 * ignored: the relaying phone's own timeout says it didn't land.
 *
 * Requests are answered one at a time, latest wins per relayer: an original
 * MoonBoard writes slowly (write-with-response, 23-byte MTU), so a relayer who
 * swipes A, B, C fast gets C lit, not a backlog that makes C miss its 8 s.
 * The relayer's own phone already superseded A and B.
 *
 * Deps are read through a getter so the subscription is made once.
 */
export function createRelayRequestHandler(
  getDeps: () => RelayRequestHandlerDeps | null,
): (request: BoardClimbRelayRequested) => Promise<RelayRequestResult> {
  const lastLineAt = new Map<string, number>();
  const latestByRelayer = new Map<string, string>();
  let queue: Promise<unknown> = Promise.resolve();

  const answer = async (request: BoardClimbRelayRequested, relayerKey: string): Promise<RelayRequestResult> => {
    if (latestByRelayer.get(relayerKey) !== request.relayRequestId) return 'superseded';
    const deps = getDeps();
    if (!deps || !deps.canLight()) return 'ignored';
    const boardId = deps.boardId();
    const frames = request.climb.frames;
    if (boardId === null || !frames) return 'ignored';
    const isCurrent = deps.fence();
    const written = await deps.write(frames, request.mirrored, request.climb.climbUuid).catch(() => false);
    if (!written) return 'write_failed';
    if (!isCurrent()) return 'ignored';
    const accepted = await deps
      .report(boardId, relayClimbToQueueInput(request), request.angle, request.relayRequestId, isCurrent)
      .catch(() => false);
    return accepted ? 'lit' : 'report_failed';
  };

  return (request) => {
    const deps = getDeps();
    if (!deps || !deps.canLight()) return Promise.resolve('ignored');
    const relayerKey = request.relayer.userId ?? 'anon';
    latestByRelayer.set(relayerKey, request.relayRequestId);
    const now = deps.now?.() ?? Date.now();
    const lastAt = lastLineAt.get(relayerKey);
    lastLineAt.set(relayerKey, now);
    if (lastAt === undefined || now - lastAt > RELAYER_LINE_QUIET_MS) deps.showRelayerLine(relayerNameOf(request));
    const result = queue.then(() => answer(request, relayerKey));
    queue = result.catch(() => undefined);
    return result;
  };
}
