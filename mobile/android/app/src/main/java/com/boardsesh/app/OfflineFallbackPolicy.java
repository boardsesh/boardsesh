package com.boardsesh.app;

import android.webkit.WebViewClient;

final class OfflineFallbackPolicy {
    private OfflineFallbackPolicy() {}

    static boolean isNetworkErrorCode(int errorCode) {
        return errorCode == WebViewClient.ERROR_HOST_LOOKUP
            || errorCode == WebViewClient.ERROR_CONNECT
            || errorCode == WebViewClient.ERROR_TIMEOUT
            || errorCode == WebViewClient.ERROR_IO
            || errorCode == WebViewClient.ERROR_PROXY_AUTHENTICATION;
    }

    static boolean shouldTriggerOfflineFallback(boolean isMainFrameRequest, boolean isOffline, int errorCode) {
        return isMainFrameRequest && isOffline && isNetworkErrorCode(errorCode);
    }
}
