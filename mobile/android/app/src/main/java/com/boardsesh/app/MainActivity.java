package com.boardsesh.app;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Bundle;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;

import androidx.annotation.NonNull;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;

public class MainActivity extends BridgeActivity {
    private boolean attemptedCacheFallback = false;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        if (bridge == null || bridge.getWebView() == null) {
            return;
        }

        WebView webView = bridge.getWebView();
        WebSettings settings = webView.getSettings();
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        webView.setWebViewClient(new OfflineAwareBridgeWebViewClient(bridge));
    }

    private boolean isOffline() {
        ConnectivityManager connectivityManager =
            (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (connectivityManager == null) {
            return false;
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
        if (!attemptedCacheFallback) {
            attemptedCacheFallback = true;
            view.getSettings().setCacheMode(WebSettings.LOAD_CACHE_ELSE_NETWORK);
            view.reload();
            return;
        }

        String errorHtml = "<!DOCTYPE html><html><head><meta charset='utf-8' />"
            + "<meta name='viewport' content='width=device-width, initial-scale=1' />"
            + "<title>You're offline</title>"
            + "<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;"
            + "background:#0A0A0A;color:#fff;margin:0;padding:24px;display:flex;align-items:center;"
            + "justify-content:center;min-height:100vh;text-align:center;}"
            + "h1{font-size:24px;margin:0 0 12px;}p{color:#c4c4c4;line-height:1.5;max-width:360px;}</style>"
            + "</head><body><main><h1>You appear to be offline</h1>"
            + "<p>We couldn't load Boardsesh from the network and no cached version was available yet."
            + " Check your connection and try again.</p></main></body></html>";

        view.loadDataWithBaseURL(null, errorHtml, "text/html", "UTF-8", null);
    }

    private final class OfflineAwareBridgeWebViewClient extends BridgeWebViewClient {
        OfflineAwareBridgeWebViewClient(Bridge bridge) {
            super(bridge);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            attemptedCacheFallback = false;
            view.getSettings().setCacheMode(WebSettings.LOAD_DEFAULT);
            super.onPageFinished(view, url);
        }

        @Override
        public void onReceivedError(
            @NonNull WebView view,
            @NonNull WebResourceRequest request,
            @NonNull WebResourceError error
        ) {
            super.onReceivedError(view, request, error);

            if (!request.isForMainFrame() || !isOffline()) {
                return;
            }

            tryCacheThenFallback(view);
        }

        @Override
        public void onReceivedHttpError(
            @NonNull WebView view,
            @NonNull WebResourceRequest request,
            @NonNull WebResourceResponse errorResponse
        ) {
            super.onReceivedHttpError(view, request, errorResponse);

            if (!request.isForMainFrame() || !isOffline()) {
                return;
            }

            tryCacheThenFallback(view);
        }
    }
}
