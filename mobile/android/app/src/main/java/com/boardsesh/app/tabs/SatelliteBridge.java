package com.boardsesh.app.tabs;

import android.annotation.SuppressLint;
import android.content.Context;
import android.graphics.Color;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.HashSet;
import java.util.Set;

/**
 * Manages a single non-Capacitor WebView in the multi-webview tab
 * architecture. Mirrors {@code SatelliteBridge.swift}: injects a JavaScript
 * shim at document start that emulates {@code window.Capacitor} (so the web
 * app's {@code isNativeApp()} detection works), and routes plugin calls from
 * JS back to the {@link TabContainerController} via a callback.
 */
public final class SatelliteBridge {

    private static final String TAG = "SatelliteBridge";

    /** Callback invoked when the satellite webview makes a NativeTabBar plugin call. */
    public interface TabBarAction {
        void onTabBarCall(@NonNull String methodName, @NonNull JSONObject options);
    }

    /** Callback invoked once when the webview finishes its first navigation. */
    public interface OnFirstLoadComplete {
        void onFirstLoadComplete();
    }

    private final String tabKey;
    private final Context context;
    private final Set<String> allowedOriginRules;

    @Nullable
    private WebView webView;
    @Nullable
    private TabBarAction tabBarAction;
    @Nullable
    private OnFirstLoadComplete firstLoadCompleteListener;
    private boolean hasCompletedFirstLoad = false;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    /**
     * @param tabKey          tab identifier (injected as {@code window.__BOARDSESH_TAB__})
     * @param allowedOrigins  origin patterns the document-start script is allowed to run on
     *                        (e.g. {@code https://www.boardsesh.com}).
     */
    public SatelliteBridge(@NonNull Context context, @NonNull String tabKey, @NonNull Set<String> allowedOrigins) {
        this.context = context;
        this.tabKey = tabKey;
        this.allowedOriginRules = new HashSet<>(allowedOrigins);
    }

    public void setOnTabBarAction(@Nullable TabBarAction action) {
        this.tabBarAction = action;
    }

    public void setOnFirstLoadCompleteListener(@Nullable OnFirstLoadComplete listener) {
        this.firstLoadCompleteListener = listener;
    }

    /** Reset first-load tracking so the listener can fire again after an unload/reload cycle. */
    public void resetLoadState() {
        hasCompletedFirstLoad = false;
    }

    @NonNull
    @SuppressLint("SetJavaScriptEnabled")
    public WebView createWebView() {
        WebView wv = new WebView(context);
        webView = wv;

        WebSettings settings = wv.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setSupportMultipleWindows(false);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setDatabaseEnabled(true);

        wv.setBackgroundColor(Color.parseColor("#0A0A0A"));
        wv.addJavascriptInterface(new JsBridge(), "bridge");

        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(wv, buildJsShim(), allowedOriginRules);
        } else {
            Log.w(TAG, "DOCUMENT_START_SCRIPT unsupported on this device — Capacitor shim will not inject");
        }

