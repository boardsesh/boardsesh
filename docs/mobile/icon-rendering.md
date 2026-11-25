# Material icons on Android

Android renders the app's Material Design icons with `react-native-svg`. The
outlines come from the existing, pinned MaterialCommunityIcons font. Toolbar,
tab-bar, tablet-rail and react-native-paper icons share this renderer. iOS SF
Symbols and the iOS/browser Material font renderer keep their existing behavior.

This avoids blank Android buttons when the icon font cannot load after an
update (#8197). The reported OxygenOS trigger has not been reproduced; SVG
rendering removes the runtime font dependency rather than relying on retries.
Android startup no longer waits for an icon font.

## Adding an icon

Add its MaterialCommunityIcons name to the semantic icon map or its consumer,
then regenerate from the repository root:

```sh
uv run --with fonttools==4.62.1 scripts/generate-mobile-icon-paths.py
vp check --fix packages/mobile/src/components/material-icon-paths.ts
```

The generator reads installed workspace dependencies. It includes names used by
app components/providers and Paper's built-in controls, and rejects a different
vector-icons version until its pin is reviewed. The generated name union makes
missing semantic and navigation icons a type error. The font's 512-unit square
is converted to SVG coordinates using its 448-unit ascent.

The outlines retain the upstream Pictogrammers license:
[Material Design Icons licensing](https://pictogrammers.com/docs/general/license/).
