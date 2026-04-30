package com.boardsesh.app;

import android.content.ComponentCallbacks2;
import android.content.Context;
import android.content.Intent;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.Process;
import android.text.TextUtils;
import android.view.ViewGroup;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;

import androidx.activity.EdgeToEdge;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import com.boardsesh.app.plugins.DevUrlPlugin;
import com.boardsesh.app.plugins.NativeTabBarPlugin;
import com.boardsesh.app.tabs.TabContainerController;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;
import com.getcapacitor.CapConfig;

public class MainActivity extends BridgeActivity {
    private static final String DEV_RESET_SCHEME = "boardsesh-dev";
    private final OfflineFallbackStateMachine fallbackState = new OfflineFallbackStateMachine();

    @Nullable
    private TabContainerController tabContainerController;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(DevUrlPlugin.class);
        registerPlugin(NativeTabBarPlugin.class);

        super.onCreate(savedInstanceState);
        EdgeToEdge.enable(this);

        if (bridge == null || bridge.getWebView() == null) {
            return;
        }

        if (BuildConfig.DEBUG) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        WebView webView = bridge.getWebView();
        WebSettings settings = webView.getSettings();
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        webView.setWebViewClient(new OfflineAwareBridgeWebViewClient(bridge));

        ViewGroup tabContainer = findViewById(R.id.tab_container);
        ViewGroup tabBarHost = findViewById(R.id.native_tab_bar_host);
        if (tabContainer != null && tabBarHost != null) {
            tabContainerController = new TabContainerController(
                this,
                tabContainer,
                tabBarHost,
                webView,
                resolveServerUrl()
            );
        }

