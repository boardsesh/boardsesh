-- Read-only aggregate diagnostic; run on the private network with a bounded client.
SELECT version();

SELECT database, table, count() AS active_parts, sum(rows) AS row_count,
       sum(bytes_on_disk) AS disk_bytes
FROM system.parts
WHERE active
GROUP BY database, table
ORDER BY disk_bytes DESC;

SELECT database, name, engine,
       extract(create_table_query, '(?is)TTL (.*?)(?: SETTINGS|$)') AS ttl_clause
FROM system.tables
WHERE engine LIKE '%MergeTree%'
ORDER BY database, name;

SELECT metric, value
FROM system.metrics
WHERE metric ILIKE '%memory%' OR metric ILIKE '%cache%' OR metric ILIKE '%merge%'
ORDER BY metric;

SELECT metric, value
FROM system.asynchronous_metrics
WHERE metric ILIKE '%memory%' OR metric ILIKE '%cache%'
ORDER BY metric;

SELECT database, table, elapsed, progress, memory_usage
FROM system.merges
ORDER BY memory_usage DESC;

SELECT count() AS active_queries, sum(memory_usage) AS query_memory_bytes,
       max(elapsed) AS longest_query_seconds
FROM system.processes;

SELECT type, count() AS query_count,
       quantiles(0.5, 0.95, 0.99)(query_duration_ms) AS duration_ms_quantiles,
       max(memory_usage) AS peak_query_memory_bytes,
       sum(read_bytes) AS bytes_read
FROM system.query_log
WHERE event_date >= today() - 1 AND event_time >= now() - INTERVAL 24 HOUR
GROUP BY type;
