/**
 * The journal-vs-ledger gaps production already carried when the deploy gate
 * started failing on them.
 *
 * `VERIFY_MIGRATION_JOURNAL=1` landed fail-closed (#2933) and immediately
 * blocked every production deploy: `migrate` is the `needs:` gate for both
 * `deploy-web` and `deploy-production-backend`, and the production ledger has no
 * row matching 20 of the 188 journal entries. None of those 20 are recent — they
 * accumulated over two years, so the gate's first run reported a backlog rather
 * than the regression it was built to catch.
 *
 * Every migration below is subtracted before the gate throws. A gap in any
 * *other* journal entry still fails the deploy, which is the case that matters:
 * the incident behind #2933 was a freshly appended migration
 * (`0129_numerous_star_brand`) that drizzle's high-water mark skipped, and that
 * shape is still caught on the first deploy after it happens. The gate keeps
 * naming the baselined tags on every run, so they stay visible instead of
 * becoming permanently invisible.
 *
 * ## Why each entry carries a hash
 *
 * Tolerating a *tag* would outlive the file it was recorded against. Edit one of
 * these `.sql` files and drizzle computes a new expected hash; the database still
 * has no matching row, and the migration's old `when` keeps it from replaying —
 * so a tag-only baseline would report "known gap, deploy on" while the edited DDL
 * never ran. That is the silent failure this gate exists to catch, re-created one
 * layer up.
 *
 * So each entry pins the hash the file had when the gap was recorded. Same tag,
 * different content, and the gap is fatal again with the change named. The hashes
 * come from drizzle's own `readMigrationFiles`, the same source the gate compares
 * against, and `migration-journal-verification.integration.test.ts` asserts they
 * still match the files on disk — so an edit to a baselined migration reddens the
 * PR rather than the deploy.
 *
 * ## What is in here
 *
 * A missing ledger row has two possible causes and this list mixes both, because
 * telling them apart needs the production schema in front of you (see
 * `docs/operations/db-migrations.md`):
 *
 *  - **The `.sql` changed after production applied it.** The ledger stores the
 *    hash of the file as it was when it ran, so an edit orphans the row.
 *    `0103_thick_puck` is the clearest case: it landed as bare `CREATE TABLE`
 *    and was rewritten with `IF NOT EXISTS` guards a day later, after the deploy
 *    that applied the original. 11 of the 20 entries below have more than one
 *    content version in git history, which is the same signature.
 *  - **The migration never ran, or its row was lost.** The high-water-mark skip
 *    (#2933's own failure mode), or a hand repair / restore that rebuilt the
 *    schema without the ledger row. The `0025`–`0029` block arrived with the
 *    migration consolidation in #470, which rewrote the journal around rows that
 *    already existed.
 *
 * That second cause is why this file is a stopgap and not a resolution: if one
 * of these migrations genuinely never ran, its objects are absent in production
 * and this list is now hiding that. The entries are itemised rather than
 * collapsed into a "before tag N" cut-off precisely so shrinking the list is a
 * normal reviewable diff — repair one against production, delete its line.
 *
 * ## Shrinking it
 *
 * `DB_URL=postgres://... vp run db:verify-journal` prints each remaining tag
 * with the ledger hash its repair row needs. Repair per `docs/operations/db-migrations.md`
 * ("The journal-vs-ledger check"), then remove the entry here. Do not add one
 * without a reason: a new gap means a migration that did not reach production,
 * and baselining it ships the outage #2933 was closed to prevent.
 */
import type { ExpectedMigration } from './migration-ledger.js';

export interface LedgerBaseline {
  /** ISO date the gap was observed, so a stale list reads as stale. */
  readonly recordedAt: string;
  /** Where the gap was observed, for anyone re-deriving the list. */
  readonly source: string;
  /**
   * Journal-order entries the deploy gate tolerates, each pinned to the hash its
   * `.sql` had when the gap was recorded.
   */
  readonly migrations: readonly ExpectedMigration[];
}

/**
 * How many journal entries existed when the baseline was recorded.
 *
 * The anchor for the rule that matters: nothing appended after this point may be
 * baselined, because a gap there is a migration that did not reach production.
 * The journal only ever grows, so this stays a meaningful bound instead of
 * drifting into a tautology the way a hand-picked margin would.
 */
export const JOURNAL_LENGTH_WHEN_BASELINE_RECORDED = 188;

