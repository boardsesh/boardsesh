# User media storage

Where avatars, gym images, beta-video thumbnails and user data exports live, and how the backend reaches them.

## The buckets

| Bucket | Handle | Provider | Access | Contents |
| --- | --- | --- | --- | --- |
| `boardsesh-user-media` | `media` | Cloudflare R2 | Public through the `media.boardsesh.com` custom domain | `beta-link-thumbnails/{instagram,tiktok}/…`, `avatars/<userId>.<ext>`, `gym-logos/<uuid>.<ext>`, `gym-photos/<uuid>.<ext>`, and every `@<size>.jpg` resize variant |
| `boardsesh-user-private` | `private` | Cloudflare R2 | No custom domain, therefore unreachable from the internet | `user-data-exports/<userId>/<boardType>/<isoWeek>.json`, `moonboard-ocr-test-data/<ts>-<uuid>/…` |
| `boardsesh-board-snapshots` | `snapshots` | Tigris | Public on the bucket's virtual-host domain | `board-snapshots/**` — see `docs/board-snapshots.md` |

**On R2 the bucket IS the privacy boundary.** R2 implements no object ACLs and no bucket policies, so there is no way to make one prefix of a bucket private. Attaching a custom domain publishes the whole bucket. That is why the exports live in a separate bucket rather than under a prefix, and why the private bucket must never be given a custom domain.

## Why R2 and not Tigris

The rest of Boardsesh's object storage is Tigris, and the obvious move for this data was Tigris too. Two measurements said otherwise.

**Tigris cannot sit behind Cloudflare.** Its docs are explicit: *"Your custom domain must point directly to Tigris without any intermediate proxy that terminates TLS, such as Cloudflare's proxy mode."* Tigris issues and renews the domain's TLS certificate off the live CNAME, so orange-clouding it breaks renewal within a couple of months. The Cloudflare Origin Rules workaround — overriding the Host header, which also sets SNI — is Enterprise-only. This is the constraint behind the "keep `assets.boardsesh.com` DNS-only" rule in `docs/cloudflare.md`; it is not a preference.

**Tigris's edge footprint is thin.** Measured from Sydney on 2026-09-01, twenty consecutive requests to `assets.boardsesh.com` were served from `sjc1` at ~540 ms each; dynamic data placement never moved the object closer. The same box reached a Cloudflare cache hit in 30 ms.

R2 custom domains *are* the Cloudflare CDN — proxied by design, free egress, and Cache Rules apply through `infra/cloudflare/`. At 5.2 GB the bucket sits inside R2's free tier (10 GB storage, 1M Class A, 10M Class B).

## Configuration

Every bucket is configured through its own env prefix, resolved by `packages/backend/src/storage/bucket-config.ts`:

```
<PREFIX>_S3_BUCKET_NAME          selects prefixed mode for this bucket
<PREFIX>_AWS_ENDPOINT_URL        (or _AWS_ENDPOINT_URL_S3)
<PREFIX>_AWS_REGION              (or _AWS_DEFAULT_REGION; defaults to `auto`)
<PREFIX>_AWS_ACCESS_KEY_ID
<PREFIX>_AWS_SECRET_ACCESS_KEY
<PREFIX>_S3_FORCE_PATH_STYLE     optional, defaults false (virtual-hosted)
<PREFIX>_PUBLIC_BASE_URL         required before any public URL is built; must be https
<PREFIX>_DISABLE_ACL             defaults true for an R2 endpoint and for `private`
```

Prefixes are `MEDIA`, `PRIVATE`, `SNAPSHOTS`.

Two rules the code enforces rather than documents:

