# Screenshot fonts

Roboto Regular and Bold are used only by the store screenshot compositor.
They do not ship in the app.

Source: https://github.com/googlefonts/roboto-2/tree/38062f4b4a0be4346d07a928408da21602545e9e/src/hinted

License: Apache 2.0, reproduced in Roboto-LICENSE.txt.
Pinning the font bytes keeps captions independent of runner-installed fonts.

## App Store showcase campaign

Inter Tight Regular (400), Inter Tight Bold (700), and Instrument Serif Italic
match the homepage showcase. Their TTF files were derived from the pinned WOFF2
files in `marketing/showcase-video/fonts/` with fontTools: instantiate Inter
Tight at the stated weights, clear the WOFF2 flavor, and save as TrueType.
Instrument Serif is already a static face and only needs the container conversion.
The original OFL licenses are included next to these files.

`fonts.conf` restricts the compositor's Fontconfig catalogue to these pinned
faces (and the legacy Roboto files). This also makes mixed Inter/Instrument
headlines work on macOS hosts without a system Fontconfig configuration.

## Simplified Chinese captions

`NotoSansSC-Regular.ttf` and `NotoSansSC-Bold.ttf` are 400/700 subsets of
[Google Fonts Noto Sans SC](https://github.com/google/fonts/tree/a85815a42757630ce188fdad368c2dfc444d4773/ofl/notosanssc),
licensed under the SIL Open Font License in `OFL-NotoSansSC.txt`. They are used
by the screenshot compositor and do not ship in the app.

The modified subsets use the family name **Boardsesh Screenshot CJK**. They
contain ASCII and every non-control character in `presentation/zh-CN.json`.
Fontconfig appends this family after Roboto, Inter Tight and Instrument Serif,
keeping existing Latin faces and providing Chinese glyphs for normal, bold and
emphasized captions. Glyph coverage tests fail if new captions need more glyphs.

Regenerate after changing Chinese caption characters:

```sh
curl -fL 'https://raw.githubusercontent.com/google/fonts/a85815a42757630ce188fdad368c2dfc444d4773/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf' -o /tmp/NotoSansSC-variable.ttf
uv run --with fonttools==4.60.1 python scripts/subset-screenshot-cjk-font.py /tmp/NotoSansSC-variable.ttf
vp test run --reporter=agent --project scripts screenshot-cjk-font
```

The generator verifies the upstream SHA-256 before subsetting:
`a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da`.
