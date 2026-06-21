/**
 * OpenAPI Registry and Schema Definitions
 *
 * This file contains all OpenAPI schema definitions for the REST API.
 * Schemas are defined using zod-to-openapi to ensure documentation
 * stays in sync with actual validation.
 *
 * To add documentation for a new endpoint:
 * 1. Define request/response schemas here using extendZodWithOpenApi
 * 2. Register the endpoint in openapi-routes.ts
 */

import { extendZodWithOpenApi, OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

// Extend Zod with OpenAPI capabilities
extendZodWithOpenApi(z);

// Create the OpenAPI registry
export const registry = new OpenAPIRegistry();

// ============================================
// Common Schemas
// ============================================

export const ErrorResponseSchema = z
  .object({
    error: z.string().describe('Error message describing what went wrong'),
  })
  .openapi('ErrorResponse');

export const BoardNameSchema = z
  .enum(['kilter', 'tension'])
  .describe('The type of climbing board')
  .openapi('BoardName');

// ============================================
// Grade Schemas
// ============================================

export const GradeSchema = z
  .object({
    difficulty_id: z.number().describe('Numeric difficulty identifier'),
    difficulty_name: z.string().describe('Human-readable grade name (e.g., "V5", "6B+")'),
  })
  .openapi('Grade');

export const GradesResponseSchema = z.array(GradeSchema).openapi('GradesResponse');

// ============================================
// Climb Schemas
// ============================================

export const LitUpHoldsMapSchema = z
  .record(z.string(), z.number())
  .describe('Map of hold IDs to their lit-up state codes')
  .openapi('LitUpHoldsMap');

export const ClimbSchema = z
  .object({
    uuid: z.string().describe('Unique identifier for the climb'),
    layoutId: z.number().nullable().optional().describe('Layout the climb belongs to'),
    setter_username: z.string().describe('Username of the person who set this climb'),
    name: z.string().describe('Name of the climb'),
    description: z.string().describe('Description or notes about the climb'),
    frames: z.string().describe('Encoded hold positions and colors'),
    angle: z.number().describe('Board angle in degrees'),
    ascensionist_count: z.number().describe('Number of people who have completed this climb'),
    difficulty: z.string().describe('Difficulty grade of the climb'),
    quality_average: z.string().describe('Average quality rating'),
    stars: z.number().describe('Star rating (0-5), rounded from quality_average'),
    difficulty_error: z.string().describe('Difficulty uncertainty/spread'),
    litUpHoldsMap: LitUpHoldsMapSchema.describe('Map of holds to light up on the board'),
    mirrored: z.boolean().optional().describe('Whether the climb is displayed mirrored'),
    benchmark_difficulty: z.string().nullable().describe('Official benchmark difficulty if set'),
    userAscents: z.number().optional().describe('Number of times the current user has sent this climb'),
    userAttempts: z.number().optional().describe('Number of times the current user has attempted this climb'),
  })
  .openapi('Climb');

export const ClimbSearchResultSchema = z
  .object({
    climbs: z.array(ClimbSchema).describe('Array of climbs matching the search criteria'),
    totalCount: z.number().describe('Total number of climbs matching the criteria'),
    hasMore: z.boolean().describe('Whether there are more results available'),
  })
  .openapi('ClimbSearchResult');

// ============================================
// Climb Stats Schema
// ============================================

export const ClimbStatsSchema = z
  .object({
    angle: z.number().describe('Board angle'),
    ascensionist_count: z.number().describe('Number of ascents at this angle'),
    difficulty: z.string().nullable().describe('Difficulty at this angle'),
    quality_average: z.number().nullable().describe('Average quality rating'),
    benchmark_difficulty: z.string().nullable().describe('Benchmark difficulty if set'),
  })
  .openapi('ClimbStats');

export const ClimbStatsResponseSchema = z.array(ClimbStatsSchema).openapi('ClimbStatsResponse');

// ============================================
// Setter Schema
// ============================================

export const SetterSchema = z
  .object({
    username: z.string().describe('Setter username'),
    count: z.number().describe('Number of climbs set'),
  })
  .openapi('Setter');

export const SettersResponseSchema = z.array(SetterSchema).openapi('SettersResponse');

// ============================================
// Heatmap Schema
// ============================================

export const HeatmapDataSchema = z
  .record(z.string(), z.number())
  .describe('Map of hold IDs to usage frequency')
  .openapi('HeatmapData');

// ============================================
// Angle Schema
// ============================================

export const AngleSchema = z
  .object({
    angle: z.number().describe('Board angle in degrees'),
  })
  .openapi('Angle');

export const AnglesResponseSchema = z.array(AngleSchema).openapi('AnglesResponse');

// ============================================
// Slug Resolution Schemas
// ============================================

export const LayoutSlugResponseSchema = z
  .object({
    layoutId: z.number().describe('Resolved numeric layout ID'),
    layoutName: z.string().describe('Layout name'),
  })
  .openapi('LayoutSlugResponse');

export const SizeSlugResponseSchema = z
  .object({
    sizeId: z.number().describe('Resolved numeric size ID'),
    sizeName: z.string().describe('Size name'),
    sizeDescription: z.string().describe('Size description'),
  })
  .openapi('SizeSlugResponse');

export const SetsSlugResponseSchema = z
  .object({
    setIds: z.string().describe('Comma-separated set IDs'),
    setNames: z.array(z.string()).describe('Array of set names'),
  })
  .openapi('SetsSlugResponse');

// ============================================
// Authentication Schemas
// ============================================

export const RegisterRequestSchema = z
  .object({
    email: z.string().email().describe('User email address'),
    password: z.string().min(8).max(128).describe('Password (8-128 characters)'),
    name: z.string().min(1).max(100).optional().describe('Display name'),
  })
  .openapi('RegisterRequest');

export const RegisterResponseSchema = z
  .object({
    message: z.string().describe('Success message'),
    requiresVerification: z.boolean().describe('Whether email verification is required'),
    emailSent: z.boolean().optional().describe('Whether verification email was sent'),
  })
  .openapi('RegisterResponse');

export const VerifyEmailRequestSchema = z
  .object({
    token: z.string().describe('Email verification token'),
  })
  .openapi('VerifyEmailRequest');

export const ResendVerificationRequestSchema = z
  .object({
    email: z.string().email().describe('Email address to resend verification to'),
  })
  .openapi('ResendVerificationRequest');

// ============================================
// Aurora Proxy Schemas
// ============================================

export const AuroraLoginRequestSchema = z
  .object({
    username: z.string().describe('Aurora board username'),
    password: z.string().describe('Aurora board password'),
  })
  .openapi('AuroraLoginRequest');

export const AuroraLoginResponseSchema = z
  .object({
    token: z.string().describe('Authentication token for Aurora API'),
    user_id: z.number().describe('Aurora user ID'),
    username: z.string().describe('Aurora username'),
  })
  .openapi('AuroraLoginResponse');

export const SaveAscentRequestSchema = z
  .object({
    token: z.string().describe('Aurora authentication token'),
    options: z.object({
      climb_uuid: z.string().describe('UUID of the climb'),
      angle: z.number().describe('Board angle'),
      is_mirror: z.boolean().describe('Whether climb was mirrored'),
      quality: z.number().min(0).max(3).describe('Quality rating (0-3)'),
      difficulty: z.number().describe('Difficulty rating'),
      comment: z.string().optional().describe('Optional comment'),
      climbed_at: z.string().describe('ISO timestamp of when climb was completed'),
    }),
  })
  .openapi('SaveAscentRequest');

// ============================================
// Hold Classification Schemas
// ============================================

export const HoldTypeSchema = z
  .enum(['jug', 'sloper', 'pinch', 'crimp', 'pocket'])
  .describe('Type of climbing hold')
  .openapi('HoldType');

export const HoldClassificationSchema = z
  .object({
    boardType: BoardNameSchema,
    layoutId: z.number().describe('Layout ID'),
    sizeId: z.number().describe('Size ID'),
    holdId: z.number().describe('Hold ID'),
    holdType: HoldTypeSchema,
    handRating: z.number().min(1).max(5).describe('Hand comfort rating (1-5)'),
    footRating: z.number().min(1).max(5).describe('Foot comfort rating (1-5)'),
    pullDirection: z.number().min(0).max(360).describe('Optimal pull direction in degrees'),
  })
  .openapi('HoldClassification');

// ============================================
// Profile Schemas
// ============================================

export const UserProfileSchema = z
  .object({
    id: z.string().describe('User ID'),
    displayName: z.string().nullable().describe('Display name'),
    avatarUrl: z.string().nullable().describe('Avatar image URL'),
    instagramUrl: z.string().nullable().describe('Instagram profile URL'),
  })
  .openapi('UserProfile');

export const UpdateProfileRequestSchema = z
  .object({
    displayName: z.string().max(100).optional().describe('New display name'),
    avatarUrl: z.string().url().optional().describe('New avatar URL'),
    instagramUrl: z.string().url().optional().describe('Instagram profile URL'),
  })
  .openapi('UpdateProfileRequest');

// ============================================
// WebSocket Auth Schema
// ============================================

export const WsAuthResponseSchema = z
  .object({
    token: z.string().describe('JWT token for WebSocket authentication'),
    expiresIn: z.number().describe('Token expiration time in seconds'),
  })
  .openapi('WsAuthResponse');

// Register all schemas
registry.register('ErrorResponse', ErrorResponseSchema);
registry.register('BoardName', BoardNameSchema);
registry.register('Grade', GradeSchema);
registry.register('Climb', ClimbSchema);
registry.register('ClimbSearchResult', ClimbSearchResultSchema);
registry.register('ClimbStats', ClimbStatsSchema);
registry.register('Setter', SetterSchema);
registry.register('Angle', AngleSchema);
registry.register('HoldType', HoldTypeSchema);
registry.register('HoldClassification', HoldClassificationSchema);
registry.register('UserProfile', UserProfileSchema);
