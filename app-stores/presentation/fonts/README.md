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
