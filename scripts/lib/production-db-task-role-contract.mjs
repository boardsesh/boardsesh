const role = (contract) => Object.freeze(contract);

export const PRODUCTION_DATABASE_NAME = 'railway';
export const PRODUCTION_SCHEMA_NAME = 'public';
export const PRODUCTION_MANAGED_SCHEMAS = Object.freeze(['public', 'drizzle']);
export const MIGRATION_OWNER_ROLE = 'boardsesh_owner';

export const PRODUCTION_TASK_ROLES = Object.freeze([
  role({
    name: 'boardsesh_migrator',
    applicationName: 'boardsesh-ci-migrate',
    githubSecret: 'MIGRATION_DATABASE_DIRECT_URL',
    connectionLimit: 2,
    databasePrivileges: ['CONNECT'],
    schemaPrivileges: [],
    readOnly: false,
    setOnlyRole: MIGRATION_OWNER_ROLE,
    evidence: ['packages/db/scripts/migrate.ts', 'packages/db/scripts/migration-owner-role.ts'],
  }),
  role({
    name: 'boardsesh_snapshot_exporter',
    applicationName: 'boardsesh-ci-snapshot-export',
    githubSecret: 'SNAPSHOT_DATABASE_DIRECT_URL',
    connectionLimit: 10,
    databasePrivileges: ['CONNECT'],
    schemaPrivileges: ['USAGE'],
    readOnly: true,
    setOnlyRole: null,
    evidence: [
      'packages/backend/src/scripts/export-board-snapshots.ts',
      'packages/backend/src/scripts/export-board-catalog.ts',
      'packages/db/src/catalog-snapshot.ts',
      'packages/db/src/client/postgres.ts',
    ],
  }),
  role({
    name: 'boardsesh_climb_grades_refresh',
    applicationName: 'boardsesh-ci-climb-grades',
    githubSecret: 'CLIMB_GRADES_DATABASE_DIRECT_URL',
    connectionLimit: 2,
    databasePrivileges: ['CONNECT', 'TEMPORARY'],
    schemaPrivileges: ['USAGE'],
    readOnly: false,
    setOnlyRole: null,
    evidence: ['packages/db/scripts/refresh-climb-grades.ts', 'packages/db/src/queries/grade-model'],
  }),
  role({
    name: 'boardsesh_content_model_refresh',
    applicationName: 'boardsesh-ci-content-model',
    githubSecret: 'CONTENT_MODEL_DATABASE_DIRECT_URL',
    connectionLimit: 2,
    databasePrivileges: ['CONNECT'],
    schemaPrivileges: ['USAGE'],
    readOnly: false,
    setOnlyRole: null,
    evidence: [
      'packages/db/scripts/extract-training-matrix.ts',
      'packages/db/scripts/load-content-model.ts',
      'packages/db/scripts/load-similarity.ts',
    ],
  }),
  role({
    name: 'boardsesh_hold_features_refresh',
    applicationName: 'boardsesh-ci-hold-features',
    githubSecret: 'HOLD_FEATURES_DATABASE_DIRECT_URL',
    connectionLimit: 2,
    databasePrivileges: ['CONNECT'],
    schemaPrivileges: ['USAGE'],
    readOnly: false,
    setOnlyRole: null,
    evidence: ['packages/db/scripts/refresh-hold-features.ts'],
  }),
  role({
    name: 'boardsesh_recommendations_refresh',
    applicationName: 'boardsesh-ci-recommendations',
    githubSecret: 'RECOMMENDATIONS_DATABASE_DIRECT_URL',
    connectionLimit: 2,
    databasePrivileges: ['CONNECT'],
    schemaPrivileges: ['USAGE'],
    readOnly: false,
    setOnlyRole: null,
    evidence: [
      'packages/db/scripts/refresh-recommendations.ts',
      'packages/db/src/queries/recommendations',
      'packages/db/src/queries/climb-stats/history-snapshot.ts',
      'packages/db/src/queries/sync/weekly-gate.ts',
      'packages/db/drizzle/0146_offline_sync_followups.sql',
    ],
  }),
]);

const grants = [];
function grant(roleName, privileges, relations, evidence) {
  for (const relation of relations) {
    grants.push(
      Object.freeze({
        role: roleName,
        relation,
        privileges: [...privileges].sort((left, right) => left.localeCompare(right)),
        evidence,
      }),
    );
  }
}

