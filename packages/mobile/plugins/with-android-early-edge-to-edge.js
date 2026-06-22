const { createRunOncePlugin, withMainActivity } = require('expo/config-plugins');

const KOTLIN_IMPORTS = [
  'import android.graphics.Color',
  'import android.os.Build',
  'import android.view.WindowManager',
  'import androidx.core.view.WindowCompat',
  'import androidx.core.view.WindowInsetsControllerCompat',
  'import com.facebook.react.views.view.setEdgeToEdgeFeatureFlagOn',
];

const HELPER_NAME = 'enableBoardseshEarlyEdgeToEdge';
const ENABLE_CALL = `    ${HELPER_NAME}()`;

const KOTLIN_HELPER = `

  private fun ${HELPER_NAME}() {
    setEdgeToEdgeFeatureFlagOn()
    WindowCompat.setDecorFitsSystemWindows(window, false)

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      window.isStatusBarContrastEnforced = false
      window.isNavigationBarContrastEnforced = true
    }

    window.statusBarColor = Color.TRANSPARENT
    window.navigationBarColor = Color.TRANSPARENT
    WindowInsetsControllerCompat(window, window.decorView).isAppearanceLightNavigationBars = false

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      window.attributes.layoutInDisplayCutoutMode =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
          WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
        } else {
          WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
        }
    }
  }
`;

function addKotlinImport(contents, importLine) {
  if (contents.includes(importLine)) {
    return contents;
  }

  const importMatches = [...contents.matchAll(/^import .+$/gm)];
  const lastImport = importMatches.at(-1);
  if (lastImport?.index !== undefined) {
    const insertAt = lastImport.index + lastImport[0].length;
    return `${contents.slice(0, insertAt)}\n${importLine}${contents.slice(insertAt)}`;
  }

  return contents.replace(/^(package [^\n]+\n)/m, `$1\n${importLine}\n`);
}

function addEarlyAndroidEdgeToEdge(contents) {
  let nextContents = contents;

  for (const importLine of KOTLIN_IMPORTS) {
    nextContents = addKotlinImport(nextContents, importLine);
  }

  if (!nextContents.includes(ENABLE_CALL)) {
    nextContents = nextContents.replace(
      /^(\s*)super\.onCreate\(([^)]*)\)/m,
      (_, indent, argumentsSource) => `${indent}${HELPER_NAME}()\n${indent}super.onCreate(${argumentsSource})`,
    );
  }

  if (!nextContents.includes(ENABLE_CALL)) {
    throw new Error('Unable to inject early edge-to-edge setup: MainActivity.kt has no super.onCreate call.');
  }

  if (!nextContents.includes(`private fun ${HELPER_NAME}()`)) {
    nextContents = nextContents.replace(/\n}\s*$/, `${KOTLIN_HELPER}\n}\n`);
  }

  return nextContents;
}

function withAndroidEarlyEdgeToEdge(config) {
  return withMainActivity(config, (modConfig) => {
    if (modConfig.modResults.language !== 'kt') {
      throw new Error('with-android-early-edge-to-edge expects a Kotlin MainActivity.');
    }

    modConfig.modResults.contents = addEarlyAndroidEdgeToEdge(modConfig.modResults.contents);
    return modConfig;
  });
}

module.exports = createRunOncePlugin(withAndroidEarlyEdgeToEdge, 'with-android-early-edge-to-edge', '1.0.0');
module.exports.addEarlyAndroidEdgeToEdge = addEarlyAndroidEdgeToEdge;
module.exports.HELPER_NAME = HELPER_NAME;
