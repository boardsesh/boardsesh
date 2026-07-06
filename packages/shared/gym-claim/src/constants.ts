/**
 * Shared limits for the gym-claim flow, so the web form, the mobile sheet, and
 * the backend validator all agree. A client that caps input below the backend
 * limit silently truncates; one that caps above it lets the user write a message
 * the mutation then rejects with no inline explanation.
 */

/** Max length of the optional note on an admin-review claim (backend + both clients). */
export const GYM_CLAIM_MESSAGE_MAX_LENGTH = 1000;
