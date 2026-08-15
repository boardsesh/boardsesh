/**
 * Shared limits for the gym-claim flow, so the web form, the mobile sheet, and
 * the backend validator all agree. A client that caps input below the backend
 * limit silently truncates; one that caps above it lets the user write a message
 * the mutation then rejects with no inline explanation.
 */

/** Max length of the optional note on an admin-review claim (backend + both clients). */
export const GYM_CLAIM_MESSAGE_MAX_LENGTH = 1000;

/**
 * Where an owner writes about a claim or an ownership handover. There is no
 * in-product owner-reassignment action yet (#4378 builds one), so both clients
 * name the channel that actually processes these — the same admin-reviewed
 * inbox the claim queue mails.
 */
export const GYM_CLAIM_SUPPORT_EMAIL = 'admin@boardsesh.com';
