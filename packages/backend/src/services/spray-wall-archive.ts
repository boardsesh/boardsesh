/**
 * The refusal an archived spray wall gives every write that would change it.
 *
 * A leaf module so the photo upload handler and the wall resolvers say the same
 * thing without importing each other (the resolvers already import the handler).
 */
export const SPRAY_WALL_ARCHIVED_CODE = 'SPRAY_WALL_ARCHIVED';

export const SPRAY_WALL_ARCHIVED_MESSAGE = 'This wall is archived. Its climbs stay, but nothing new can be set on it.';