- **A prefixed bucket never borrows the legacy `AWS_*` credentials.** Setting `MEDIA_S3_BUCKET_NAME` without `MEDIA_AWS_ACCESS_KEY_ID` throws at first use instead of pointing one bucket's name at another bucket's key, which would fail later as an opaque 403.
- **A prefixed bucket must declare `<PREFIX>_PUBLIC_BASE_URL` before anything asks for a public URL.** No URL is derived from the S3 endpoint. R2's endpoint requires SigV4 and always 401s; Tigris only serves public objects on the bucket virtual-host domain. Deriving one produces a URL that looks right and fails for every anonymous reader — which is exactly how legacy `t3.storageapi.dev/...` values ended up persisted in `board_beta_links.thumbnail` and needed a data backfill to undo.

R2 answers `x-amz-acl: public-read` with `501 NotImplemented`, and the default before named buckets was to send exactly that on every upload — so an R2 bucket that still sends ACLs fails **100%** of its uploads. Nothing is gained by making that hinge on an operator remembering a flag, so a `*.r2.cloudflarestorage.com` endpoint suppresses ACLs on its own. `<PREFIX>_DISABLE_ACL` remains an explicit override in both directions.

`<PREFIX>_PUBLIC_BASE_URL` is checked at read time and must be `https` (plain HTTP is allowed only on `localhost`). Every value built from it is either persisted to a database column or served in an `<img src>`, so an `http://` typo would not fail loudly — it would quietly downgrade every avatar and thumbnail on the site.

### Legacy fallback

Any handle with no `<PREFIX>_S3_BUCKET_NAME` falls back to the bare `AWS_S3_BUCKET_NAME` / `AWS_ENDPOINT_URL` / `AWS_DEFAULT_REGION` / `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`, reproducing the pre-named-buckets behaviour — path-style, `us-east-1` default, `public-read` ACL. That is what lets the code deploy before the variables exist, and what lets a rollback be "delete the new variables and restart".

The one deliberate deviation is `private`, which defaults to **no** ACL in both modes. The old single-client module sent `public-read` on any upload that did not override it, which for this handle is the OCR test-data path; that was harmless only because the Railway bucket ignores ACLs, and would publish user-submitted screenshots against any store that honours them.

It is also how the board-snapshots GitHub job keeps working untouched: `.github/workflows/export-board-snapshots.yml` passes `AWS_*` secrets that point at Tigris, and the `snapshots` handle reads them.

Each configured bucket logs one line at first use:

```
storage[media] bucket=boardsesh-user-media source=prefixed endpoint=https://<acct>.r2.cloudflarestorage.com region=auto pathStyle=false acl=none public=https://media.boardsesh.com
```

Check it after any storage env change. `source=legacy` on `media` in production means the new variables did not take.

## Serving

Objects are reached through the backend's `/static/*` routes, which stream them out of the `media` bucket:

| Route | Handler |
| --- | --- |
| `/static/avatars/<file>` | `handleStaticAvatar` |
| `/static/gym-logos/<file>` | `handleStaticGymLogo` |
| `/static/gym-photos/<file>` | `handleStaticGymPhoto` |
| `/static/beta-link-thumbnails/<platform>/<file>` | `handleStaticBetaThumbnail` |

All four accept `?size=N` for `N` in `ALLOWED_IMAGE_SIZES` (`packages/shared-schema/src/image-sizes.ts`). Beta thumbnails persist the resized bytes at `<baseKey>@<size>.jpg` because their key is immutable; avatars and gym images resize on the fly, because their key is overwritten in place on re-upload and a cached variant would shadow the new image.

## Migration runbook

`vp run storage:migrate-user-media` (`scripts/migrate-user-media.ts`) copies the retired Railway bucket into the two R2 buckets. It is re-runnable: the plan skips any destination object already present at the same byte size, so a second pass moves only the delta — plus the ~182 objects under a **mutable** prefix, which are always recopied.

A prefix is mutable when its objects can be rewritten at the same key: `avatars/`, `gym-logos/`, `gym-photos/` (overwritten on re-upload) and `user-data-exports/` (rewritten within its own ISO week). A listing carries no checksum, so for those a matching size does not prove matching content — a rewrite that lands on the same byte length between the bulk copy and the sweep would otherwise be skipped as already-done and would pass verification too, leaving the stale copy live. Beta thumbnails and OCR submissions are keyed by media id and timestamp respectively, so they stay on the cheap skip-by-size path, which is where the 50,719-object saving actually is.

