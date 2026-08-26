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

## Bucket setup

Create a dedicated public Tigris bucket for `assets.boardsesh.com`. Do not reuse the snapshot, OTA, or user-upload
buckets. Configure it with:

- public object reads, but no public bucket listing;
- CORS methods `GET` and `HEAD`, allowed origin `*`, and no credentials (board workers fetch these public images
  cross-origin);
- a CI key allowed to list the bucket and put/head objects under `static/v1/`, without delete permission;
- deletion protection or an equivalent operator guard. The publisher never deletes an object.

Map the custom domain only after its TLS certificate and public reads work. Tigris's S3 API endpoint is for signed
publishing; browsers must use `assets.boardsesh.com`.

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

Provision the empty bucket, public-read policy, CORS, custom domain, and Production secrets before merging the first
catalog change. The first main deployment uploads and validates the complete catalog before either web build starts.
Until that job succeeds, previews continue using their committed same-origin files and production remains on the
previous deployment. Later runs upload only new content hashes but still validate the complete published catalog.

## Recovery and retention

Never remove or overwrite a content-addressed object during routine cleanup. Older Vercel and Expo web rollbacks can
retain an older catalog indefinitely. If publication fails, fix credentials, CORS, DNS, or the object metadata and
rerun the production workflow; already uploaded hashes are reused.

If an object under a hash key has the wrong size or metadata, the publisher fails closed instead of replacing it.
Investigate the bucket, then restore the exact cataloged bytes under that key. A source correction should normally be
committed as new bytes, producing a new immutable key.
