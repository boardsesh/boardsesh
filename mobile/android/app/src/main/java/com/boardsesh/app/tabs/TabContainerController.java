package com.boardsesh.app.tabs;

import android.app.Activity;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import android.widget.FrameLayout;

import androidx.annotation.MainThread;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import org.json.JSONObject;

import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Orchestrates the native bottom-tab-bar experience: owns one WebView per
 * tab (the Capacitor bridge for "climbs", four satellite WebViews for the
 * rest), the {@link NativeTabBarView}, and all of the show/hide, lazy-load,
 * cross-tab navigation, and memory-pressure logic.
 *
 * <p>Mirror of {@code MultiWebViewController.swift}. The "create" tab has
 * no dedicated webview — taps fire a {@code boardsesh:native-tab-tapped}
 * event into the active webview and let the web layer handle the action.
 */
public final class TabContainerController {

    private static final String TAG = "TabContainerController";

    private static final List<String> TAB_ORDER =
        Collections.unmodifiableList(Arrays.asList("home", "climbs", "library", "feed", "you"));

    private static final Map<String, String> TAB_INITIAL_PATHS;
    static {
        Map<String, String> paths = new HashMap<>();
        paths.put("home", "/");
        paths.put("climbs", "/");
        paths.put("library", "/playlists");
        paths.put("feed", "/feed");
        paths.put("you", "/you");
        TAB_INITIAL_PATHS = Collections.unmodifiableMap(paths);
    }

    /** Loading priority after the active tab finishes loading. Climbs is excluded — Capacitor self-loads. */
    private static final List<String> DEFERRED_LOAD_ORDER =
        Collections.unmodifiableList(Arrays.asList("feed", "library", "you"));

    private static final long DEFERRED_LOAD_STAGGER_MS = 500L;

    private final Activity activity;
    private final ViewGroup tabContainer;
    private final WebView climbsWebView;
    private final ViewGroup tabBarHost;
    private final String serverUrl;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private final Map<String, WebView> tabWebViews = new HashMap<>();
    private final Map<String, SatelliteBridge> satelliteBridges = new HashMap<>();
    private final Set<String> loadedTabs = new HashSet<>();
    private final Map<String, String> pendingNavigationUrls = new HashMap<>();

    private NativeTabBarView tabBarView;
    private String activeTab = "home";
    private int lastInjectedTabBarHeightPx = 0;
    private boolean hasDeferredLoadsStarted = false;
    @Nullable
    private Uri pendingUniversalLink;

    /**
     * @param activity        host activity (for context + layout inflation)
     * @param tabContainer    the FrameLayout where satellite WebViews are added; the
     *                        Capacitor (climbs) WebView is already a child of it.
     * @param tabBarHost      the FrameLayout where the {@link NativeTabBarView} is mounted.
     * @param climbsWebView   the Capacitor bridge's WebView (treated as the climbs tab).
     * @param serverUrl       base server URL (e.g. {@code https://www.boardsesh.com}).
     */
    public TabContainerController(
        @NonNull Activity activity,
        @NonNull ViewGroup tabContainer,
        @NonNull ViewGroup tabBarHost,
        @NonNull WebView climbsWebView,
        @NonNull String serverUrl
    ) {
        this.activity = activity;
        this.tabContainer = tabContainer;
        this.tabBarHost = tabBarHost;
        this.climbsWebView = climbsWebView;
        this.serverUrl = stripTrailingSlash(serverUrl);

        tabWebViews.put("climbs", climbsWebView);
        // Capacitor begins loading from server.url as soon as the activity is up,
        // so treat the climbs tab as already loaded.
        loadedTabs.add("climbs");

        setupSatelliteWebViews();
        setupTabBar();
        applyInsets();

        // Default tab is home. Climbs starts hidden.
        climbsWebView.setVisibility(View.GONE);
        loadTab("home");
    }

    public String getActiveTab() {
        return activeTab;
    }

