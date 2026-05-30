import type { ConnectionContext, CommentEvent } from '@boardsesh/shared-schema';
import { pubsub } from '../../../pubsub/index';
import { createAsyncIterator } from '../shared/async-iterators';
import { SocialEntityTypeSchema } from '../../../validation/schemas';

// Derive the allow-list from the shared Zod enum so it can never drift from
// SocialEntityType. A hand-rolled list here previously dropped 'session' and
// 'gym', breaking realtime comments on those pages (issue #2357).
const VALID_ENTITY_TYPES = new Set<string>(SocialEntityTypeSchema.options);

// Composite entity IDs (e.g. "playlist_uuid:climb_uuid") can be long but
// should never exceed a reasonable bound. UUIDs are 36 chars, so a composite
// of two with separator is ~73. 256 provides generous headroom.
const MAX_ENTITY_ID_LENGTH = 256;

export const socialCommentSubscriptions = {
  commentUpdates: {
    subscribe: async function* (
      _: unknown,
      { entityType, entityId }: { entityType: string; entityId: string },
      _ctx: ConnectionContext,
    ) {
      // Validate inputs to prevent channel injection
      if (!VALID_ENTITY_TYPES.has(entityType)) {
        throw new Error(`Invalid entity type: ${entityType}`);
      }
      if (!entityId || entityId.length > MAX_ENTITY_ID_LENGTH) {
        throw new Error('Invalid entity ID');
      }

      const entityKey = `${entityType}:${entityId}`;

      const asyncIterator = await createAsyncIterator<CommentEvent>((push) => {
        return pubsub.subscribeComments(entityKey, push);
      });

      for await (const event of asyncIterator) {
        yield { commentUpdates: event };
      }
    },
  },
};
