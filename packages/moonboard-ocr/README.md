# MoonBoard screenshot parser

The shared parser runs locally with Sharp/Tesseract in Node or Canvas/Tesseract in
the browser. Accessibility metadata is a separate input to the Android collector;
it is not substituted into this library's OCR results.

## Board-aware parsing

Pass the upstream `holdsetup` ID, **not** a Boardsesh layout ID:

| holdsetup | Board | Grid |
| --- | --- | --- |
| 23 | MoonBoard 2010 | 11 × 18 |
| 1 | MoonBoard 2016 | 11 × 18 |
| 15 | MoonBoard Masters 2017 | 11 × 18 |
| 17 | MoonBoard Masters 2019 | 11 × 18 |
| 21 | MoonBoard 2024 | 11 × 18 |
| 19 | Mini MoonBoard 2020 | 11 × 12 |
| 22 | Mini MoonBoard 2025 | 11 × 12 |

```ts
import { parseScreenshot } from '@boardsesh/moonboard-ocr';

const result = await parseScreenshot('/private/climb.png', {
  holdsetup: 22,
  screenshotProfile: 'android-pixel8pro-1.3.68',
});
```

The Android profile is calibrated for Moon Climbing **1.3.68**, stock Pixel 8 Pro,
**1008 × 2244** screenshots. Other dimensions fail closed. Mini boards have a
shorter, vertically centered grid; selecting 12 rows without changing the crop is
incorrect. Do not infer the setup from the detected holds: the caller must verify
the board in the app's information panel.

The original full-size/iOS behavior remains the default (`holdsetup: 21`,
`screenshotProfile: 'legacy-ios'`). Mini iOS screenshots are **not calibrated** and
are rejected. A declared profile is not automatic board recognition or evidence
that an arbitrary screenshot is from that board.

The browser `parseScreenshot` accepts the same options as its second argument.
Both Node and browser `parseMultipleScreenshots` accept options as their third
argument, after the progress callback. A shared `scheduler` can be supplied to
reuse a Tesseract worker across a batch.

```sh
vp exec tsx packages/moonboard-ocr/src/cli.ts parse /private/screenshots \
  --holdsetup 22 --screenshot-profile android-pixel8pro-1.3.68 \
  --no-dedupe --output /private/parsed-climbs.json
```

For accuracy evaluation, retain every input, parse error and warning. Do not use
hold-based deduplication to reduce the denominator. `success: true` means a parse
was produced, not that its holds/metadata are complete or safe to import. The
parser defaults an unreadable angle to 40 degrees; matching that value alone is
not an angle-recognition accuracy test. English OCR cannot reliably preserve every
Unicode name; the Android collector uses public accessibility labels separately.

The companion `moonboard-scraper` repository's `android_ocr_validate.py` collects
read-only screenshots, matches old references by board/name/setter independently
of holds, and compares against this parser using the existing catalog importer's
mapping. It emits private review reports only and cannot write a database. See
that repository's `OCR_VALIDATION.md` for measured device coverage and results.

## Regression tests

```sh
vp test run --project moonboard-ocr --reporter=agent
vp exec tsc --noEmit -p packages/moonboard-ocr/tsconfig.json
```

Synthetic geometry tests verify every cell and Mini row limits; they do not count
as real-app accuracy evidence. Existing iOS fixture tests remain unchanged.
