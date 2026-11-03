/**
 * How long a tap is dropped after one that changed what the next tap does.
 * Shared by the player's board control (`use-wall-control.ts`) and the
 * MiniPlayer's bulbs (`queue-control/bar-bulb-tap.ts`), so a stop on either
 * guards the same way. Pure constants: the bar imports them without the
 * player's handler.
 */

/**
 * After a tap that changes what the next tap does, how long further taps are
 * dropped. After a disconnect: the provider marks the link down before the
 * adapter's disconnect finishes, so the second tap of a double tap would
 * otherwise read Put on board and start a connect (the picker, or a 15 s scan)
 * mid-disconnect. After a stop: the second tap would land on Disconnect board,
 * and a crew's board has no Undo.
 */
export const DISCONNECT_TAP_GUARD_MS = 600;

/**
 * After Put on board's timed drive ends on its own and the label flips to
 * Disconnect board, how long a tap that would disconnect is dropped (spec B2),
 * the button's or a bulb's: a tap aimed at You are driving the wall to stop it
 * must not let go of a crew's board instead. With Disconnect Bluetooth when
 * driving ends on, that end lets go of the board and the label flips to Put
 * on board instead, so a put-up is dropped too: the stop the climber meant
 * must not reconnect and start a fresh drive. Otherwise any other tap (Put on
 * board on a preview) goes through. Touch, VoiceOver, Switch Control and
 * Voice Control all arrive as this one press.
 */
export const WINDOW_END_TAP_GRACE_MS = 2_000;