    public NativeTabBarView getTabBarView() {
        return tabBarView;
    }

    /**
     * Maps a URL pathname to the corresponding tab key. Stays byte-for-byte
     * in sync with {@code packages/web/app/lib/tab-routing.ts#getActiveTab}
     * and {@code MultiWebViewController.tabForPath} on iOS.
     */
    @NonNull
    public static String tabForPath(@Nullable String path) {
        if (path == null || path.isEmpty()) return "climbs";
        if ("/".equals(path)) return "home";
        if (path.endsWith("/create")) return "create";
        if (path.startsWith("/feed")) return "feed";
        if (path.startsWith("/you")) return "you";
        if (path.startsWith("/playlists")) return "library";
        return "climbs";
    }

    /** Stash a universal link URL received before the controller was ready. */
    public void setPendingUniversalLink(@Nullable Uri uri) {
        this.pendingUniversalLink = uri;
    }

    public void loadPendingUniversalLink() {
        Uri uri = pendingUniversalLink;
        if (uri == null) return;
        pendingUniversalLink = null;

        String path = uri.getPath();
        String tab = tabForPath(path);
        String targetTab = "create".equals(tab) ? "climbs" : tab;
        navigateToTab(targetTab, uri.toString());
    }

    @MainThread
    public void handleTabTap(@NonNull String tab) {
        if ("create".equals(tab)) {
            // Create has no dedicated webview — fire the event into the active tab.
            dispatchTabTappedEvent(tab, activeTab);
            return;
        }
        if (tab.equals(activeTab)) {
            // Same-tab tap: scroll-to-top semantics, dispatch event without switching.
            dispatchTabTappedEvent(tab, activeTab);
            return;
        }
        switchToTab(tab);
        dispatchTabTappedEvent(tab, tab);
    }

    @MainThread
    public void switchToTab(@NonNull String tab) {
        if (tab.equals(activeTab)) return;
        if (!TAB_ORDER.contains(tab)) {
            Log.w(TAG, "Attempted to switch to unknown tab: " + tab);
            return;
        }

        hideWebView(activeTab);
        showWebView(tab);

        activeTab = tab;
        tabBarView.setActiveTab(tab);
        loadTab(tab);

        // Keep the tab bar above whichever webview just became visible.
        tabBarHost.bringToFront();
    }

    /**
     * Switch to the given tab (if different from current) and navigate it to
     * {@code url}. Mirrors {@code MultiWebViewController.navigateToTab}: if the
     * target webview is already loaded, a {@code boardsesh:navigate} event is
     * dispatched (preserves React state); otherwise the URL is queued and used
     * as the initial load URL.
     */
    @MainThread
    public void navigateToTab(@NonNull String tab, @NonNull String url) {
        String targetTab = "create".equals(tab) ? activeTab : tab;

        if (!targetTab.equals(activeTab)) {
            switchToTab(targetTab);
        }

        WebView wv = tabWebViews.get(targetTab);
        if (wv == null) {
            Log.e(TAG, "No webview for tab " + targetTab + " — cannot navigate to " + url);
            return;
        }

        if (loadedTabs.contains(targetTab)) {
            String escaped = SatelliteBridge.jsEscape(url);
            String js = "window.dispatchEvent(new CustomEvent('boardsesh:navigate',{detail:{url:\"" + escaped + "\"}}));";
            wv.evaluateJavascript(js, null);
        } else {
            pendingNavigationUrls.put(targetTab, url);
            loadTab(targetTab);
        }
    }

    /** Trim non-active satellite webviews on memory pressure. */
    @MainThread
    public void handleMemoryWarning() {
        Log.w(TAG, "Memory warning — unloading non-visible satellite webviews");
        for (String tab : TAB_ORDER) {
            if (tab.equals(activeTab) || "climbs".equals(tab)) continue;
            if (!loadedTabs.contains(tab)) continue;
            WebView wv = tabWebViews.get(tab);
            if (wv == null) continue;

            wv.loadUrl("about:blank");
            loadedTabs.remove(tab);
            SatelliteBridge bridge = satelliteBridges.get(tab);
            if (bridge != null) bridge.resetLoadState();
        }
    }

