-- A published climb is public to everyone, so a climb has no audience. Remove
-- every stored climb policy, including deleted-account tombstones, before the
-- next migration narrows content_privacy_type_check to exclude 'climb'.
DELETE FROM "content_privacy" WHERE "entity_type" = 'climb';