/**
 * Observed on the production database (`tramway.proxy.rlwy.net`) by the first
 * `Production Deploy` run that armed the gate: 20 of 188 journal entries had no
 * ledger row, with 183 rows present.
 */
export const PRODUCTION_LEDGER_BASELINE: LedgerBaseline = {
  recordedAt: '2026-07-30',
  source: 'Production Deploy run 30528469806 (migrate job), commit f3a1a22',
  migrations: [
    { tag: '0000_cloudy_carlie_cooper', hash: 'e6ac2b585a2551f3ddd444817ee21032aad6a592b4cf86b83e9f41c67913d864' },
    { tag: '0002_unique_climbstats', hash: 'a5a2ae48548e995fc4bc45b85087a7ac47ad959aa7a691899fac42a83256bbe8' },
    { tag: '0014_add_missing_primary_keys', hash: '036762880bc8cc726ea43a4ce8170b3b98487f435c9e526d3305cb6d3cf33341' },
    { tag: '0025_fix_missing_tables', hash: '843f0ff0702aef915ad480615821a662261707ab987707cbd39ccb23ef0a6492' },
    {
      tag: '0026_migrate_aurora_to_boardsesh_ticks',
      hash: '8f6dbb45163454a48661897dade0cbc31e456df078455fda3646b783e7b93688',
    },
    { tag: '0027_add_sequence_column', hash: '82f8bd84ecf72af12188c5bde8558ca38f6474fe495ff849acee8ec7982ac57c' },
    { tag: '0028_add_instagram_url', hash: '719cb4c8ee7ac0449aaab7b68f4825661a402d9028928f1b225ded0825e4b964' },
    {
      tag: '0029_add_aurora_id_unique_index',
      hash: 'd3a58e2548c66fc7244facc5e878abe401048870cb1f532b36c46ca2ac721702',
    },
    { tag: '0025_shocking_clint_barton', hash: 'f3325a8184b63847d972302af89a6c5f8ca6610499c94aaf73d10b435f38e6b3' },
    { tag: '0052_broad_red_ghost', hash: '75b3929167d87d81edc52761fe69e8027b04beede91a5d16755e35b928a99178' },
    { tag: '0067_fat_betty_ross', hash: 'f28c121e071e16d9936ccf0e07d011a4953a6872ad6aa6a819a6b7b0039ca6af' },
    {
      tag: '0068_add_search_performance_indexes',
      hash: 'cc1c1c94d3f67071f0227a14b8411ab3bf3e3b243c67ce97dd5e7e07293aed0e',
    },
    { tag: '0069_mature_morg', hash: '6f9b394f9082963652d50106a09c50066676832b6a0937ffc98d74b63a86ff59' },
    {
      tag: '0073_denormalize_climb_sets_sizes',
      hash: '94fb37d773387f8e7316197a170f6e3b8cb4ca1fd318ddd416d35312690cd2e1',
    },
    { tag: '0077_mixed_lady_deathstrike', hash: '2320b9881ce5b4e25cedd6504b99e95ac674426407b0081b7103e2e51cfabca2' },
    { tag: '0078_yummy_kylun', hash: 'b9fb9f34eca54caed672f4e520f1483c87aa6e5425cf31904b968a6f9dfd63df' },
    {
      tag: '0079_backfill_tick_quality_scale',
      hash: 'f1759562134dbfa78df38eb7810a4d56c76a185f2e9e8b6c6f588f4d0f55ff8b',
    },
    {
      tag: '0082_add_user_climb_percentiles',
      hash: 'a1be612e137de35315e1277906c300ab4344cadbe767315571774d1a103a4ddc',
    },
    { tag: '0092_long_demogoblin', hash: '09795e40fabfca2e209894635bbd697c46cf55f28e102520362e258064b6e906' },
    { tag: '0103_thick_puck', hash: '2cc675b9e0fc6a612120342fa262c72bc72b3bbdd9a0b0957d9ff3ed70567a1d' },
  ],
};

/**
 * A baseline that tolerates nothing. The default for any folder that is not this
 * repo's. `recordedAt` is a sentinel rather than a date: nothing is recorded here,
 * and a copied real date would read as if something were.
 */
export const EMPTY_LEDGER_BASELINE: LedgerBaseline = {
  recordedAt: 'n/a',
  source: 'no baseline',
  migrations: [],
};
