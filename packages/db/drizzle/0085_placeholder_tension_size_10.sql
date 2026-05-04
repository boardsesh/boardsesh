-- Two production users have walls referencing (board_type='tension', product_size_id=10)
-- but Aurora introduced this size after the last time it landed in our shared seed.
-- Our shared-sync (packages/web/app/lib/data-sync/aurora/shared-sync.ts) does NOT include
-- 'product_sizes' in TABLES_TO_PROCESS, so the Vercel cron will never insert it on its own.
--
-- Insert a placeholder so those users' walls (and the rest of their sync data) can land.
-- Once shared-sync starts processing product_sizes, an upsert will overwrite this with
-- the canonical row from Aurora.
INSERT INTO "board_product_sizes" (
    "board_type",
    "id",
    "product_id",
    "name",
    "description",
    "edge_left",
    "edge_right",
    "edge_bottom",
    "edge_top",
    "image_filename",
    "position",
    "is_listed"
) VALUES (
    'tension',
    10,
    5,
    'Unknown size (placeholder; Aurora-side size not yet synced)',
    '',
    0,
    0,
    0,
    0,
    NULL,
    NULL,
    FALSE
) ON CONFLICT ("board_type", "id") DO NOTHING;
