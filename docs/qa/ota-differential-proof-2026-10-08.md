# Production differential-update proof, 2026-10-08

Both production BSDIFF patches reconstructed byte-for-byte to independently downloaded full target
bundles. Their SHA-256 hashes also matched the public target manifests and deployment export receipts.
This was a read-only measurement at 22:10–22:16 UTC, independently reviewed and replayed with
`/usr/bin/bspatch`. No production publication or admin operation was performed for this proof.

| Platform | Base bytes | Target bytes | Measured target gzip bytes | Patch bytes | Patch / gzip |
| --- | ---: | ---: | ---: | ---: | ---: |
| iOS | 21,683,984 | 21,685,656 | 8,422,844 | 1,544,929 | 18.34% |
| Android | 21,775,996 | 21,791,648 | 8,497,809 | 1,736,047 | 20.43% |

Gzip transfers used `Accept-Encoding: gzip` without automatic decompression. Decompressed bodies
matched the public raw targets. These are measured transfer sizes, not dashboard `fullDownloadSize`.

## Provenance

The base export came from [Production Deploy 37846960807](https://github.com/boardsesh/boardsesh/actions/runs/37846960807),
main SHA `58c2b12be4ba1071cdde01f2793d40b69565ec83`, artifact `11581026167`.
The target came from [Production Deploy 37847564059](https://github.com/boardsesh/boardsesh/actions/runs/37847564059),
main SHA `1fc59ae2ae2fc47ed16eae29a32bfeaafdee4ba6`, artifact `11581018145`.
Both runs successfully promoted and verified their OTAs; both overall deployments failed elsewhere.
They prove the published bytes, and are not claimed as successful whole deployments or controller candidates.

| Platform | Runtime | Base UUID | Target UUID |
| --- | --- | --- | --- |
| iOS | `7b19b77453b47611f22e6c003e119b8409a01e4a` | `5759e0f6-9d00-fb15-2703-1a58bb4d9ad0` | `2e40cf06-a064-b32a-ca0d-d3fc653c10a4` |
| Android | `a1a06c324613d09baa90dfc1b337989b78b33b1c` | `35bc77d3-0c11-5b47-7754-ff2875bcdb7c` | `977b6243-cb4c-48a8-044d-92d8f02d0e5f` |

| Platform | Base SHA-256 | Reconstructed / full target / receipt SHA-256 |
| --- | --- | --- |
| iOS | `8f2064664723ec60d13b68f306e5408f8aed480e259e39e6add2fdab2fd608fe` | `8b6822a4260c384314edfc2b72da1db7cca5bb57234d9459c2536e11ce754b22` |
| Android | `5e30b0dca64241acf5e0b37b4f824536639c79fa910fe6af06c5902fb81cd0aa` | `af71acf053c2e341d639e1229407dcfb4dd86a8561fc03cdd42acfed81e409e4` |

## Request and verification

The production manifest request to `https://updates.boardsesh.com/manifest` used protocol `1`,
platform and runtime above, channel `production`, empty `xprem-branch`, and app ID
`007e6fd7-f200-448c-9449-8d48ba5d51fc`. Its launch asset hashes were
`i2gipCYMOEMU7fwrctodt8ylu1cjTZRZwlNuEc51SyI` (iOS) and
`r3Gs8FPC40HWOeEilAfc-03YaoVh_APN1CrP7YHkCeQ` (Android).

Patch requests used that manifest's launch asset URL and the same headers, plus
`Expo-Requested-Update-ID: <target UUID>`, `Expo-Current-Update-ID: <base UUID>`,
`A-IM: bsdiff` and `Accept-Encoding: identity`. Both returned HTTP 200 directly from the OTA origin,
`im: bsdiff`, `expo-base-update-id` matching the requested base, `cache-control: private, no-store`,
and `BSDIFF40` bodies. Neither patch redirected to the CDN.

Independently downloaded full base and target assets matched their archived export files and receipt
hashes. Applying each patch to the public full base with `bspatch base.bundle rebuilt.bundle patch`
produced the exact public full target. The target receipt's production baseline UUIDs, the actual patch
response's base UUID and this reconstruction establish the UUID-to-byte link; chronology alone does not.

## Remaining acceptance work

This verifies one recent pair for each current native runtime. It does not establish store-fleet
patch adoption, five-day history coverage, native launch timings, emergency-launch rates, all server
patch-job states, or publish memory. Manifest RSA signatures and archive ZIP digests were not separately
verified; extracted bundle hashes, HTTPS provenance and reconstruction were verified.

Keep [#6098](https://github.com/boardsesh/boardsesh/issues/6098) open for those measurements and the
24-hour fleet speed targets. Keep the launch timeout at ten seconds until its acceptance criteria pass.
