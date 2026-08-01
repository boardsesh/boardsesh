/**
 * OpenAPI Route Definitions
 *
 * This file registers all REST API endpoints with the OpenAPI registry.
 * Each endpoint definition includes:
 * - HTTP method and path
 * - Request parameters/body
 * - Response schemas for different status codes
 * - Tags for grouping
 * - Description and summary
 *
 * When adding a new API endpoint:
 * 1. Add the route registration below using registry.registerPath()
 * 2. Reference schemas from openapi-registry.ts
 */

import { z } from 'zod';
import {
  registry,
  BoardNameSchema,
  GradesResponseSchema,
  ClimbSchema,
  ClimbStatsResponseSchema,
  SettersResponseSchema,
  HeatmapDataSchema,
  AnglesResponseSchema,
  LayoutSlugResponseSchema,
  SizeSlugResponseSchema,
  SetsSlugResponseSchema,
  RegisterRequestSchema,
  RegisterResponseSchema,
  VerifyEmailRequestSchema,
  ResendVerificationRequestSchema,
  ErrorResponseSchema,
  UserProfileSchema,
  UpdateProfileRequestSchema,
  WsAuthResponseSchema,
} from './openapi-registry';

const PUBLIC_READ_RATE_LIMIT_RESPONSE = {
  description: 'The shared client-IP budget of 120 origin requests per 60 seconds has been exceeded.',
  headers: {
    'Retry-After': {
      description: 'Positive number of seconds to wait before retrying.',
      schema: { type: 'integer' as const, minimum: 1 },
    },
  },
  content: {
    'application/json': {
      schema: ErrorResponseSchema,
    },
  },
};

function describePublicRead(endpointDescription: string): string {
  return `${endpointDescription} Requests that reach the origin share a 120 requests/60 seconds client-IP budget across all public GET /api/v1 routes. Responses served directly from the CDN cache do not spend that budget.`;
}

// ============================================
// Board Configuration Routes
// ============================================

