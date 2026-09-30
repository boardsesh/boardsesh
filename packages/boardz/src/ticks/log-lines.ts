export type LogOutcome = 'flash' | 'send' | 'attempt';

/** A few ways to say it, so a session of logging doesn't read like a form letter. */
export const LOG_LINES: Record<LogOutcome, readonly string[]> = {
  flash: [
    'First go. Filthy.',
    'One and done.',
    'Read it, sent it.',
    "Didn't even need a second look.",
    'First try. Save some for the rest of us.',
    'Clean from the first move.',
  ],
  send: [
    'Logged to your logbook.',
    'Another one in the book.',
    'Worth every try.',
    'Done and dusted.',
    'Tick. On to the next.',
    "That one's yours now.",
  ],
  attempt: [
    "It'll go next session.",
    "Rest up. It's close.",
    'Every try counts.',
    'The project continues.',
    "You'll have it next time.",
    'Beta noted. Come back fresh.',
  ],
};

const lastShown: Partial<Record<LogOutcome, number>> = {};

/** A line for the toast after logging, never the same one twice in a row. */
export function logLine(outcome: LogOutcome, random: () => number = Math.random): string {
  const lines = LOG_LINES[outcome];
  let index = Math.min(lines.length - 1, Math.floor(random() * lines.length));
  if (index === lastShown[outcome]) index = (index + 1) % lines.length;
  lastShown[outcome] = index;
  return lines[index];
}
