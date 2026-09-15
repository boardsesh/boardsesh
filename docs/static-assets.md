# Static image CDN

Boardsesh publishes repo-owned runtime images to a dedicated Tigris bucket and serves them through
`https://assets.boardsesh.com`. The immutable catalog lives in `@boardsesh/static-assets` and is shared by the
Next.js and Expo web builds.

## Catalog scope

`vp run generate:static-assets` catalogs:

- every WebP under `packages/web/public/images` (including full, thumbnail, and dark board layers);
- the Boardsesh brand mark and public PWA icons;
- the Next.js favicon and app icon.

The original board PNG files remain local build inputs for server-side board and Open Graph rendering. They are
deliberately excluded from the CDN catalog. Dynamic/user images, generated Open Graph cards, gym media, avatars,
and third-party thumbnails keep their existing storage paths.

The checked-in runtime catalog is a compact mapping from each leading-slash logical path to an object key at
`static/v1/<full-sha256>.<extension>`. It deliberately contains no byte sizes, MIME types, hashes, source paths, or
native-bundle flags: the publisher derives that rich metadata directly from the source files, while web clients ship
only what URL resolution needs. Board art is exactly the `/images/**/*.webp` portion of the map, so native packaging
can derive its inputs without a separate flag. A tiny generated shell catalog duplicates only the seven logo and app
icon keys so global chrome does not pull the complete board-image map into every browser route.

Changing bytes in place creates a new URL; old objects remain valid for old deployments. Objects use their real image content type and
`Cache-Control: public, max-age=31536000, immutable`.

After adding or changing an image, run:

```sh
vp run generate:static-assets
vp run check:static-assets
```

Commit both generated catalog files. CI regenerates the compact map and shell keys and fails when an input or either
generated artifact is stale.
Checked-in Expo public files retain their existing URLs for local and PR exports. The Expo export patcher switches
its shell and PWA manifest icons to cataloged CDN URLs only when `EXPO_PUBLIC_STATIC_ASSET_BASE_URL` is set, as it
is in the production workflow.

## Moving to R2 (in progress)

`assets.boardsesh.com` is the last public read path still on Tigris, and Tigris serves it badly. Measured from a
Cloudflare `SYD` PoP on 2026-09-15:

| Host | Store | Protocol | conn | TTFB | 119 KB webp |
| --- | --- | --- | --- | --- | --- |
| `media.boardsesh.com` | R2 | HTTP/2 | 22 ms | — | — |
| `assets.boardsesh.com` | Tigris | **HTTP/1.1** | 183 ms | **614 ms** | **1.08 s** |

`X-Tigris-Served-From: sjc1` on every response: one region, no edge cache — the custom domain is deliberately
grey-clouded because Tigris cannot sit behind a TLS-terminating proxy. HTTP/1.1 compounds it, capping browsers at
~6 connections to the host. 24 catalogued images at 6-way parallel measured **4.62 s**.

### The CORS difference, which is the dangerous part

Tigris and R2 do not answer CORS the same way, and Cloudflare's cache turns the difference into a silent bug.
Measured the same day:

```
assets.boardsesh.com (Tigris)  access-control-allow-origin: *      # on EVERY response
media.boardsesh.com  (R2)      (no ACAO header at all)             # R2 answers CORS only when the request has Origin
```

The catalogue is read both ways. A plain `<img src>` sends no `Origin`; `ensureImagesPreloaded` in
`packages/web/app/lib/board-render-worker/worker-manager.ts` does a real `fetch()` for every board background. Those
share one cache key, and Cloudflare does not key its cache on `Vary` below Enterprise — so the `<img>` response, with
no ACAO, can be the copy served to the `fetch()`. That fails CORS, the failure is swallowed
(`console.warn('Failed to preload background image')`), and the board renders with no background for as long as the
colo holds the object: a year, given `immutable`, with no purge tooling and no `Zone.Cache Purge` scope on the token.

Two things fix it, and both ship before the hostname moves:

- the bucket's own CORS policy (`PUBLIC_IMAGE_CORS`, `GET`/`HEAD` from `*`), converged by `vp run cf:apply`;
- a response-header transform rule setting `access-control-allow-origin: *` **unconditionally** at the edge, so no
  cached copy can lack it whichever request shape populated it.

