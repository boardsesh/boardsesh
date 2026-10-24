// One command at a time to a slow, write-only device (#5397). Pure: no React,
// no I/O beyond the `run` it is handed.
//
// A gym timer's restart is three key presses with gaps between them. Two
// restarts sent at once interleave their presses, and on the Rogue OK is a
// start/stop toggle, so two OKs leave the clock stopped. This queue runs one
// command to completion before the next, keeps only the newest of the ones
// waiting, and drops a command the one in flight already delivers.

export type LatestWinsQueue<Command> = {
  /** Queue a command. It replaces any command still waiting. */
  push: (command: Command) => void;
  /** Drop what is waiting and accept nothing more. The command in flight finishes. */
  dispose: () => void;
};

export type LatestWinsQueueOptions<Command> = {
  /**
   * The command in flight already gives what `incoming` asks for, so `incoming`
   * and anything waiting are dropped. A restart whose final press has not gone
   * out yet starts the clock after `incoming` was asked for, which is what it
   * wanted.
   */
  absorbs?: (inFlight: Command, incoming: Command) => boolean;
  /** A run that threw. The queue carries on with the next command either way. */
  onError?: (error: unknown, command: Command) => void;
};

export function createLatestWinsQueue<Command>(
  run: (command: Command) => Promise<void>,
  { absorbs, onError }: LatestWinsQueueOptions<Command> = {},
): LatestWinsQueue<Command> {
  // Boxed, so a command that is itself falsy is still a command.
  let inFlight: { command: Command } | null = null;
  let waiting: { command: Command } | null = null;
  let disposed = false;

  const drain = async (): Promise<void> => {
    while (waiting !== null && !disposed) {
      const current = waiting;
      waiting = null;
      inFlight = current;
      try {
        await run(current.command);
      } catch (error) {
        onError?.(error, current.command);
      }
      inFlight = null;
    }
  };

  return {
    push(command) {
      if (disposed) return;
      if (inFlight !== null && absorbs?.(inFlight.command, command)) {
        waiting = null;
        return;
      }
      waiting = { command };
      if (inFlight === null) void drain();
    },
    dispose() {
      disposed = true;
      waiting = null;
    },
  };
}