Credentials come from three prefixes — `LEGACY_*` for the Railway bucket (path-style), plus `MEDIA_*` and `PRIVATE_*`.

```bash
export LEGACY_S3_BUCKET_NAME=structured-parcel-ei3jl8g
export LEGACY_AWS_ENDPOINT_URL=https://t3.storageapi.dev
export LEGACY_AWS_REGION=sjc
export LEGACY_AWS_ACCESS_KEY_ID=… LEGACY_AWS_SECRET_ACCESS_KEY=…
# plus MEDIA_* and PRIVATE_* as above

vp run storage:migrate-user-media -- --dry-run    # print the plan, move nothing
vp run storage:migrate-user-media                 # copy, then verify
vp run storage:migrate-user-media -- --verify-only
```

Flags: `--prefix <p>` (repeatable), `--only media|private`, `--rate <n>` (default 50 request starts/sec per side), `--concurrency <n>` (default 8), `--reverse` (restore R2 → Railway), `--verify-only`.

`LEGACY` defaults to path-style because the Railway bucket only speaks that; the R2 prefixes default to virtual-hosted. Both are overridable with `<PREFIX>_S3_FORCE_PATH_STYLE`.

`--verify-only` is read-only in both directions and **exits non-zero** whenever it finds a missing object, a size mismatch, or an unroutable key — so the cutover step below genuinely gates rather than merely printing. Combined with `--reverse` it reports how many R2 objects are not yet back in the legacy bucket and fails the same way.

Its one honest limit: because a listing carries no checksum, `--verify-only` on its own proves presence and size, not currency, for the mutable prefixes. A real run closes that by recopying them unconditionally, so the object it has just written is the current one.

At the default rate the full 50,901-object copy takes about 17 minutes; request rate binds, not bandwidth. Every run ends with a `SUMMARY {...}` line to paste into the PR.

**Unroutable keys abort the run before any byte moves.** `MIGRATION_ROUTES` in `scripts/lib/object-store-migration.ts` is exhaustive by design: a prefix nobody has classified might be private data, and the media bucket is world-readable. Add the route, then re-run.

The source bucket is therefore listed in full on every run, including a `--prefix` or `--only` one. Scoping that listing would quietly downgrade the guarantee to "abort only if the surprise key happens to fall inside the slice you asked for". The filters still scope the copy plan; the extra cost is ~51 listing requests against a 17-minute copy.

### Cutover order

1. Deploy the code. Every handle still falls back to `AWS_*`, so nothing changes.
2. `--dry-run`, review, then run for real, then `--verify-only`.
3. Set `MEDIA_*` and `PRIVATE_*` on `boardsesh-backend`; restart; confirm the two `source=prefixed` log lines.
4. Re-run the migration to sweep whatever was written between the copy and the flip.
5. Smoke-test: upload an avatar, upload a gym logo and photo, load a climb page with a beta video, request and download a user data export.

**Rollback:** delete `MEDIA_*` and `PRIVATE_*`, restart. Both handles return to the Railway bucket, which the migration never modifies. Objects written to R2 after the flip come back with `--reverse`. Do the flip in a low-traffic window so that window stays small.

## Manual steps this repo does not automate

`infra/railway/config.ts` manages the OTA services in this project and lists `boardsesh-backend` only as inventory — it asserts nothing about the service carrying these credentials — so these are dashboard actions:

- Creating the two R2 buckets and their scoped API tokens (Cloudflare dashboard).
- Attaching `media.boardsesh.com` to `boardsesh-user-media`, which is what makes it public.
- Setting the `MEDIA_*` / `PRIVATE_*` variables on `boardsesh-backend` (Railway dashboard).

Never attach a custom domain to `boardsesh-user-private`. It holds complete per-user tick histories.
