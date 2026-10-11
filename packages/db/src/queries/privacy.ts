import { playlists } from '../schema/app/playlists';
import { Column, getTableName, is, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
type ViewerId = string | null | undefined;
type PrivacyResourceKind = 'board' | 'session';

export function approvedFollowerCondition(userIdColumn: SQLWrapper, viewerId: ViewerId): SQL {
  if (!viewerId) return sql`false`;
  return sql`EXISTS (SELECT 1 FROM user_follows privacy_follow WHERE privacy_follow.follower_id = ${viewerId} AND privacy_follow.following_id = ${userIdColumn})`;
}
export function userActivityVisibilityCondition(userIdColumn: SQLWrapper, viewerId: ViewerId): SQL {
  return sql`COALESCE((${viewerId ?? null} = ${userIdColumn} OR (NOT EXISTS (
    SELECT 1 FROM user_profiles privacy_profile WHERE privacy_profile.user_id = ${userIdColumn} AND privacy_profile.is_private = true
  )) OR ${approvedFollowerCondition(userIdColumn, viewerId)}), false)`;
}

export function contentVisibilityCondition(
  entityType: string | SQLWrapper,
  entityIdColumn: SQLWrapper,
  userIdColumn: SQLWrapper,
  viewerId: ViewerId,
): SQL {
  const approved = approvedFollowerCondition(userIdColumn, viewerId);
  // Social columns are enums; content_privacy also supports non-social text types.
  const entityTypeText = sql`${entityType}::text`;
  return sql`COALESCE(((${userIdColumn} IS NULL AND NOT EXISTS (SELECT 1 FROM content_privacy orphan_privacy WHERE orphan_privacy.entity_type = ${entityTypeText} AND orphan_privacy.entity_id = ${entityIdColumn})) OR ${viewerId ?? null} = ${userIdColumn} OR EXISTS (
    SELECT 1 FROM users privacy_owner
    LEFT JOIN user_profiles privacy_profile ON privacy_profile.user_id = privacy_owner.id
    LEFT JOIN content_privacy privacy_content ON privacy_content.entity_type = ${entityTypeText}
      AND privacy_content.entity_id = ${entityIdColumn} AND privacy_content.owner_id = privacy_owner.id
    WHERE privacy_owner.id = ${userIdColumn} AND CASE
      WHEN privacy_content.audience = 'only_me' THEN false
      WHEN privacy_content.audience = 'followers' THEN ${approved}
      WHEN NOT COALESCE(privacy_profile.is_private, false) THEN true
      WHEN privacy_content.audience = 'public' AND privacy_content.public_consent_revision = privacy_profile.privacy_revision THEN true
      ELSE ${approved} END
  )), false)`;
}

export function resourceAccessCondition(
  kind: PrivacyResourceKind,
  resourceIdColumn: SQLWrapper,
  viewerId: ViewerId,
  options: { allowUnlistedLink?: boolean } = {},
): SQL {
  const source =
    kind === 'board'
      ? sql`SELECT privacy_board.uuid AS id, privacy_board.owner_id AS owner_id,
      CASE WHEN privacy_board.owner_id = '00000000-0000-0000-0000-000000000000' THEN 'public' WHEN privacy_board.is_unlisted THEN 'unlisted' WHEN privacy_board.is_public THEN 'public' ELSE 'only_me' END AS audience
      FROM user_boards privacy_board WHERE privacy_board.deleted_at IS NULL`
      : sql`SELECT privacy_session.id AS id, privacy_session.created_by_user_id AS owner_id,
      CASE WHEN privacy_session.is_public THEN 'public' ELSE 'invite_only' END AS audience FROM board_sessions privacy_session`;
  const audienceIsPublic =
    options.allowUnlistedLink === false
      ? sql`COALESCE(privacy_override.audience, privacy_resource.audience) = 'public'`
      : sql`COALESCE(privacy_override.audience, privacy_resource.audience) IN ('public', 'unlisted')`;
  const resourceCondition = sql`EXISTS (SELECT 1 FROM (${source}) privacy_resource
    LEFT JOIN resource_privacy privacy_override ON privacy_override.kind = ${kind} AND privacy_override.resource_id = privacy_resource.id
    LEFT JOIN resource_grants privacy_grant ON privacy_grant.kind = ${kind} AND privacy_grant.resource_id = privacy_resource.id AND privacy_grant.user_id = ${viewerId ?? null}
    WHERE privacy_resource.id = ${resourceIdColumn} AND (
      privacy_resource.owner_id = ${viewerId ?? null} OR (
        COALESCE(privacy_grant.status, 'pending') <> 'revoked' AND (
          ${audienceIsPublic} OR (
            COALESCE(privacy_override.audience, privacy_resource.audience) <> 'only_me' AND (
              privacy_grant.status = 'approved' OR ${kind === 'session' ? sql`(privacy_override.resource_id IS NULL AND EXISTS (SELECT 1 FROM board_session_participants legacy_participant WHERE legacy_participant.session_id = privacy_resource.id AND legacy_participant.user_id = ${viewerId ?? null}))` : sql`false`} OR (
                (COALESCE(privacy_override.audience, privacy_resource.audience) = 'followers' OR COALESCE(privacy_override.inherit_followers, false))
                AND ${approvedFollowerCondition(sql`privacy_resource.owner_id`, viewerId)}
              )
            )
          )
        )
      )
    ))`;
  return kind === 'session'
    ? sql`(${resourceCondition} AND ${sessionBoardAccessCondition(resourceIdColumn, viewerId)})`
    : resourceCondition;
}

/** All current and legacy references must continue to restrict the session. */
function sessionBoardReferences(sessionIdColumn: SQLWrapper, viewerId: ViewerId): SQL {
  // Match the shared board-path parsers: repeated/leading slashes and an optional
  // two-letter locale are accepted. Legacy path-only sessions still name a wall.
  const pathSource = sql`SELECT privacy_path_source.id,
    regexp_replace(regexp_replace(trim(both '/' from privacy_path_source.board_path), '/+', '/', 'g'), '^[a-z]{2}/', '') AS path
    FROM board_sessions privacy_path_source`;
  return sql`(
      SELECT privacy_parent_session.board_id FROM board_sessions privacy_parent_session
      WHERE privacy_parent_session.id = ${sessionIdColumn} AND privacy_parent_session.board_id IS NOT NULL
      UNION SELECT privacy_parent_membership.board_id FROM session_boards privacy_parent_membership
      WHERE privacy_parent_membership.session_id = ${sessionIdColumn}
      UNION SELECT privacy_named_board.id FROM (${pathSource}) privacy_named_session
      LEFT JOIN user_boards privacy_named_board ON privacy_named_board.slug = split_part(privacy_named_session.path, '/', 2)
        AND privacy_named_board.deleted_at IS NULL
      WHERE privacy_named_session.id = ${sessionIdColumn} AND split_part(privacy_named_session.path, '/', 1) = 'b'
      UNION SELECT privacy_spray_board.id FROM (${pathSource}) privacy_spray_session
      LEFT JOIN spray_walls privacy_spray_wall ON privacy_spray_wall.layout_id = CASE
        WHEN split_part(privacy_spray_session.path, '/', 2) ~ '^[0-9]{1,18}$'
        THEN split_part(privacy_spray_session.path, '/', 2)::bigint ELSE NULL END
        AND privacy_spray_wall.deleted_at IS NULL
      LEFT JOIN user_boards privacy_spray_board ON privacy_spray_board.uuid = privacy_spray_wall.board_uuid
        AND privacy_spray_board.deleted_at IS NULL
        AND (privacy_spray_wall.hidden_at IS NULL OR privacy_spray_board.owner_id = ${viewerId ?? null})
      WHERE privacy_spray_session.id = ${sessionIdColumn} AND split_part(privacy_spray_session.path, '/', 1) = 'spray'
    )`;
}

/** A session link never grants access to an attached private or unlisted board. */
export function sessionBoardAccessCondition(sessionIdColumn: SQLWrapper, viewerId: ViewerId): SQL {
  return sql`NOT EXISTS (
    SELECT 1 FROM ${sessionBoardReferences(sessionIdColumn, viewerId)} privacy_parent_refs
    LEFT JOIN user_boards privacy_parent_board ON privacy_parent_board.id = privacy_parent_refs.board_id
    WHERE privacy_parent_board.id IS NULL OR NOT ${resourceAccessCondition('board', sql`privacy_parent_board.uuid`, viewerId, { allowUnlistedLink: false })}
  )`;
}

/** Distances and coordinates must respect every referenced board's location policy. */
export function sessionBoardLocationCondition(sessionIdColumn: SQLWrapper, viewerId: ViewerId): SQL {
  return sql`NOT EXISTS (
    SELECT 1 FROM ${sessionBoardReferences(sessionIdColumn, viewerId)} privacy_parent_refs
    LEFT JOIN user_boards privacy_parent_board ON privacy_parent_board.id = privacy_parent_refs.board_id
    WHERE privacy_parent_board.id IS NULL
      OR NOT ${resourceAccessCondition('board', sql`privacy_parent_board.uuid`, viewerId, { allowUnlistedLink: false })}
      OR NOT ${resourceLocationCondition(sql`privacy_parent_board.uuid`, viewerId)}
  )`;
}

/** Separate location policy; knowledge of a board UUID alone cannot reveal its address. */
export function resourceLocationCondition(boardUuid: SQLWrapper, viewerId: ViewerId): SQL {
  return sql`EXISTS (SELECT 1 FROM user_boards privacy_location_board
    LEFT JOIN resource_privacy privacy_location_override ON privacy_location_override.kind = 'board'
      AND privacy_location_override.resource_id = privacy_location_board.uuid
    LEFT JOIN resource_grants privacy_location_grant ON privacy_location_grant.kind = 'board'
      AND privacy_location_grant.resource_id = privacy_location_board.uuid AND privacy_location_grant.user_id = ${viewerId ?? null}
    WHERE privacy_location_board.uuid = ${boardUuid} AND privacy_location_board.deleted_at IS NULL
      AND (privacy_location_board.owner_id = ${viewerId ?? null} OR (
        ${resourceAccessCondition('board', sql`privacy_location_board.uuid`, viewerId)} AND CASE
          COALESCE(privacy_location_override.location_audience, CASE WHEN privacy_location_board.hide_location THEN 'only_me' ELSE 'public' END)
          WHEN 'public' THEN true
          WHEN 'followers' THEN ${approvedFollowerCondition(sql`privacy_location_board.owner_id`, viewerId)}
          WHEN 'members' THEN privacy_location_grant.status = 'approved'
          ELSE false END
      )))`;
}

/**
 * Board types with no reference set at all.
 *
 * A snapshot artifact goes to a PUBLIC bucket under guessable keys
 * (`<prefix>/<board>/<layout>/*.db`) and carries every reference climb of that
 * `(board_type, layout_id)` partition. A spray wall's partition is one
 * climber's private wall — an explicitly private-by-default surface whose photo
 * is behind a 15-minute presigned URL — so publishing its climbs would hand out
 * exactly the data the private bucket exists to withhold.
 *
 * This is an exclusion by board TYPE rather than a per-wall visibility check on
 * purpose: `is_public` on a wall governs who may view it in the app, and a
 * nightly dump of every public wall's climbs to an unauthenticated bucket is not
 * something a climber opted into by sharing a link. The row predicate below
 * cannot express it either: a published, listed spray climb passes it.
 *
 * One set for the three readers that must agree: the per-layout snapshot export,
 * the catalogue export, and the `REFERENCE` sync stream.
 */
export const REFERENCE_EXCLUDED_BOARD_TYPES: ReadonlySet<string> = new Set(['spray']);

const SAFE_SQL_ALIAS = /^[a-z_][a-z0-9_]*$/;
const FIRST_ASCENT_CLIMB_ALIAS = 'fa_reference_climb';

/**
 * The predicates below are raw text, so the alias is the one piece a caller
 * supplies. Every caller passes a literal; this keeps a future caller from
 * interpolating anything that is not a plain identifier.
 */
function safeSqlAlias(alias: string): string {
  if (!SAFE_SQL_ALIAS.test(alias) || alias === FIRST_ASCENT_CLIMB_ALIAS) {
    throw new Error(`Refusing to build a climb audience predicate with the alias: ${alias}`);
  }
  return alias;
}

/**
 * True for a reference climb: published and listed. Parenthesized, so it can be
 * negated or ANDed as it is.
 *
 * This is the publication rule. A climb that is published and listed is public
 * to everyone, signed in or not, whoever set it: no account privacy setting,
 * item audience or deleted-account record applies to it. A draft or an unlisted
 * climb is not public at all. It goes to its owner alone (the Boardsesh
 * `user_id` on the row), and one with no owner goes to no one.
 *
 * So this is the whole test, with no owner and no viewer in it. The snapshot
 * artifact, the catalogue export and the `REFERENCE` sync stream carry exactly
 * these climbs, plus their stats and grades.
 *
 * `alias` names the `board_climbs` row: a table alias, or `board_climbs` itself
 * for an unaliased FROM. Combine with {@link REFERENCE_EXCLUDED_BOARD_TYPES},
 * which this row predicate does not cover.
 *
 * Both tests are two-valued on purpose. `is_draft` is nullable and NULL is not a
 * draft; `is_listed` is nullable in the schema and only TRUE is listed. Written
 * `IS NOT TRUE` / `IS TRUE` the predicate is never NULL, so `NOT` of it is its
 * exact complement and every row is on one side or the other.
 *
 * It is also the membership test of `trg_board_climbs_reference_membership`,
 * the trigger that tells devices a climb left the set. Change one and change
 * the other.
 *
 * Raw text on purpose. The snapshot exports build `sqlClient.unsafe` strings and
 * the sync resolvers build drizzle `sql`, and text is the only form both can
 * share. One definition is the point: the artifact a phone imports and the
 * `REFERENCE` stream that resumes from its watermark must select the same rows,
 * or a row inside the watermark that only one of them carries is lost for good.
 */
export function publicReferenceClimbSql(alias: string): string {
  const climb = safeSqlAlias(alias);
  return `(${climb}.is_draft IS NOT TRUE AND ${climb}.is_listed IS TRUE)`;
}

/**
 * True for a climb on a board type that has a reference set at all. For a query
 * that spans board types; a reader that already holds one board type checks
 * {@link REFERENCE_EXCLUDED_BOARD_TYPES} directly.
 */
export function referenceBoardTypeSql(alias: string): string {
  const climb = safeSqlAlias(alias);
  const excluded = [...REFERENCE_EXCLUDED_BOARD_TYPES].map((boardType) => {
    if (!SAFE_SQL_ALIAS.test(boardType)) {
      throw new Error(`Refusing to inline the board type as a SQL literal: ${boardType}`);
    }
    return `'${boardType}'`;
  });
  // `NOT IN ()` is a syntax error, and an empty set excludes nothing.
  if (excluded.length === 0) return 'TRUE';
  return `${climb}.board_type NOT IN (${excluded.join(', ')})`;
}

/**
 * One first-ascent column of a stats row, as every board sync stream and the
 * snapshot artifact ship it: the stored value for a manufacturer climb, NULL for
 * a climb that has, or once had, a Boardsesh author.
 *
 * The stored credit of a manufacturer climb is upstream catalogue data. On a
 * Boardsesh climb the name comes from a Boardsesh tick, and a tick stays under
 * its author's privacy settings even though the climb is public: who may read
 * the name depends on the viewer (see {@link privateSafeFirstAscentName}). An
 * artifact has no viewer and is never recalled, and a device keeps a synced row
 * across privacy changes, so neither may carry it. One viewer-independent rule
 * for every stream is also what makes an artifact and a `REFERENCE` pull the
 * same column for column.
 *
 * `statsAlias` names the `board_climb_stats` row. Returns a select-list item
 * aliased to the column's own name. Raw text for the same reason as
 * {@link publicReferenceClimbSql}.
 *
 * A scalar subquery on purpose, and not `CASE WHEN EXISTS (…)`. `uuid` is the
 * primary key of `board_climbs`, so the subquery yields the stats row's own
 * value for the one matching climb and NULL when none matches, and it runs as
 * one primary-key probe per stats row. Postgres may instead turn an `EXISTS` in
 * a select list into a hash of every qualifying climb, built by reading the
 * whole table once per statement: on a sync page that is a full scan of
 * `board_climbs` to serve 500 rows.
 */
export function referenceFirstAscentSql(statsAlias: string, column: 'fa_username' | 'fa_at'): string {
  const stats = safeSqlAlias(statsAlias);
  const climb = FIRST_ASCENT_CLIMB_ALIAS;
  return `(SELECT ${stats}.${column} FROM board_climbs ${climb} WHERE ${climb}.uuid = ${stats}.climb_uuid AND ${climb}.board_type = ${stats}.board_type AND ${climb}.user_id IS NULL AND NOT ${climb}.is_boardsesh_authored) AS ${column}`;
}

/**
 * The draft rule for the reads outside the board sync: an unpublished climb is
 * returned to its owner and to nobody else, whatever the owner's account or
 * item audience says. The owner is the Boardsesh `user_id` on the climb, so a
 * draft that has none is returned to no one. The board sync and the snapshot
 * exports apply the same rule through {@link publicReferenceClimbSql}.
 *
 * It narrows {@link contentVisibilityCondition} and never replaces it: that
 * condition has no draft term, and on its own it shows a public account's draft
 * to every viewer and an ownerless draft to everyone. AND the two.
 *
 * Both comparisons are NULL-safe. `is_draft` is nullable and NULL is not a
 * draft; `user_id = viewer` is NULL for an ownerless row or an anonymous
 * viewer, and the COALESCE keeps that a plain false so the condition can sit
 * under a NOT.
 */
export function climbDraftVisibilityCondition(
  climb: { isDraft: SQLWrapper; userId: SQLWrapper },
  viewerId: ViewerId,
): SQL {
  return sql`(${climb.isDraft} IS NOT TRUE OR COALESCE(${climb.userId} = ${viewerId ?? null}, false))`;
}

/**
 * Whether this viewer may be handed the climb at all: the account and item
 * audience ({@link contentVisibilityCondition}) and the draft rule
 * ({@link climbDraftVisibilityCondition}) together. Use it wherever a query
 * returns a climb, or anything derived from one, without its own
 * `is_draft = false` filter.
 */
export function climbVisibilityCondition(
  climb: { uuid: SQLWrapper; userId: SQLWrapper; isDraft: SQLWrapper },
  viewerId: ViewerId,
): SQL {
  return sql`(${contentVisibilityCondition('climb', climb.uuid, climb.userId, viewerId)} AND ${climbDraftVisibilityCondition(climb, viewerId)})`;
}

/** Applies the climb's visibility, the draft rule included, to its stats, grades and other reference rows. */
export function climbReferenceVisibilityCondition(
  reference: { boardType: SQLWrapper; climbUuid: SQLWrapper },
  viewerId: ViewerId,
): SQL {
  return sql`EXISTS (SELECT 1 FROM board_climbs privacy_reference_climb
    WHERE privacy_reference_climb.board_type = ${reference.boardType} AND privacy_reference_climb.uuid = ${reference.climbUuid}
    AND ${climbVisibilityCondition({ uuid: sql`privacy_reference_climb.uuid`, userId: sql`privacy_reference_climb.user_id`, isDraft: sql`privacy_reference_climb.is_draft` }, viewerId)})`;
}

/** Public numeric aggregates retain private ticks; first-ascent names are a separate projection. */
export function privateSafeFirstAscentName(
  stats: { boardType: SQLWrapper; climbUuid: SQLWrapper; angle: SQLWrapper; username: SQLWrapper },
  viewerId: ViewerId,
): SQL<string | null> {
  // Drizzle strips Column table qualifiers inside a single-table SELECT list.
  // These columns are correlated into nested queries, so keep their scope.
  const qualify = (column: SQLWrapper): SQLWrapper =>
    is(column, Column) ? sql`${sql.identifier(getTableName(column.table))}.${sql.identifier(column.name)}` : column;
  const correlated = {
    boardType: qualify(stats.boardType),
    climbUuid: qualify(stats.climbUuid),
    angle: qualify(stats.angle),
    username: qualify(stats.username),
  };
  const tickVisible = sql`(${contentVisibilityCondition('tick', sql`privacy_fa_tick.uuid`, sql`privacy_fa_tick.user_id`, viewerId)}
    AND (privacy_fa_tick.user_id = ${viewerId ?? null} OR (
      (privacy_fa_tick.session_id IS NULL OR ${resourceAccessCondition('session', sql`privacy_fa_tick.session_id`, viewerId)})
      AND (privacy_fa_tick.board_id IS NULL OR ${resourceAccessCondition('board', sql`(SELECT uuid FROM user_boards privacy_fa_board WHERE privacy_fa_board.id = privacy_fa_tick.board_id)`, viewerId)})
    )))`;
  // Never expose the stored Boardsesh FA string: it can outlive a deleted tick,
  // account restriction or profile rename while asynchronous recomputation runs.
  return sql<string | null>`CASE WHEN EXISTS (
    SELECT 1 FROM board_climbs privacy_fa_owned WHERE privacy_fa_owned.board_type = ${correlated.boardType}
      AND privacy_fa_owned.uuid = ${correlated.climbUuid}
      AND (privacy_fa_owned.user_id IS NOT NULL OR privacy_fa_owned.is_boardsesh_authored)
  ) THEN (
    SELECT CASE WHEN ${tickVisible} THEN COALESCE(privacy_fa_profile.display_name, privacy_fa_user.name) ELSE NULL END
    FROM boardsesh_ticks privacy_fa_tick
    JOIN users privacy_fa_user ON privacy_fa_user.id = privacy_fa_tick.user_id
    LEFT JOIN user_profiles privacy_fa_profile ON privacy_fa_profile.user_id = privacy_fa_tick.user_id
    WHERE privacy_fa_tick.board_type = ${correlated.boardType} AND privacy_fa_tick.climb_uuid = ${correlated.climbUuid}
      AND privacy_fa_tick.angle = ${correlated.angle} AND privacy_fa_tick.status IN ('flash', 'send')
      AND privacy_fa_tick.kilter_detached_at IS NULL
    ORDER BY privacy_fa_tick.climbed_at ASC, privacy_fa_tick.id ASC LIMIT 1
  ) ELSE ${correlated.username} END`;
}

/** Owner/member grants survive account changes; only-me content is owner-only. */
export function playlistVisibilityCondition(
  viewerId: string | null | undefined,
  playlist: { id: SQLWrapper; uuid: SQLWrapper; isPublic: SQLWrapper } = playlists,
): SQL {
  return sql`(
    EXISTS (SELECT 1 FROM playlist_ownership privacy_member
      WHERE privacy_member.playlist_id = ${playlist.id} AND privacy_member.user_id = ${viewerId ?? null}
      AND (privacy_member.role = 'owner' OR NOT EXISTS (
        SELECT 1 FROM content_privacy private_item WHERE private_item.entity_type = 'playlist'
        AND private_item.entity_id = ${playlist.uuid} AND private_item.audience = 'only_me'
      )))
    OR EXISTS (SELECT 1 FROM playlist_ownership playlist_privacy_owner
      WHERE playlist_privacy_owner.playlist_id = ${playlist.id} AND playlist_privacy_owner.role = 'owner'
      AND (${playlist.isPublic} OR EXISTS (
        SELECT 1 FROM content_privacy shared_item WHERE shared_item.entity_type = 'playlist'
        AND shared_item.entity_id = ${playlist.uuid} AND shared_item.audience <> 'only_me'
      ))
      AND ${contentVisibilityCondition('playlist', playlist.uuid, sql`playlist_privacy_owner.user_id`, viewerId)}
    )
  )`;
}
export const playlistPrivacyCondition = playlistVisibilityCondition;
