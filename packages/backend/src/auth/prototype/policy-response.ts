import type { BetterAuthPlugin } from 'better-auth';
import { createAuthMiddleware, isAPIError } from 'better-auth/api';

/** Append after every caller plugin: pinned dispatch may retain an older HTTP status. */
export function createPrototypePolicyResponseObserver() {
  let failure: Response | undefined;
  const plugin: BetterAuthPlugin = {
    id: 'boardsesh-prototype-final-policy-response',
    hooks: {
      after: [
        {
          matcher: () => true,
          handler: createAuthMiddleware(async (context) => {
            const returned = context.context.returned;
            if (isAPIError(returned) && returned.statusCode >= 400) {
              failure = Response.json(returned.body ?? { code: 'PROTOTYPE_POLICY_REJECTED' }, {
                status: returned.statusCode,
              });
            } else if (returned instanceof Response && returned.status >= 400) {
              failure = returned;
            }
          }),
        },
      ],
    },
  };
  return { plugin, failure: () => failure };
}
