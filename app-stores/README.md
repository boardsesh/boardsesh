# App store assets

Submission assets and listing copy for the `packages/mobile` React Native app,
grouped by store. (This is **not** the old Capacitor app under the top-level
`mobile/` directory.)

```
app-stores/
  apple/
    app-store-submission-guide.md   # how to submit to App Store Connect
    app-store-metadata.md           # listing copy: name, subtitle, keywords, description
    screenshots/<app-store-locale>/<device>/ # generated on demand, gitignored
  google/
    play-store-submission-guide.md
    play-store-metadata.md
    screenshots/<device>/           # generated on demand, gitignored (not committed)
```

## Screenshots

The screenshots are captured from the real native app by the Maestro pipeline:

```bash
vp run mobile:screenshots -- --platform ios --backend prod --theme dark --devices common --locales all
vp run mobile:screenshots -- --platform android --backend prod --theme dark --app-path /path/to/app.apk
```

Apple screenshots are written to
`app-stores/apple/screenshots/<app-store-locale>/<device>/`. `--locales all`
captures the app locales `en-US`, `es`, `fr`, and `de`, then writes App Store
Connect folders `en-US`, `es-ES`, `es-MX`, `fr-FR`, and `de-DE`. `--devices
common` captures the full App Store matrix: the three iPhone portrait slots plus
13-inch and 11-inch iPad landscape slots. Use `--devices phones` or `--devices
ipads` for narrowed local capture.

Google Play screenshots are written to `app-stores/google/screenshots/<device>/`.
Dark is the default; pass `--theme light` for a light set. See
`packages/mobile/.maestro/README.md` for prerequisites and how it works.

The captured PNGs are **gitignored** — they're regenerated on demand and uploaded
to App Store Connect / Google Play by the `Mobile Screenshots (Native)` workflow
(run it with `upload = true`). See the Apple and Google submission guides for
store-specific upload notes.
