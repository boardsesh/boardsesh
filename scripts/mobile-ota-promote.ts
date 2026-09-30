/// <reference types="node" />

/**
 * Promote the archived, already-exported main OTA to the existing production branch.
 * xprem cannot republish across branches. This speaks the same upload/finalize
 * protocol as eoas@3.2.6, but never runs Expo export again. That protocol changed
 * at 3.2.0: requestUploadUrl takes a `files` list (path, content hash, md5 cache
 * key and role) instead of `fileNames`, and a server on either side of that line
 * rejects the other shape, so this file moves with EOAS_PACKAGE_SPEC. The pipeline must first
 * verify that the staged commit's GraphQL schema is live.
 *
 * vp exec tsx scripts/mobile-ota-promote.ts --receipt ota-stage/receipt.json \
 *   --ios-export ota-stage/ios --android-export ota-stage/android
 *
 * `--branch <name>` (default `production`) promotes to another branch of the same
 * channel, and `--capture-baseline` takes the same flag. The channel is always
 * `production`: it is baked into every binary, and a device reaches another
 * branch only through the `xprem-branch` header.
 *
 * `--rollout-percentage <1-99> --rollout-receipt <path>` starts the update as a
 * rollout to that share of devices. A rollout cannot be confirmed through the
 * anonymous manifest, which serves one device's view, so this mode reads the
 * rollout itself and needs the admin login (`OTA_ADMIN_EMAIL`,
 * `OTA_ADMIN_PASSWORD`) next to `EOO_TOKEN`. For the same reason it does NOT run
 * the served-bytes check the default mode ends with: it confirms that the leased
 * update is rolling out, and the bytes are covered only by the content hashes
 * the server validated at upload.
 *
 * It is safe to re-run. The update ids it was leased are written to the rollout
 * receipt, and a platform whose live rollout carries its recorded id (and its
 * commit) counts as done. Any other live rollout is refused.
 */

import { createHash, randomUUID } from 'node:crypto';
  // A promotion is a publication too: re-confirm processing for the exact
  // archived maps before any production upload lease can be requested.
  const receipt = parseStageReceipt(JSON.parse(readFileSync(args.receipt, 'utf8')) as unknown);
  assertSourceMapExportHashes(args.iosExport, receipt.platforms.ios.fileHashes);
  assertSourceMapExportHashes(args.androidExport, receipt.platforms.android.fileHashes);
  const mobileDir = resolve('packages/mobile');
  for (const platform of ['ios', 'android'] as const) {
    const promotionRoot = join(mobileDir, 'diagnostic-artifacts', 'promotion');
    mkdirSync(promotionRoot, { recursive: true });
    const outputDir = mkdtempSync(join(promotionRoot, `${platform}-`));
    cpSync(platform === 'ios' ? args.iosExport : args.androidExport, outputDir, { recursive: true });
    uploadMobileSourceMaps({ platform, mobileDir, outputDir });
  }
