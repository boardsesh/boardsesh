# MoonBoard OCR

Extract MoonBoard climb data from screenshots in Node.js or a browser.

## Node.js

The default `@boardsesh/moonboard-ocr` entry uses Sharp for image processing and
requires Node.js 20.9.0 or newer.

## Browser

Import `@boardsesh/moonboard-ocr/browser` for the browser-safe parser. It uses
the Canvas image processor and does not load Sharp.
