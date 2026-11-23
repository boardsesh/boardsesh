-- Read-only receipt report. Run against the intended environment's database.
-- Set UTC bounds and the project's internal/test owner exclusions before running.
-- as_of is the extraction time: retain the returned aggregates as the dated receipt;
-- this current-state table does not reconstruct snapshots from before its latest update.
WITH parameters AS (
  SELECT TIMESTAMPTZ '2026-11-21 00:00:00+00' AS as_of,
         TIMESTAMPTZ '2026-11-01 00:00:00+00' AS cohort_start,
         TIMESTAMPTZ '2026-11-21 00:00:00+00' AS cohort_end,
         INTERVAL '24 hours' AS freshness,
         ARRAY[]::text[] AS excluded_user_ids
), horizons(follow_up) AS (
  VALUES (INTERVAL '24 hours'), (INTERVAL '7 days')
), scoped AS (
  SELECT receipt.* FROM offline_write_deliveries receipt CROSS JOIN parameters
  WHERE receipt.first_seen_at >= parameters.cohort_start
    AND receipt.first_seen_at < parameters.cohort_end
    AND receipt.first_seen_at <= parameters.as_of
    AND NOT (receipt.user_id = ANY(parameters.excluded_user_ids))
    AND COALESCE(receipt.origin_release->>'branch', '') !~ '^(pr-|preview|development|dev$|staging|test)'
    AND COALESCE(receipt.receiving_release->>'branch', '') !~ '^(pr-|preview|development|dev$|staging|test)'
    AND COALESCE(receipt.rejection_release->>'branch', '') !~ '^(pr-|preview|development|dev$|staging|test)'
), eligible AS (
  SELECT * FROM scoped
  WHERE origin_release->>'applicationId' = 'com.boardsesh.app'
    AND COALESCE(receiving_release->>'applicationId', 'com.boardsesh.app') = 'com.boardsesh.app'
    AND COALESCE(rejection_release->>'applicationId', 'com.boardsesh.app') = 'com.boardsesh.app'
), population AS (
  SELECT receipt.*, parameters.as_of, parameters.freshness, horizons.follow_up,
         receipt.first_seen_at + horizons.follow_up AS deadline
  FROM eligible receipt CROSS JOIN parameters CROSS JOIN horizons
  WHERE receipt.queued_at IS NOT NULL
    AND receipt.connectivity_reason IN ('device_offline', 'backend_unreachable', 'offline_mode')

), classified AS (
  SELECT *, CASE
    WHEN deadline > as_of THEN 'age_censored'
    WHEN server_accepted_at <= deadline AND reconciled_reported_at <= deadline THEN 'success'
    WHEN server_accepted_at <= as_of AND reconciled_reported_at <= as_of THEN 'late'
    WHEN client_state IN ('superseded', 'discarded') AND client_observed_at <= as_of THEN client_state
    WHEN server_rejected_at <= as_of AND server_accepted_at IS NULL THEN 'rejected'
    WHEN client_observed_at BETWEEN as_of - freshness AND as_of
      AND last_reported_at BETWEEN as_of - freshness AND as_of
      THEN CASE WHEN client_state = 'dead_letter' THEN 'dead_letter' ELSE 'pending' END
    ELSE 'unknown' END AS outcome
  FROM population
), results AS (
SELECT follow_up::text,
       origin_release->>'applicationId' AS origin_application,
       origin_release->>'platform' AS origin_platform,
       origin_release->>'appVersion' AS origin_app_version,
       origin_release->>'runtimeVersion' AS origin_runtime,
       origin_release->>'updateId' AS origin_update_id,
       origin_release->>'isEmbedded' AS origin_is_embedded,
       origin_release->>'branch' AS origin_branch,
       receiving_release->>'applicationId' AS receiving_application,
       receiving_release->>'platform' AS receiving_platform,
       receiving_release->>'appVersion' AS receiving_app_version,
       receiving_release->>'runtimeVersion' AS receiving_runtime,
       receiving_release->>'updateId' AS receiving_update_id,
       receiving_release->>'isEmbedded' AS receiving_is_embedded,
       receiving_release->>'branch' AS receiving_branch,
       observed_release->>'runtimeVersion' AS reporting_runtime,
       observed_release->>'updateId' AS reporting_update_id,
       rejection_release->>'runtimeVersion' AS rejection_runtime,
       rejection_release->>'updateId' AS rejection_update_id,
       table_name, operation, connectivity_reason, outcome,
       COUNT(*) AS writes,
       COUNT(*) FILTER (WHERE server_accepted_at <= as_of) AS server_accepted,
       COUNT(*) FILTER (WHERE server_rejected_at <= as_of) AS server_rejected,
       COUNT(*) FILTER (WHERE server_accepted_at <= deadline) AS server_accepted_within_follow_up,
       COUNT(*) FILTER (WHERE reconciled_reported_at <= as_of) AS locally_reconciled_reported,
       COUNT(*) FILTER (WHERE server_accepted_at <= as_of AND reconciled_reported_at IS NULL) AS accepted_without_local_proof,
       COUNT(*) FILTER (WHERE recovered OR server_rejected_at IS NOT NULL) AS recovery_history,
       COUNT(*) FILTER (WHERE (recovered OR server_rejected_at IS NOT NULL)
         AND server_accepted_at <= as_of AND reconciled_reported_at <= as_of) AS recovered,
       COUNT(*) FILTER (WHERE first_dead_letter_at IS NOT NULL) AS ever_dead_lettered,
       COUNT(*) FILTER (WHERE queued_at > first_seen_at + INTERVAL '5 minutes'
         OR client_observed_at > last_reported_at + INTERVAL '5 minutes') AS client_clock_uncertain
FROM classified
GROUP BY follow_up, origin_release, receiving_release, rejection_release, observed_release, table_name, operation, connectivity_reason, outcome
ORDER BY follow_up, origin_platform, origin_runtime, table_name, operation, outcome
), coverage AS (

-- Coverage gaps share the exact cohort, extraction time and exclusions.
-- Missing or non-production application namespaces remain visible here, outside the denominator.
SELECT table_name, operation,
       COUNT(*) FILTER (WHERE queued_at IS NULL AND server_accepted_at IS NOT NULL) AS acceptance_without_enqueue,
       COUNT(*) FILTER (WHERE queued_at IS NULL AND server_rejected_at IS NOT NULL) AS rejection_without_enqueue,
       COUNT(*) FILTER (WHERE queued_at IS NOT NULL AND connectivity_reason = 'unknown') AS unknown_connectivity,
       COUNT(*) FILTER (WHERE server_accepted_at IS NOT NULL AND receiving_release IS NULL) AS acceptance_without_runtime,
       COUNT(*) FILTER (WHERE server_rejected_at IS NOT NULL AND rejection_release IS NULL) AS rejection_without_runtime,
       COUNT(*) FILTER (WHERE queued_at IS NOT NULL AND origin_release->>'applicationId' IS NULL) AS enqueue_application_unknown,
       COUNT(*) FILTER (WHERE server_accepted_at IS NOT NULL AND receiving_release->>'applicationId' IS NULL) AS acceptance_application_unknown,
       COUNT(*) FILTER (WHERE server_rejected_at IS NOT NULL AND rejection_release->>'applicationId' IS NULL) AS rejection_application_unknown,
       COUNT(*) FILTER (WHERE (origin_release->>'applicationId' IS NOT NULL AND origin_release->>'applicationId' <> 'com.boardsesh.app')
         OR (receiving_release->>'applicationId' IS NOT NULL AND receiving_release->>'applicationId' <> 'com.boardsesh.app')
         OR (rejection_release->>'applicationId' IS NOT NULL AND rejection_release->>'applicationId' <> 'com.boardsesh.app')) AS excluded_application_namespace
FROM scoped
GROUP BY table_name, operation
)
SELECT jsonb_build_object(
  'parameters', (SELECT to_jsonb(parameters) - 'excluded_user_ids' FROM parameters),
  'results', COALESCE((SELECT jsonb_agg(to_jsonb(results)) FROM results), '[]'::jsonb),
  'coverage', COALESCE((SELECT jsonb_agg(to_jsonb(coverage)) FROM coverage), '[]'::jsonb)
) AS report;
