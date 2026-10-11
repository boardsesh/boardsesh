-- Stable signature for affected table indexes and column defaults/types.
-- Run in each matched disposable database and diff the output before timing.
SELECT 'index|' || index_entry.tablename || '|' || index_entry.indexname || '|' || index_entry.indexdef AS signature
FROM pg_catalog.pg_indexes AS index_entry
WHERE index_entry.schemaname = 'public'
  AND index_entry.tablename IN ('board_climbs', 'board_climb_stats', 'board_climb_grades', 'sync_deletions')
UNION ALL
SELECT 'column|' || column_entry.table_name || '|'
       || lpad(column_entry.ordinal_position::text, 3, '0') || '|'
       || column_entry.column_name || '|'
       || column_entry.data_type || '|'
       || column_entry.is_nullable || '|'
       || COALESCE(column_entry.column_default, '<null>')
FROM information_schema.columns AS column_entry
WHERE column_entry.table_schema = 'public'
  AND column_entry.table_name IN ('board_climbs', 'board_climb_stats', 'board_climb_grades', 'sync_deletions')
ORDER BY signature;