grant(
  'boardsesh_snapshot_exporter',
  ['SELECT'],
  ['board_climbs', 'board_climb_stats', 'board_climb_grades'],
  'packages/backend/src/scripts/export-board-snapshots.ts',
);
grant(
  'boardsesh_snapshot_exporter',
  ['SELECT'],
  [
    'board_products',
    'board_layouts',
    'board_product_sizes',
    'board_sets',
    'board_placement_roles',
    'board_holes',
    'board_placements',
    'board_leds',
    'board_product_sizes_layouts_sets',
    'board_kits',
    'board_difficulty_grades',
    'board_attempts',
    'board_climb_aliases',
    'board_beta_links',
  ],
  'packages/db/src/catalog-snapshot.ts',
);

grant(
  'boardsesh_climb_grades_refresh',
  ['SELECT'],
  [
    'board_climb_embeddings',
    'board_climbs',
    'board_climb_stats',
    'boardsesh_ticks',
    'board_climb_aliases',
    'board_climb_stats_history',
    'user_boards',
  ],
  'packages/db/scripts/refresh-climb-grades.ts + packages/db/src/queries/grade-model',
);
grant(
  'boardsesh_climb_grades_refresh',
  ['INSERT', 'SELECT', 'UPDATE'],
  ['board_grade_coefficients'],
  'packages/db/scripts/refresh-climb-grades.ts',
);
grant(
  'boardsesh_climb_grades_refresh',
  ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
  ['board_climb_grades'],
  'packages/db/scripts/refresh-climb-grades.ts',
);

grant(
  'boardsesh_content_model_refresh',
  ['SELECT'],
  ['board_hold_features', 'board_climb_stats', 'board_climbs', 'board_climb_holds', 'board_placements'],
  'packages/db/scripts/extract-training-matrix.ts',
);
grant(
  'boardsesh_content_model_refresh',
  ['INSERT', 'SELECT', 'UPDATE'],
  ['board_climb_embeddings'],
  'packages/db/scripts/load-content-model.ts',
);
grant(
  'boardsesh_content_model_refresh',
  ['DELETE', 'INSERT', 'SELECT'],
  ['board_climb_similar'],
  'packages/db/scripts/load-similarity.ts',
);

grant(
  'boardsesh_hold_features_refresh',
  ['SELECT'],
  [
    'board_placements',
    'board_holes',
    'board_sets',
    'board_climb_stats',
    'board_climbs',
    'board_climb_holds',
    'board_product_sizes_layouts_sets',
  ],
  'packages/db/scripts/refresh-hold-features.ts',
);
grant('boardsesh_hold_features_refresh', ['INSERT'], ['users'], 'packages/db/scripts/refresh-hold-features.ts');
grant(
  'boardsesh_hold_features_refresh',
  ['INSERT', 'SELECT', 'UPDATE'],
  ['board_hold_features', 'user_hold_classifications'],
  'packages/db/scripts/refresh-hold-features.ts',
);

grant(
  'boardsesh_recommendations_refresh',
  ['SELECT'],
  ['board_climbs', 'board_climb_stats'],
  'packages/db/scripts/refresh-recommendations.ts + packages/db/src/queries/recommendations',
);
grant('boardsesh_recommendations_refresh', ['INSERT'], ['users'], 'packages/db/scripts/refresh-recommendations.ts');
grant(
  'boardsesh_recommendations_refresh',
  ['INSERT'],
  ['board_climb_stats_history'],
  'packages/db/src/queries/climb-stats/history-snapshot.ts',
);
grant(
  'boardsesh_recommendations_refresh',
  ['INSERT'],
  ['sync_deletions'],
  'packages/db/drizzle/0146_offline_sync_followups.sql',
);
grant(
  'boardsesh_recommendations_refresh',
  ['INSERT', 'SELECT', 'UPDATE'],
  ['board_setter_stats', 'playlists', 'board_shared_syncs'],
  'packages/db/scripts/refresh-recommendations.ts',
);
grant(
  'boardsesh_recommendations_refresh',
  ['DELETE', 'INSERT', 'SELECT'],
  ['board_climb_send_stats', 'playlist_climbs'],
  'packages/db/scripts/refresh-recommendations.ts',
);
grant(
  'boardsesh_recommendations_refresh',
  ['INSERT', 'SELECT'],
  ['playlist_ownership'],
  'packages/db/scripts/refresh-recommendations.ts + packages/db/drizzle/0146_offline_sync_followups.sql',
);

export const PRODUCTION_TASK_RELATION_GRANTS = Object.freeze(
  grants.sort((left, right) => `${left.role}:${left.relation}`.localeCompare(`${right.role}:${right.relation}`)),
);

export const PRODUCTION_TASK_ROLE_BY_NAME = new Map(PRODUCTION_TASK_ROLES.map((entry) => [entry.name, entry]));