        wv.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                if (hasCompletedFirstLoad) return;
                hasCompletedFirstLoad = true;
                OnFirstLoadComplete listener = firstLoadCompleteListener;
                if (listener != null) {
                    listener.onFirstLoadComplete();
                }
            }
        });

        return wv;
    }

    @Nullable
    public WebView getWebView() {
        return webView;
    }

    public void detach() {
        WebView wv = webView;
        if (wv != null) {
            wv.removeJavascriptInterface("bridge");
        }
        webView = null;
        tabBarAction = null;
        firstLoadCompleteListener = null;
    }

    /**
     * Evaluates JavaScript in the satellite webview on the main thread. Used by
     * the tab container to dispatch {@code boardsesh:native-tab-tapped} and
     * {@code boardsesh:navigate} events into the page.
     */
    public void evaluateJs(@NonNull String js) {
        mainHandler.post(() -> {
            WebView wv = webView;
            if (wv != null) {
                wv.evaluateJavascript(js, null);
            }
        });
    }

    private void resolveCallback(@NonNull String callbackId, boolean success, @NonNull JSONObject data) {
        String json;
        try {
            json = data.toString();
        } catch (Exception e) {
            json = success ? "{}" : "{\"error\":\"serialization failed\"}";
        }
        String safeCallbackId = jsEscape(callbackId);
        String js = "window.__capacitorCallback('" + safeCallbackId + "'," + success + "," + json + ");";
        evaluateJs(js);
    }

    /**
     * JS-side bridge invoked via {@code window.bridge.postMessage(jsonString)}.
     * Called on a binder thread, so we hop to the main thread before touching
     * the webview or invoking listener callbacks that may mutate UI state.
     */
    private final class JsBridge {
        @JavascriptInterface
        public void postMessage(@Nullable String json) {
            if (json == null) return;
            mainHandler.post(() -> handleBridgeMessage(json));
        }
    }

    private void handleBridgeMessage(@NonNull String json) {
        JSONObject body;
        try {
            body = new JSONObject(json);
        } catch (JSONException e) {
            Log.w(TAG, "Bridge message is not valid JSON: " + e.getMessage());
            return;
        }

        String pluginId = body.optString("pluginId", "");
        String methodName = body.optString("methodName", "");
        String callbackId = body.optString("callbackId", "");
        JSONObject options = body.optJSONObject("options");
        if (options == null) options = new JSONObject();

        if (pluginId.isEmpty() || methodName.isEmpty() || callbackId.isEmpty()) {
            Log.w(TAG, "Bridge message missing required fields (pluginId/methodName/callbackId)");
            return;
        }

        if ("NativeTabBar".equals(pluginId)) {
            TabBarAction action = tabBarAction;
            if (action != null) {
                action.onTabBarCall(methodName, options);
            }
            resolveCallback(callbackId, true, new JSONObject());
            return;
        }

        Log.w(TAG, "Unknown pluginId from " + tabKey + ": " + pluginId);
        JSONObject error = new JSONObject();
        try {
            error.put("error", "Unknown plugin: " + pluginId);
        } catch (JSONException ignored) {
            // toString fallback in resolveCallback handles it
        }
        resolveCallback(callbackId, false, error);
    }

    /**
     * Builds the JavaScript shim injected at document-start. Mirrors the IIFE
     * in {@code SatelliteBridge.swift#buildJSShim}: creates {@code window.Capacitor},
     * registers a {@code NativeTabBar} plugin stub that posts to the native bridge,
     * sets {@code __BOARDSESH_TAB__}, and patches {@code history.pushState} /
     * {@code replaceState} so cross-tab navigations are redirected to a native
     * tab switch instead of an in-page navigation.
     *
     * The {@code NativeWebSocket} stub from iOS is intentionally omitted — Android
     * does not have a native WS plugin yet, and each WebView opens its own WS to
     * the GraphQL backend.
     */
    private String buildJsShim() {
        String safeTabKey = jsEscape(tabKey);
        return "(function() {\n"
            + "    'use strict';\n"
            + "\n"
            + "    var pendingCallbacks = {};\n"
            + "    var callbackCounter = 0;\n"
            + "\n"
            + "    window.__capacitorCallback = function(callbackId, success, data) {\n"
            + "        var entry = pendingCallbacks[callbackId];\n"
            + "        if (!entry) return;\n"
            + "        delete pendingCallbacks[callbackId];\n"
            + "        if (success) {\n"
            + "            entry.resolve(data || {});\n"
            + "        } else {\n"
            + "            entry.reject(data || { error: 'unknown error' });\n"
            + "        }\n"
            + "    };\n"
            + "\n"
            + "    function postBridgeMessage(pluginId, methodName, options) {\n"
            + "        return new Promise(function(resolve, reject) {\n"
            + "            var callbackId = 'cb_' + (++callbackCounter) + '_' + Date.now();\n"
            + "            pendingCallbacks[callbackId] = { resolve: resolve, reject: reject };\n"
            + "            try {\n"
            + "                window.bridge.postMessage(JSON.stringify({\n"
            + "                    pluginId: pluginId,\n"
            + "                    methodName: methodName,\n"
            + "                    callbackId: callbackId,\n"
            + "                    options: options || {}\n"
            + "                }));\n"
            + "            } catch (e) {\n"
            + "                delete pendingCallbacks[callbackId];\n"
            + "                reject({ error: String(e) });\n"
            + "            }\n"
            + "        });\n"
            + "    }\n"
            + "\n"
            + "    window.__satelliteListeners = {};\n"
            + "    function addPluginListener(pluginId, eventName, callback) {\n"
            + "        var key = pluginId + ':' + eventName;\n"
            + "        if (!window.__satelliteListeners[key]) {\n"
            + "            window.__satelliteListeners[key] = [];\n"
            + "        }\n"
            + "        window.__satelliteListeners[key].push(callback);\n"
            + "        return Promise.resolve({\n"
            + "            remove: function() {\n"
            + "                var arr = window.__satelliteListeners[key];\n"
            + "                if (!arr) return;\n"
            + "                var idx = arr.indexOf(callback);\n"
            + "                if (idx !== -1) arr.splice(idx, 1);\n"
            + "            }\n"
            + "        });\n"
            + "    }\n"
            + "\n"
            + "    var NativeTabBar = {\n"
            + "        setActiveTab: function(opts) { return postBridgeMessage('NativeTabBar', 'setActiveTab', opts); },\n"
            + "        setBarsHidden: function(opts) { return postBridgeMessage('NativeTabBar', 'setBarsHidden', opts); },\n"
            + "        setNotificationBadge: function(opts) { return postBridgeMessage('NativeTabBar', 'setNotificationBadge', opts); },\n"
            + "        navigateTab: function(opts) { return postBridgeMessage('NativeTabBar', 'navigateTab', opts); },\n"
            + "        addListener: function(eventName, callback) { return addPluginListener('NativeTabBar', eventName, callback); }\n"
            + "    };\n"
            + "\n"
            + "    var CAPBrowser = {\n"
            + "        open: function(opts) {\n"
            + "            if (opts && opts.url) { window.open(opts.url, '_blank'); }\n"
            + "            return Promise.resolve();\n"
            + "        },\n"
            + "        close: function() { return Promise.resolve(); },\n"
            + "        addListener: function(eventName, callback) { return addPluginListener('CAPBrowser', eventName, callback); }\n"
            + "    };\n"
            + "\n"
            + "    var LiveActivity = {\n"
            + "        isAvailable: function() { return Promise.resolve({ available: false }); },\n"
            + "        startSession: function() { return Promise.resolve(); },\n"
            + "        endSession: function() { return Promise.resolve(); },\n"
            + "        updateActivity: function() { return Promise.resolve(); },\n"
            + "        updateActivityClimb: function() { return Promise.resolve(); },\n"
            + "        addListener: function(eventName, callback) { return addPluginListener('LiveActivity', eventName, callback); }\n"
            + "    };\n"
            + "\n"
            + "    window.Capacitor = {\n"
            + "        isNativePlatform: function() { return true; },\n"
            + "        getPlatform: function() { return 'android'; },\n"
            + "        Plugins: {\n"
            + "            NativeTabBar: NativeTabBar,\n"
            + "            CAPBrowserPlugin: CAPBrowser,\n"
            + "            LiveActivity: LiveActivity\n"
            + "        }\n"
            + "    };\n"
            + "\n"
            + "    window.__BOARDSESH_TAB__ = '" + safeTabKey + "';\n"
            + "\n"
            + "    var currentTab = '" + safeTabKey + "';\n"
            + "\n"
            + "    function getTabForPath(path) {\n"
            + "        if (path === '/') return 'home';\n"
            + "        if (path.match(/\\/create$/)) return 'create';\n"
            + "        if (path.indexOf('/feed') === 0) return 'feed';\n"
            + "        if (path.indexOf('/you') === 0) return 'you';\n"
            + "        if (path.indexOf('/playlists') === 0) return 'library';\n"
            + "        return 'climbs';\n"
            + "    }\n"
            + "\n"
            + "    function extractPath(url) {\n"
            + "        if (!url) return null;\n"
            + "        try {\n"
            + "            if (url.indexOf('://') !== -1) { return new URL(url).pathname; }\n"
            + "            return url.split('?')[0].split('#')[0];\n"
            + "        } catch(e) { return null; }\n"
            + "    }\n"
            + "\n"
            + "    var _origPushState = history.pushState;\n"
            + "    var _origReplaceState = history.replaceState;\n"
            + "\n"
            + "    history.pushState = function(state, title, url) {\n"
            + "        var path = extractPath(url);\n"
            + "        if (path) {\n"
            + "            var targetTab = getTabForPath(path);\n"
            + "            if (targetTab !== currentTab && targetTab !== 'create') {\n"
            + "                var fullUrl = url;\n"
            + "                if (url && url.indexOf('://') === -1) {\n"
            + "                    fullUrl = window.location.origin + (url.charAt(0) === '/' ? '' : '/') + url;\n"
            + "                }\n"
            + "                postBridgeMessage('NativeTabBar', 'navigateTab', { tab: targetTab, url: fullUrl || url });\n"
            + "                return;\n"
            + "            }\n"
            + "        }\n"
            + "        return _origPushState.apply(this, arguments);\n"
            + "    };\n"
            + "\n"
            + "    history.replaceState = function(state, title, url) {\n"
            + "        var path = extractPath(url);\n"
            + "        if (path) {\n"
            + "            var targetTab = getTabForPath(path);\n"
            + "            if (targetTab !== currentTab && targetTab !== 'create') {\n"
            + "                var fullUrl = url;\n"
            + "                if (url && url.indexOf('://') === -1) {\n"
            + "                    fullUrl = window.location.origin + (url.charAt(0) === '/' ? '' : '/') + url;\n"
            + "                }\n"
            + "                postBridgeMessage('NativeTabBar', 'navigateTab', { tab: targetTab, url: fullUrl || url });\n"
            + "                return;\n"
            + "            }\n"
            + "        }\n"
            + "        return _origReplaceState.apply(this, arguments);\n"
            + "    };\n"
            + "})();\n";
    }

    /**
     * Escapes a string so it can be safely placed inside a single-quoted
     * JavaScript string literal. Mirrors {@code WebSocketBroadcaster.escapeForJavaScript}
     * on the iOS side.
     */
    @NonNull
    public static String jsEscape(@NonNull String value) {
        StringBuilder out = new StringBuilder(value.length() + 8);
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '\\': out.append("\\\\"); break;
                case '\'': out.append("\\'"); break;
                case '"':  out.append("\\\""); break;
                case '\n': out.append("\\n"); break;
                case '\r': out.append("\\r"); break;
                case '\t': out.append("\\t"); break;
                case ' ': out.append("\\u2028"); break;
                case ' ': out.append("\\u2029"); break;
                case '\0': out.append("\\0"); break;
                default: out.append(c);
            }
        }
        return out.toString();
    }
}