        // Cold-start deep link: Capacitor's default load() points the WebView at
        // server.url and discards the launch intent's path, so /join/{id} (and
        // any other App Link) never lands. Mirror SceneDelegate.swift on iOS by
        // forwarding the intent URL into the WebView ourselves.
        loadDeepLinkIfPresent(getIntent(), webView);
    }

    @Nullable
    public TabContainerController getTabContainerController() {
        return tabContainerController;
    }

    @Override
    public void onTrimMemory(int level) {
        super.onTrimMemory(level);
        if (tabContainerController == null) return;
        if (level >= ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW) {
            tabContainerController.handleMemoryWarning();
        }
    }

    @Override
    protected void onDestroy() {
        if (tabContainerController != null) {
            tabContainerController.destroy();
            tabContainerController = null;
        }
        super.onDestroy();
    }

    private String resolveServerUrl() {
        if (bridge != null && bridge.getConfig() != null) {
            String configured = bridge.getConfig().getServerUrl();
            if (configured != null && !configured.isEmpty()) {
                return configured;
            }
        }
        return DevUrlPlugin.DEFAULT_URL;
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (bridge != null && bridge.getWebView() != null) {
            loadDeepLinkIfPresent(intent, bridge.getWebView());
        }
    }

    private void loadDeepLinkIfPresent(Intent intent, WebView webView) {
        if (intent == null || !Intent.ACTION_VIEW.equals(intent.getAction())) {
            return;
        }
        Uri data = intent.getData();
        if (data == null) {
            return;
        }
        String scheme = data.getScheme();
        if (scheme == null) {
            return;
        }
        String normalizedScheme = scheme.toLowerCase();
        if (!"http".equals(normalizedScheme) && !"https".equals(normalizedScheme)) {
            return;
        }
        String host = data.getHost();
        if (host == null) {
            return;
        }
        String normalizedHost = host.toLowerCase();
        if (!"www.boardsesh.com".equals(normalizedHost) && !"boardsesh.com".equals(normalizedHost)) {
            return;
        }
        // Skip when a dev URL override is active — the WebView is pointed at a
        // different host and forwarding a www.boardsesh.com URL would cross hosts.
        if (BuildConfig.DEBUG && DevUrlPrefs.getOverrideUrl(this) != null) {
            return;
        }
        if (tabContainerController != null) {
            // Route the deep link to whichever tab owns the path so /feed/x lands in
            // the feed tab, /you/x in the you tab, etc. — mirrors SceneDelegate.swift.
            String path = data.getPath();
            String tab = TabContainerController.tabForPath(path);
            String targetTab = "create".equals(tab) ? "climbs" : tab;
            tabContainerController.navigateToTab(targetTab, data.toString());
        } else {
            webView.loadUrl(data.toString());
        }
    }

    @Override
    protected void load() {
        // Runs after super.onCreate() has loaded CapConfig from assets but before
        // Bridge.Builder consumes it. Setting this.config here is respected by
        // the builder path; setting it before super.onCreate() is not.
        if (BuildConfig.DEBUG) {
            String devUrl = DevUrlPrefs.getOverrideUrl(this);
            if (devUrl != null) {
                this.config = new CapConfig.Builder(this)
                    .setServerUrl(devUrl)
                    .setAllowNavigation(new String[]{"*"})
                    .create();
            }
        }
        super.load();
    }

    private String currentRetryUrl() {
        if (BuildConfig.DEBUG) {
            String devUrl = DevUrlPrefs.getOverrideUrl(this);
            if (devUrl != null) {
                return devUrl;
            }
        }
        return DevUrlPlugin.DEFAULT_URL;
    }

    private boolean isOffline() {
        ConnectivityManager connectivityManager =
            (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (connectivityManager == null) {
            return true;
        }

        Network activeNetwork = connectivityManager.getActiveNetwork();
        if (activeNetwork == null) {
            return true;
        }

        NetworkCapabilities capabilities = connectivityManager.getNetworkCapabilities(activeNetwork);
        if (capabilities == null) {
            return true;
        }

        return !(capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED));
    }

    private void tryCacheThenFallback(WebView view) {
        String lastFailedUrl = fallbackState.getLastFailedUrl();
        String targetUrl = sanitizeRetryUrl(lastFailedUrl != null ? lastFailedUrl : view.getUrl());
        String safeHref = TextUtils.htmlEncode(targetUrl);

        if (fallbackState.shouldAttemptCacheFallback()) {
            view.getSettings().setCacheMode(WebSettings.LOAD_CACHE_ELSE_NETWORK);
            view.loadUrl(targetUrl);
            return;
        }

        String devResetLink = buildDevResetLink();

        String errorHtml = "<!DOCTYPE html><html><head><meta charset='utf-8' />"
            + "<meta name='viewport' content='width=device-width, initial-scale=1' />"
            + "<title>You're offline</title>"
            + "<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;"
            + "background:#0A0A0A;color:#fff;margin:0;padding:24px;display:flex;align-items:center;"
            + "justify-content:center;min-height:100vh;text-align:center;}main{max-width:360px;}"
            + "h1{font-size:24px;margin:0 0 12px;}p{color:#c4c4c4;line-height:1.5;max-width:360px;}</style>"
            + "</head><body><main><h1>You appear to be offline</h1>"
            + "<p>We couldn't load Boardsesh from the network and no cached version was available yet."
            + " Check your connection and try again.</p>"
            + "<p><a href='" + safeHref + "'"
            + " style='display:inline-block;margin-top:8px;padding:10px 14px;border-radius:10px;"
            + "background:#fff;color:#0A0A0A;text-decoration:none;font-weight:600;'>Try again</a></p>"
            + devResetLink
            + "</main></body></html>";

        view.loadDataWithBaseURL(null, errorHtml, "text/html", "UTF-8", null);
    }

    private String buildDevResetLink() {
        if (!BuildConfig.DEBUG || DevUrlPrefs.getOverrideUrl(this) == null) {
            return "";
        }
        return "<p style='margin-top:16px;color:#888;font-size:13px'>Dev override active</p>"
            + "<p><a href='" + DEV_RESET_SCHEME + "://reset'"
            + " style='display:inline-block;padding:8px 12px;border-radius:8px;"
            + "border:1px solid #444;color:#ccc;text-decoration:none;font-size:13px;'>"
            + "Reset dev URL to production</a></p>";
    }

    private String sanitizeRetryUrl(String candidateUrl) {
        String fallback = currentRetryUrl();
        if (candidateUrl == null || candidateUrl.isEmpty()) {
            return fallback;
        }

        Uri parsed = Uri.parse(candidateUrl);
        String scheme = parsed.getScheme();
        if (scheme == null) {
            return fallback;
        }

        String normalizedScheme = scheme.toLowerCase();
        if (!"http".equals(normalizedScheme) && !"https".equals(normalizedScheme)) {
            return fallback;
        }

        return candidateUrl;
    }

    private final class OfflineAwareBridgeWebViewClient extends BridgeWebViewClient {
        OfflineAwareBridgeWebViewClient(Bridge bridge) {
            super(bridge);
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            if (url != null && DEV_RESET_SCHEME.equalsIgnoreCase(url.getScheme())) {
                if (BuildConfig.DEBUG) {
                    DevUrlPrefs.setOverrideUrl(MainActivity.this, null);
                    // No JS promise to flush here — post to the main looper so the
                    // WebView finishes handling the click before the process dies.
                    new Handler(Looper.getMainLooper()).post(
                        () -> Process.killProcess(Process.myPid())
                    );
                }
                return true;
            }
            return super.shouldOverrideUrlLoading(view, request);
        }

        @Override
        public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
            fallbackState.onPageStarted();
            super.onPageStarted(view, url, favicon);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            fallbackState.onPageFinished();
            view.getSettings().setCacheMode(WebSettings.LOAD_DEFAULT);
            super.onPageFinished(view, url);
        }

        private boolean shouldTriggerOfflineFallback(WebResourceRequest request, int errorCode) {
            return OfflineFallbackPolicy.shouldTriggerOfflineFallback(
                request.isForMainFrame(),
                isOffline(),
                errorCode
            );
        }

        @Override
        public void onReceivedError(
            @NonNull WebView view,
            @NonNull WebResourceRequest request,
            @NonNull WebResourceError error
        ) {
            super.onReceivedError(view, request, error);
            if (request.isForMainFrame()) {
                fallbackState.onMainFrameError(request.getUrl() != null ? request.getUrl().toString() : null);
            }

            if (shouldTriggerOfflineFallback(request, error.getErrorCode())) {
                tryCacheThenFallback(view);
                return;
            }

            // Dev-override rescue: even when the device is online, if a bad dev
            // URL wedges the main frame we must surface the reset link — the
            // web UI never loads so the in-app dialog is unreachable.
            if (DevOverrideRescuePolicy.shouldShowForNetworkError(
                request.isForMainFrame(),
                BuildConfig.DEBUG,
                hasDevOverride(),
                error.getErrorCode()
            )) {
                renderDevOverrideRescue(view);
            }
        }

        @Override
        public void onReceivedHttpError(
            @NonNull WebView view,
            @NonNull WebResourceRequest request,
            @NonNull WebResourceResponse errorResponse
        ) {
            super.onReceivedHttpError(view, request, errorResponse);
            if (request.isForMainFrame()) {
                fallbackState.onMainFrameError(request.getUrl() != null ? request.getUrl().toString() : null);
            }

            if (request.isForMainFrame() && isOffline()) {
                // Offline path takes precedence: tryCacheThenFallback renders the
                // offline HTML which also contains the boardsesh-dev://reset link
                // when an override is active (see buildDevResetLink), so the
                // escape hatch is still reachable here.
                tryCacheThenFallback(view);
                return;
            }

            if (DevOverrideRescuePolicy.shouldShowForHttpError(
                request.isForMainFrame(),
                BuildConfig.DEBUG,
                hasDevOverride(),
                errorResponse.getStatusCode()
            )) {
                renderDevOverrideRescue(view);
            }
        }

        private boolean hasDevOverride() {
            return DevUrlPrefs.getOverrideUrl(MainActivity.this) != null;
        }
    }

    private void renderDevOverrideRescue(WebView view) {
        String override = DevUrlPrefs.getOverrideUrl(this);
        String safeOverride = TextUtils.htmlEncode(override != null ? override : "");
        String errorHtml = "<!DOCTYPE html><html><head><meta charset='utf-8' />"
            + "<meta name='viewport' content='width=device-width, initial-scale=1' />"
            + "<title>Dev URL unreachable</title>"
            + "<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;"
            + "background:#0A0A0A;color:#fff;margin:0;padding:24px;display:flex;align-items:center;"
            + "justify-content:center;min-height:100vh;text-align:center;}main{max-width:360px;}"
            + "h1{font-size:22px;margin:0 0 12px;}p{color:#c4c4c4;line-height:1.5;}"
            + "code{background:#1f1f1f;padding:2px 6px;border-radius:4px;font-size:12px;word-break:break-all;}</style>"
            + "</head><body><main><h1>Dev URL didn't load</h1>"
            + "<p>The configured dev URL <code>" + safeOverride + "</code> is unreachable."
            + " Check the tunnel or preview is still running.</p>"
            + "<p><a href='" + DEV_RESET_SCHEME + "://reset'"
            + " style='display:inline-block;margin-top:12px;padding:10px 14px;border-radius:10px;"
            + "background:#fff;color:#0A0A0A;text-decoration:none;font-weight:600;'>"
            + "Reset to production</a></p></main></body></html>";
        view.loadDataWithBaseURL(null, errorHtml, "text/html", "UTF-8", null);
    }
}
