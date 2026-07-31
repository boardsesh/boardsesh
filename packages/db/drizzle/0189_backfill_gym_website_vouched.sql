-- Custom SQL migration file, put your code below! --
-- Grandfather the websites a gym's own owner almost certainly typed, and retire
-- the domain-claim tokens the old (vulnerable) rules already handed out.
--
-- WHY (1 — the vouch backfill): gyms.website is only ever written by a human,
-- through createGym or updateGym; the location sync never touches it. For a gym
-- owned by a real user, that human was almost always the owner themself (they
-- created the listing), so mark those rows vouched and keep today's self-service
-- email claims working for them.
--
-- WHY (2 — SYSTEM rows stay false): a SYSTEM-owned catalog gym's owner is the
-- never-logged-in import user, so any website on it can only have come from a
-- non-owner human (a gym editor or a covering community leader). Those are
-- exactly the rows #3431 escalates through, so they are deliberately left
-- un-vouched and drop to admin review.
--
-- LIMITATION (operator-facing): a user-owned gym whose website was typed by a
-- granted *editor* before this migration is grandfathered as vouched and stays
-- domain-claimable until someone rewrites it. The data cannot distinguish that
-- case from the owner typing it, and gym write-access grants only shipped on
-- 2026-07-03, so the window is small. Going forward the provenance is exact:
-- createGym and updateGym write this column alongside every website write.
--
-- WHY (3 — the in-flight token sweep): a domain verification token minted under
-- the old rules keeps redeeming for up to 24h (CLAIM_TOKEN_TTL_MS), and
-- verifyGymClaimByToken re-validates nothing but the hash, status and expiry. So
-- the exact token the #3431 attack seeds would still transfer ownership after
-- this fix deploys. Expire those pending domain claims on the gyms this fix
-- leaves un-vouched. A vouched gym's in-flight claim is untouched. It is a
-- status flip, not a delete: an honest claimant caught by it simply re-requests
-- and lands on admin review, which is the intent of the fix.
--
-- INVARIANT: "website" and "website_vouched_by_owner" must always be written in
-- the same statement — any future writer of gyms.website (a sync importer, a
-- merge that starts copying website, an admin script) MUST set this column in
-- the same UPDATE, defaulting to false.
--
-- Both statements are idempotent: re-running is a no-op.
UPDATE "gyms"
   SET "website_vouched_by_owner" = true
 WHERE "website" IS NOT NULL
   AND "owner_id" <> '00000000-0000-0000-0000-000000000000';
--> statement-breakpoint
UPDATE "gym_claims"
   SET "status" = 'expired', "updated_at" = now()
 WHERE "method" = 'domain'
   AND "status" = 'pending'
   AND "gym_id" IN (SELECT "id" FROM "gyms" WHERE "website_vouched_by_owner" = false);
