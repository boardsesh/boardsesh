import {
  pgTable,
  bigserial,
  text,
  integer,
  timestamp,
  boolean,
  index,
  uniqueIndex,
  unique,
  check,
  pgEnum,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from '../auth/users';

// ============================================
// Enums
// ============================================

export const communityRoleTypeEnum = pgEnum('community_role_type', ['admin', 'community_leader', 'tester']);

export const proposalTypeEnum = pgEnum('proposal_type', ['grade', 'classic', 'benchmark']);

export const proposalStatusEnum = pgEnum('proposal_status', ['open', 'approved', 'rejected', 'superseded']);

// ============================================
// Tables
// ============================================

export const communityRoles = pgTable(
  'community_roles',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: text('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    role: communityRoleTypeEnum('role').notNull(),
    boardType: text('board_type'), // nullable = global role
    grantedBy: text('granted_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    userRoleUnique: unique('community_roles_user_role_board_idx')
      .on(table.userId, table.role, table.boardType)
      .nullsNotDistinct(),
    boardTypeIdx: index('community_roles_board_type_idx').on(table.boardType),
  }),
);

export const communitySettings = pgTable(
  'community_settings',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    scope: text('scope').notNull(), // 'global', 'board', 'climb'
    scopeKey: text('scope_key').notNull(), // '' for global, boardType for board, climbUuid for climb
    key: text('key').notNull(),
    value: text('value').notNull(),
    setBy: text('set_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    scopeKeyIdx: uniqueIndex('community_settings_scope_key_idx').on(table.scope, table.scopeKey, table.key),
  }),
);

export const climbProposals = pgTable(
  'climb_proposals',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    uuid: text('uuid').notNull().unique(),
    climbUuid: text('climb_uuid').notNull(),
    boardType: text('board_type').notNull(),
    angle: integer('angle'), // nullable for classic proposals
    proposerId: text('proposer_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    type: proposalTypeEnum('type').notNull(),
    proposedValue: text('proposed_value').notNull(),
    currentValue: text('current_value').notNull(),
    status: proposalStatusEnum('status').notNull().default('open'),
    reason: text('reason'),
    resolvedAt: timestamp('resolved_at'),
    resolvedBy: text('resolved_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    climbAngleTypeIdx: index('climb_proposals_climb_angle_type_idx').on(table.climbUuid, table.angle, table.type),
    statusIdx: index('climb_proposals_status_idx').on(table.status),
    proposerIdx: index('climb_proposals_proposer_idx').on(table.proposerId),
    boardTypeIdx: index('climb_proposals_board_type_idx').on(table.boardType),
    createdAtIdx: index('climb_proposals_created_at_idx').on(table.createdAt),
  }),
);

export const proposalVotes = pgTable(
  'proposal_votes',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    proposalId: bigserial('proposal_id', { mode: 'number' })
      .references(() => climbProposals.id, { onDelete: 'cascade' })
      .notNull(),
    userId: text('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    value: integer('value').notNull(), // +1 or -1
    weight: integer('weight').notNull().default(1),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    uniqueVote: uniqueIndex('proposal_votes_unique_user_proposal').on(table.proposalId, table.userId),
    proposalIdx: index('proposal_votes_proposal_idx').on(table.proposalId),
    valueCheck: check('proposal_vote_value_check', sql`${table.value} IN (1, -1)`),
  }),
);

export const climbCommunityStatus = pgTable(
  'climb_community_status',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    climbUuid: text('climb_uuid').notNull(),
    boardType: text('board_type').notNull(),
    angle: integer('angle').notNull(),
    communityGrade: text('community_grade'), // nullable
    isBenchmark: boolean('is_benchmark').notNull().default(false),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
    lastProposalId: bigserial('last_proposal_id', { mode: 'number' }).references(() => climbProposals.id, {
      onDelete: 'set null',
    }),
  },
  (table) => ({
    uniqueClimbAngle: uniqueIndex('climb_community_status_unique_idx').on(
      table.climbUuid,
      table.boardType,
      table.angle,
    ),
  }),
);

export const climbClassicStatus = pgTable(
  'climb_classic_status',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    climbUuid: text('climb_uuid').notNull(),
    boardType: text('board_type').notNull(),
    isClassic: boolean('is_classic').notNull().default(false),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
    lastProposalId: bigserial('last_proposal_id', { mode: 'number' }).references(() => climbProposals.id, {
      onDelete: 'set null',
    }),
  },
  (table) => ({
    uniqueClimb: uniqueIndex('climb_classic_status_unique_idx').on(table.climbUuid, table.boardType),
  }),
);

// ============================================
// Inferred Types
// ============================================

export type CommunityRole = typeof communityRoles.$inferSelect;
export type NewCommunityRole = typeof communityRoles.$inferInsert;

export type CommunitySetting = typeof communitySettings.$inferSelect;
export type NewCommunitySetting = typeof communitySettings.$inferInsert;

export type ClimbProposal = typeof climbProposals.$inferSelect;
export type NewClimbProposal = typeof climbProposals.$inferInsert;

export type ProposalVote = typeof proposalVotes.$inferSelect;
export type NewProposalVote = typeof proposalVotes.$inferInsert;

export type ClimbCommunityStatusRow = typeof climbCommunityStatus.$inferSelect;
export type NewClimbCommunityStatus = typeof climbCommunityStatus.$inferInsert;

export type ClimbClassicStatusRow = typeof climbClassicStatus.$inferSelect;
export type NewClimbClassicStatus = typeof climbClassicStatus.$inferInsert;