registry.registerPath({
  method: 'get',
  path: '/api/v1/{board_name}/grades',
  summary: 'Get difficulty grades',
  description: describePublicRead(
    'Returns all difficulty grades for a specific board type. Grades are board-specific and include both numeric IDs and human-readable names.',
  ),
  tags: ['Board Configuration'],
  request: {
    params: z.object({
      board_name: BoardNameSchema,
    }),
  },
  responses: {
    200: {
      description: 'List of grades',
      content: {
        'application/json': {
          schema: GradesResponseSchema,
        },
      },
    },
    429: PUBLIC_READ_RATE_LIMIT_RESPONSE,
    500: {
      description: 'Server error',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/grades/{board_name}',
  summary: 'Get difficulty grades (alternate)',
  description: describePublicRead(
    'Alternate endpoint for getting difficulty grades. Returns the same data as /api/v1/{board_name}/grades.',
  ),
  tags: ['Board Configuration'],
  request: {
    params: z.object({
      board_name: BoardNameSchema,
    }),
  },
  responses: {
    200: {
      description: 'List of grades',
      content: {
        'application/json': {
          schema: GradesResponseSchema,
        },
      },
    },
    429: PUBLIC_READ_RATE_LIMIT_RESPONSE,
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/angles/{board_name}/{layout_id}',
  summary: 'Get available angles',
  description: describePublicRead(
    'Returns all available angles for a board (the same range applies to every layout). Angles are typically between 0-70 degrees depending on the board configuration.',
  ),
  tags: ['Board Configuration'],
  request: {
    params: z.object({
      board_name: BoardNameSchema,
      layout_id: z.string().describe('Layout ID'),
    }),
  },
  responses: {
    200: {
      description: 'List of available angles',
      content: {
        'application/json': {
          schema: AnglesResponseSchema,
        },
      },
    },
    429: PUBLIC_READ_RATE_LIMIT_RESPONSE,
  },
});

// ============================================
// Climb Routes
// ============================================

registry.registerPath({
  method: 'get',
  path: '/api/v1/{board_name}/{layout_id}/{size_id}/{set_ids}/{angle}/{climb_uuid}',
  summary: 'Get climb details',
  description: describePublicRead(
    'Returns detailed information about a specific climb including hold positions, difficulty, and statistics.',
  ),
  tags: ['Climbs'],
  request: {
    params: z.object({
      board_name: BoardNameSchema,
      layout_id: z.string().describe('Layout ID or slug'),
      size_id: z.string().describe('Size ID or slug'),
      set_ids: z.string().describe('Comma-separated set IDs or slug'),
      angle: z.string().describe('Board angle in degrees'),
      climb_uuid: z.string().describe('Unique climb identifier'),
    }),
  },
  responses: {
    200: {
      description: 'Climb details',
      content: {
        'application/json': {
          schema: ClimbSchema,
        },
      },
    },
    404: {
      description: 'Climb not found',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
    429: PUBLIC_READ_RATE_LIMIT_RESPONSE,
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/{board_name}/climb-stats/{climb_uuid}',
  summary: 'Get climb statistics across all angles',
  description: describePublicRead(
    'Returns statistics for a climb at every angle it has been attempted. Useful for seeing how difficulty and popularity vary with angle.',
  ),
  tags: ['Climbs'],
  request: {
    params: z.object({
      board_name: BoardNameSchema,
      climb_uuid: z.string().describe('Unique climb identifier'),
    }),
  },
  responses: {
    200: {
      description: 'Climb statistics by angle',
      content: {
        'application/json': {
          schema: ClimbStatsResponseSchema,
        },
      },
    },
    429: PUBLIC_READ_RATE_LIMIT_RESPONSE,
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/{board_name}/{layout_id}/{size_id}/{set_ids}/{angle}/setters',
  summary: 'Get setters for a board configuration',
  description: describePublicRead(
    'Returns a list of climb setters for the specified board configuration, ordered by number of climbs set.',
  ),
  tags: ['Climbs'],
  request: {
    params: z.object({
      board_name: BoardNameSchema,
      layout_id: z.string().describe('Layout ID'),
      size_id: z.string().describe('Size ID'),
      set_ids: z.string().describe('Comma-separated set IDs'),
      angle: z.string().describe('Board angle in degrees'),
    }),
  },
  responses: {
    200: {
      description: 'List of setters',
      content: {
        'application/json': {
          schema: SettersResponseSchema,
        },
      },
    },
    429: PUBLIC_READ_RATE_LIMIT_RESPONSE,
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/{board_name}/{layout_id}/{size_id}/{set_ids}/{angle}/heatmap',
  summary: 'Get hold usage heatmap',
  description: describePublicRead(
    'Returns frequency data for each hold, showing how often holds are used in climbs. Useful for visualizing popular hold positions. Anonymous and signed-in heatmap reads spend the same IP budget, so users behind one gym NAT share it.',
  ),
  tags: ['Climbs'],
  request: {
    params: z.object({
      board_name: BoardNameSchema,
      layout_id: z.string().describe('Layout ID'),
      size_id: z.string().describe('Size ID'),
      set_ids: z.string().describe('Comma-separated set IDs'),
      angle: z.string().describe('Board angle in degrees'),
    }),
  },
  responses: {
    200: {
      description: 'Hold usage frequency map',
      content: {
        'application/json': {
          schema: HeatmapDataSchema,
        },
      },
    },
    429: PUBLIC_READ_RATE_LIMIT_RESPONSE,
  },
});

// ============================================
// Slug Resolution Routes
// ============================================

registry.registerPath({
  method: 'get',
  path: '/api/v1/{board_name}/slugs/layout/{slug}',
  summary: 'Resolve layout slug to ID',
  description: describePublicRead(
    'Converts a human-readable layout slug (e.g., "kilter-home-board") to its numeric ID.',
  ),
  tags: ['Slug Resolution'],
  request: {
    params: z.object({
      board_name: BoardNameSchema,
      slug: z.string().describe('Layout slug'),
    }),
  },
  responses: {
    200: {
      description: 'Resolved layout ID',
      content: {
        'application/json': {
          schema: LayoutSlugResponseSchema,
        },
      },
    },
    404: {
      description: 'Layout not found',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
    429: PUBLIC_READ_RATE_LIMIT_RESPONSE,
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/{board_name}/slugs/size/{layout_id}/{slug}',
  summary: 'Resolve size slug to ID',
  description: describePublicRead('Converts a human-readable size slug to its numeric ID for a specific layout.'),
  tags: ['Slug Resolution'],
  request: {
    params: z.object({
      board_name: BoardNameSchema,
      layout_id: z.string().describe('Layout ID'),
      slug: z.string().describe('Size slug'),
    }),
  },
  responses: {
    200: {
      description: 'Resolved size ID',
      content: {
        'application/json': {
          schema: SizeSlugResponseSchema,
        },
      },
    },
    404: {
      description: 'Size not found',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
    429: PUBLIC_READ_RATE_LIMIT_RESPONSE,
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/{board_name}/slugs/sets/{layout_id}/{size_id}/{slug}',
  summary: 'Resolve set slug to IDs',
  description: describePublicRead('Converts a human-readable set slug to comma-separated set IDs.'),
  tags: ['Slug Resolution'],
  request: {
    params: z.object({
      board_name: BoardNameSchema,
      layout_id: z.string().describe('Layout ID'),
      size_id: z.string().describe('Size ID'),
      slug: z.string().describe('Set slug'),
    }),
  },
  responses: {
    200: {
      description: 'Resolved set IDs',
      content: {
        'application/json': {
          schema: SetsSlugResponseSchema,
        },
      },
    },
    404: {
      description: 'Sets not found',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
    429: PUBLIC_READ_RATE_LIMIT_RESPONSE,
  },
});

// ============================================
// Authentication Routes
// ============================================

registry.registerPath({
  method: 'post',
  path: '/api/auth/register',
  summary: 'Register a new user',
  description:
    'Creates a new user account with email and password. May require email verification depending on server configuration.',
  tags: ['Authentication'],
  request: {
    body: {
      content: {
        'application/json': {
          schema: RegisterRequestSchema,
        },
      },
    },
  },
  responses: {
    201: {
      description: 'Account created successfully',
      content: {
        'application/json': {
          schema: RegisterResponseSchema,
        },
      },
    },
    400: {
      description: 'Validation error',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
    409: {
      description: 'Email already exists',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
    429: {
      description: 'Rate limit exceeded',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/auth/verify-email',
  summary: 'Verify email address',
  description: 'Verifies a user email address using the token sent via email.',
  tags: ['Authentication'],
  request: {
    body: {
      content: {
        'application/json': {
          schema: VerifyEmailRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Email verified successfully',
      content: {
        'application/json': {
          schema: z.object({ message: z.string() }),
        },
      },
    },
    400: {
      description: 'Invalid or expired token',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/auth/resend-verification',
  summary: 'Resend verification email',
  description: 'Sends a new verification email to the specified address.',
  tags: ['Authentication'],
  request: {
    body: {
      content: {
        'application/json': {
          schema: ResendVerificationRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Verification email sent',
      content: {
        'application/json': {
          schema: z.object({ message: z.string() }),
        },
      },
    },
    429: {
      description: 'Rate limit exceeded',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

// ============================================
// Internal Routes (Authenticated)
// ============================================

registry.registerPath({
  method: 'get',
  path: '/api/internal/profile',
  summary: 'Get current user profile',
  description: 'Returns the profile of the currently authenticated user.',
  tags: ['User Profile'],
  security: [{ session: [] }],
  responses: {
    200: {
      description: 'User profile',
      content: {
        'application/json': {
          schema: UserProfileSchema,
        },
      },
    },
    401: {
      description: 'Not authenticated',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/internal/profile',
  summary: 'Update user profile',
  description: 'Updates the profile of the currently authenticated user.',
  tags: ['User Profile'],
  security: [{ session: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: UpdateProfileRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Profile updated',
      content: {
        'application/json': {
          schema: UserProfileSchema,
        },
      },
    },
    401: {
      description: 'Not authenticated',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/internal/profile/{userId}',
  summary: 'Get public user profile',
  description: 'Returns the public profile of any user by their ID.',
  tags: ['User Profile'],
  request: {
    params: z.object({
      userId: z.string().describe('User ID'),
    }),
  },
  responses: {
    200: {
      description: 'User profile',
      content: {
        'application/json': {
          schema: UserProfileSchema,
        },
      },
    },
    404: {
      description: 'User not found',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/internal/ws-auth',
  summary: 'Get WebSocket authentication token',
  description: 'Returns a JWT token for authenticating WebSocket connections. Requires an active session.',
  tags: ['WebSocket'],
  security: [{ session: [] }],
  responses: {
    200: {
      description: 'WebSocket auth token',
      content: {
        'application/json': {
          schema: WsAuthResponseSchema,
        },
      },
    },
    401: {
      description: 'Not authenticated',
      content: {
        'application/json': {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});