`allowedOrigins` is `['*']` on purpose. An origin list would make R2's answer vary by request, and with `Vary`
ignored, whichever copy won the race would be served to every origin.

### Cutover

The keys are `static/v1/<sha256>` — content-addressed, immutable, written only when missing, never deleted. Tigris
and R2 can therefore hold the identical catalogue simultaneously, which is what makes every step reversible and the
flip itself a non-event.

1. **Dashboard.** Create an R2 API token scoped to `boardsesh-static-assets`. Add `Zone.Transform Rules Edit` to
   `CLOUDFLARE_API_TOKEN`, re-adding every existing scope in the same edit — editing a token replaces all its policies.
2. **Merge the prepare change** (this one). `cf:apply` creates the bucket. Note it creates and returns: the custom
   domain attaches on the *next* run, which is why the flip is not repo-driven (see step 5).
3. **Run `cf:apply` again** to attach `assets-r2.boardsesh.com` and converge CORS, the cache rule and the header rule.
4. **Dual-publish and validate through staging** — the real gate:
   ```sh
   STATIC_ASSETS_PUBLIC_BASE_URL=https://assets-r2.boardsesh.com \
   STATIC_ASSETS_S3_BUCKET_NAME=boardsesh-static-assets \
   STATIC_ASSETS_AWS_ENDPOINT_URL=https://<account>.r2.cloudflarestorage.com \
   STATIC_ASSETS_AWS_REGION=auto \
   STATIC_ASSETS_AWS_ACCESS_KEY_ID=... STATIC_ASSETS_AWS_SECRET_ACCESS_KEY=... \
     vp run upload:static-assets
   ```
   This uploads all 365 objects and puts every one through both the signed `HEAD` and the public `GET` — SHA-256,
   MIME, immutable caching, CORS with an `Origin`, and the sampled CORS probe **without** one. It is also what proves
   the two R2 behaviours this repo cannot assert from source: that `HeadObject` returns `ChecksumSHA256`
   (`assertRemoteStaticAssetMetadata` throws without it) and that `PutObject` honours `If-None-Match: *`
   (`putImmutableObjectIfMissing` maps the 412 to "already present"). Every reader is still on Tigris throughout.
5. **The flip.** Attach `assets.boardsesh.com` to the bucket **in the dashboard**, then repoint the bucket's
   `customDomain` in `infra/cloudflare/config.ts` and drop the record from `dnsRecords` so R2 owns it, as it already
   does for `media.boardsesh.com`. Dashboard first because `applyR2Bucket` needs two passes, and the gap between them
   would leave the hostname proxied at R2 with nothing attached — 404 on every board image.
   Switch the five `STATIC_ASSETS_*` Production secrets to R2 in the same window, then dispatch Production Deploy to
   force a full-catalogue `sync-static-assets` against the live hostname (the flip touches no static-asset path, so
   the change detector would otherwise skip it).

Repointing `customDomain` also turns on the `cf-ray` assertion in the publisher by itself — `expectsCloudflareOrigin`
reads `desiredR2Buckets`, so there is no second switch to remember. That assertion is the replacement for the
"is it proxied?" DNS check, which goes away with the record.

**Rollback decays.** Before the flip, every step is "do nothing" or "detach in the dashboard". After it, reverting the
DNS is good for roughly 60 days: Tigris renews the custom domain's certificate off the live CNAME, which will be
pointing at Cloudflare, and renewal breaks within a couple of months.

## Bucket setup (Tigris — current, until the cutover above completes)

Create a dedicated public Tigris bucket for `assets.boardsesh.com`. Do not reuse the snapshot, OTA, or user-upload
buckets. Configure it with:

- public object reads, but no public bucket listing;
- CORS methods `GET` and `HEAD`, allowed origin `*`, and no credentials (board workers fetch these public images
  cross-origin);
- a CI key allowed to list the bucket and put/head objects under `static/v1/`, without delete permission;
- deletion protection or an equivalent operator guard. The publisher never deletes an object.

Register `assets.boardsesh.com` as the bucket's custom domain in Tigris, then let the repo-managed Cloudflare apply
create its verification/delivery record:

```text
assets.boardsesh.com CNAME boardsesh-static-assets.t3.tigrisbucket.io
TTL: automatic
Proxy status: DNS only
CNAME flattening: disabled
```