    public void destroy() {
        for (Map.Entry<String, SatelliteBridge> entry : satelliteBridges.entrySet()) {
            entry.getValue().detach();
        }
        satelliteBridges.clear();
    }

    // -- Setup ---------------------------------------------------------------

    private void setupSatelliteWebViews() {
        Set<String> allowedOrigins = buildAllowedOrigins();
        for (String tabKey : TAB_ORDER) {
            if ("climbs".equals(tabKey)) continue;

            SatelliteBridge bridge = new SatelliteBridge(activity, tabKey, allowedOrigins);
            bridge.setOnTabBarAction((methodName, options) ->
                handleSatelliteTabBarAction(tabKey, methodName, options));
            bridge.setOnFirstLoadCompleteListener(() -> {
                triggerDeferredLoadsIfNeeded();
                injectTabBarHeightIntoWebView(tabKey);
            });

            WebView wv = bridge.createWebView();
            FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            );
            tabContainer.addView(wv, params);
            wv.setVisibility("home".equals(tabKey) ? View.VISIBLE : View.GONE);

            tabWebViews.put(tabKey, wv);
            satelliteBridges.put(tabKey, bridge);
        }
    }

    private void setupTabBar() {
        tabBarView = new NativeTabBarView(activity);
        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        );
        tabBarHost.addView(tabBarView, params);
        tabBarView.setOnTabTappedListener(this::handleTabTap);
        tabBarView.setActiveTab(activeTab);
    }

    private void applyInsets() {
        // EdgeToEdge is enabled in MainActivity — we own the bottom inset here so
        // the tab bar visually sits above the gesture/nav area while content
        // continues to extend behind it.
        //
        // The listener is attached to the activity's content root because some
        // ViewGroups (CoordinatorLayout in particular) consume insets and won't
        // dispatch them to a deeper child like tabBarHost.
        View root = activity.findViewById(android.R.id.content);
        if (root != null) {
            ViewCompat.setOnApplyWindowInsetsListener(root, (v, insets) -> {
                Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars());
                tabBarHost.setPadding(0, 0, 0, bars.bottom);
                tabBarHost.post(this::injectTabBarHeightIntoAllWebViews);
                return insets;
            });
            ViewCompat.requestApplyInsets(root);
        }
        tabBarHost.addOnLayoutChangeListener((v, l, t, r, b, ol, ot, or, ob) ->
            injectTabBarHeightIntoAllWebViews());
    }

    @NonNull
    private Set<String> buildAllowedOrigins() {
        Set<String> origins = new LinkedHashSet<>();
        Uri serverUri = Uri.parse(serverUrl);
        String scheme = serverUri.getScheme();
        String host = serverUri.getHost();
        if (scheme != null && host != null) {
            origins.add(scheme + "://" + host);
        }
        // Explicit fallbacks. Production wildcard for *.boardsesh.com so the
        // shim attaches on www / staging / preview hosts; the configured dev
        // URL above already covers the active dev tunnel host on debug builds.
        origins.add("https://*.boardsesh.com");
        origins.add("https://boardsesh.com");
        return origins;
    }

    // -- Visibility ----------------------------------------------------------

    private void hideWebView(@NonNull String tab) {
        WebView wv = tabWebViews.get(tab);
        if (wv != null) wv.setVisibility(View.GONE);
    }

    private void showWebView(@NonNull String tab) {
        WebView wv = tabWebViews.get(tab);
        if (wv != null) wv.setVisibility(View.VISIBLE);
    }

    // -- Loading -------------------------------------------------------------

    @MainThread
    public void loadTab(@NonNull String tab) {
        if (loadedTabs.contains(tab)) return;
        loadedTabs.add(tab);

        if ("climbs".equals(tab)) {
            triggerDeferredLoadsIfNeeded();
            return;
        }

        WebView wv = tabWebViews.get(tab);
        if (wv == null) {
            Log.e(TAG, "No webview for tab " + tab + " — cannot load");
            return;
        }

        String pendingUrl = pendingNavigationUrls.remove(tab);
        String path = pendingUrl != null ? pendingUrl : TAB_INITIAL_PATHS.get(tab);
        if (path == null) path = "/";

        String fullUrl;
        if (path.startsWith("http://") || path.startsWith("https://")) {
            fullUrl = path;
        } else {
            fullUrl = serverUrl + path;
        }

        wv.loadUrl(fullUrl);
    }

    private void triggerDeferredLoadsIfNeeded() {
        if (hasDeferredLoadsStarted) return;
        hasDeferredLoadsStarted = true;

        int delayIndex = 1;
        for (String tab : DEFERRED_LOAD_ORDER) {
            if (loadedTabs.contains(tab)) continue;
            long delay = DEFERRED_LOAD_STAGGER_MS * delayIndex;
            mainHandler.postDelayed(() -> loadTab(tab), delay);
            delayIndex++;
        }
    }

    // -- CSS variable injection ---------------------------------------------

    private void injectTabBarHeightIntoAllWebViews() {
        int heightPx = tabBarHost.getHeight();
        if (heightPx <= 0) return;
        if (heightPx == lastInjectedTabBarHeightPx) return;
        lastInjectedTabBarHeightPx = heightPx;
        for (String tab : TAB_ORDER) {
            injectTabBarHeightIntoWebView(tab);
        }
    }

    private void injectTabBarHeightIntoWebView(@NonNull String tab) {
        int heightPx = tabBarHost.getHeight();
        if (heightPx <= 0) return;
        if (!loadedTabs.contains(tab)) return;
        WebView wv = tabWebViews.get(tab);
        if (wv == null) return;

        // Convert px back to CSS px (which equals 1dp at the device's css scale of 1).
        // WebView's CSS-px = device-independent-px in API >= 19, so divide by density.
        float density = activity.getResources().getDisplayMetrics().density;
        if (density <= 0f) density = 1f;
        int cssPx = Math.round(heightPx / density);

        String js = "document.documentElement.style.setProperty('--native-tab-bar-height','"
            + cssPx + "px');";
        wv.evaluateJavascript(js, null);
    }

    // -- Event dispatching ---------------------------------------------------

    private void dispatchTabTappedEvent(@NonNull String tappedTab, @NonNull String targetTab) {
        WebView wv = tabWebViews.get(targetTab);
        if (wv == null) return;
        String escaped = SatelliteBridge.jsEscape(tappedTab);
        String js = "window.dispatchEvent(new CustomEvent('boardsesh:native-tab-tapped',{detail:{tab:'"
            + escaped + "'}}));";
        wv.evaluateJavascript(js, null);
    }

    // -- Satellite plugin call routing --------------------------------------

    private void handleSatelliteTabBarAction(
        @NonNull String tabKey,
        @NonNull String methodName,
        @NonNull JSONObject options
    ) {
        switch (methodName) {
            case "setActiveTab":
                tabBarView.setActiveTab(options.optString("tab", "home"));
                break;
            case "setBarsHidden":
                tabBarView.setBarsHidden(options.optBoolean("hidden", false));
                break;
            case "setNotificationBadge":
                tabBarView.setNotificationBadge(options.optInt("count", 0));
                break;
            case "navigateTab":
                navigateToTab(options.optString("tab", "home"), options.optString("url", "/"));
                break;
            default:
                Log.w(TAG, "Unhandled satellite tab bar call: " + methodName + " from " + tabKey);
        }
    }

    @NonNull
    private static String stripTrailingSlash(@NonNull String url) {
        if (url.endsWith("/")) return url.substring(0, url.length() - 1);
        return url;
    }
}
