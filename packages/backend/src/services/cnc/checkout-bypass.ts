import { logger } from '../../utils/logger';

/**
 * The dev-only "pretend the buyer paid" switch.
 *
 * Stripe Checkout cannot be driven from a laptop stack without live keys, a
 * webhook tunnel and a test card, which makes the one flow that matters most —
 * buy, generate, download — the hardest one to exercise locally. This flag
 * skips the payment leg only: the order row, the state machine, the worker
 * claim, the pack and the download grant are all the real thing.
 *
 * It is deliberately hard to turn on by accident, and impossible to leave on
 * where money is involved. Four conditions, all of which must hold:
 *
 * 1. `CNC_CHECKOUT_BYPASS=1` — explicit opt-in, and only that exact value.
 * 2. `NODE_ENV !== 'production'`.
 * 3. No `RAILWAY_ENVIRONMENT` — every deployed Boardsesh service has one, and
 *    Railway prod leaves `NODE_ENV` unset, so condition 2 alone would not
 *    catch it.
 * 4. No `STRIPE_SECRET_KEY` — a stack that can take a real payment never
 *    fakes one. This is the condition that makes "bypass" and "charging
 *    people" mutually exclusive rather than merely unlikely.
 *
 * Read from `process.env` on every call, exactly like `isStripeConfigured()`,
 * so a test can flip it between cases without import order deciding the
 * answer.
 */
export function isCheckoutBypassEnabled(): boolean {
  if (process.env.CNC_CHECKOUT_BYPASS !== '1') return false;
  if (process.env.NODE_ENV === 'production') return false;
  if (process.env.RAILWAY_ENVIRONMENT) return false;
  // Never alongside real payments: a key means this process can charge a card,
  // and a build pack that was never paid for must not exist on such a stack.
  if (process.env.STRIPE_SECRET_KEY) return false;
  return true;
}

let warned = false;

/**
 * Say it out loud at boot, once.
 *
 * A backend that hands out licensed packs for free is worth a line in the log
 * an operator cannot miss — the failure mode this guards against is somebody
 * inheriting a `.env` file and never learning what is in it. Once per process
 * rather than per request, so the warning stays readable.
 */
export function warnIfCheckoutBypassEnabled(): void {
  if (warned || !isCheckoutBypassEnabled()) return;
  warned = true;
  logger.warn(
    '[cnc-checkout] CNC_CHECKOUT_BYPASS is on: build-pack checkout SKIPS STRIPE and queues orders as paid. Development only.',
  );
}

/** Forget that the warning was logged. Tests use this; nothing in production does. */
export function resetCheckoutBypassWarningForTests(): void {
  warned = false;
}