The desired DNS state lives in `infra/cloudflare/config.ts` and is converged by `vp run cf:apply -- --apply`. It
creates the record when missing and repairs its type, target, TTL, or proxy flag when drifted. Keep the record
DNS-only: Tigris owns TLS and global object delivery, and there is intentionally no Cloudflare cache rule for this
hostname. It also disables per-record CNAME flattening and fails closed if Cloudflare's zone-wide **Flatten all
CNAMEs** setting would override that record. Wait for Tigris to report the custom-domain certificate active and
verify public reads before the first catalog publication. Tigris's S3 API endpoint is for signed publishing;
browsers must use `assets.boardsesh.com`.

Set these secrets on GitHub's protected `Production` environment:

- `STATIC_ASSETS_S3_BUCKET_NAME`
- `STATIC_ASSETS_AWS_ACCESS_KEY_ID`
- `STATIC_ASSETS_AWS_SECRET_ACCESS_KEY`
- `STATIC_ASSETS_AWS_ENDPOINT_URL`
- `STATIC_ASSETS_AWS_REGION` (`auto` for Tigris)

Use Tigris's standard `https://t3.storage.dev` S3 endpoint. The publisher follows Tigris's virtual-hosted request
style, so the bucket name becomes part of the signed request host. The production workflow keeps both public build
origins pinned to the same catalog origin:

- `NEXT_PUBLIC_STATIC_ASSET_BASE_URL=https://assets.boardsesh.com` for Next.js;
- `EXPO_PUBLIC_STATIC_ASSET_BASE_URL=https://assets.boardsesh.com` for Expo web.

Those values are public build inputs, not credentials. A CI contract test keeps them aligned with
`STATIC_ASSET_ORIGIN` in `@boardsesh/static-assets`.

## Main deployment

The serialized `production-deploy.yml` change detector selects `sync-static-assets` only when a catalog input or
publisher changes. The job lists existing immutable keys, uploads only missing hashes at no more than five request
starts per second, and validates every unique catalog object through both signed S3 `HEAD` and a public CDN `GET` (including
SHA-256, MIME type, immutable caching, and CORS). Each public CDN attempt has a 30-second deadline. CDN propagation
failures (404, 429, 5xx, network errors, timeouts, or stale headers/body) retry up to six times with bounded
exponential jitter; permanent 4xx responses fail immediately. The complete `sync-static-assets` job has a 10-minute
timeout so a stalled storage or CDN connection cannot hold the serialized production deployment indefinitely.
When Cloudflare desired state changes in the same deployment, `sync-static-assets` waits for `deploy-cloudflare`,
preventing public validation from racing DNS convergence. A successful or legitimately skipped Cloudflare job allows
publication; a failed or cancelled prerequisite explicitly fails `sync-static-assets` so downstream builds cannot
mistake a dependency skip for permission to deploy unvalidated catalog URLs.

After every object passes, it writes `static/v1/manifest.json` as a short-cached audit record. Seeing a new audit
manifest therefore means all assets it names passed publication QA. A failed upload blocks web/Expo-web artifacts
that might reference it. Partial immutable uploads are harmless and the next main run converges without overwriting
them.

Credential-free local inspection is available with:

```sh
vp run upload:static-assets -- --dry-run
```

Main is the only publisher. PR and branch previews stay on same-origin/local assets and never receive production
bucket credentials.

### First deployment

Provision the empty bucket, public-read policy, CORS, Tigris custom-domain registration, repo-managed DNS, and
Production secrets before merging the first catalog change. Confirm the Tigris custom-domain certificate is active
before rerunning the deployment. The first main deployment uploads and validates the complete catalog before either
web build starts.
Until that job succeeds, previews continue using their committed same-origin files and production remains on the
previous deployment. Later runs upload only new content hashes but still validate the complete published catalog.

## Recovery and retention

Never remove or overwrite a content-addressed object during routine cleanup. Older Vercel and Expo web rollbacks can
retain an older catalog indefinitely. If publication fails, fix credentials, CORS, DNS, or the object metadata and
rerun the production workflow; already uploaded hashes are reused.

If an object under a hash key has the wrong size or metadata, the publisher fails closed instead of replacing it.
Investigate the bucket, then restore the exact cataloged bytes under that key. A source correction should normally be
committed as new bytes, producing a new immutable key.
