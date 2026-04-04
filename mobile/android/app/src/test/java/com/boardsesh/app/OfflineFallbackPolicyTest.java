package com.boardsesh.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.webkit.WebViewClient;

import org.junit.Test;

public class OfflineFallbackPolicyTest {
    @Test
    public void networkErrorCode_returnsTrueForOfflineNetworkFailures() {
        assertTrue(OfflineFallbackPolicy.isNetworkErrorCode(WebViewClient.ERROR_HOST_LOOKUP));
        assertTrue(OfflineFallbackPolicy.isNetworkErrorCode(WebViewClient.ERROR_CONNECT));
        assertTrue(OfflineFallbackPolicy.isNetworkErrorCode(WebViewClient.ERROR_TIMEOUT));
        assertTrue(OfflineFallbackPolicy.isNetworkErrorCode(WebViewClient.ERROR_IO));
        assertTrue(OfflineFallbackPolicy.isNetworkErrorCode(WebViewClient.ERROR_PROXY_AUTHENTICATION));
    }

    @Test
    public void networkErrorCode_returnsFalseForUnknownErrors() {
        assertFalse(OfflineFallbackPolicy.isNetworkErrorCode(WebViewClient.ERROR_UNKNOWN));
    }

    @Test
    public void networkErrorCode_returnsFalseForUnsupportedScheme() {
        assertFalse(OfflineFallbackPolicy.isNetworkErrorCode(WebViewClient.ERROR_UNSUPPORTED_SCHEME));
    }

    @Test
    public void shouldTriggerOfflineFallback_requiresMainFrameAndOffline() {
        assertTrue(OfflineFallbackPolicy.shouldTriggerOfflineFallback(
            true,
            true,
            WebViewClient.ERROR_TIMEOUT
        ));

        assertFalse(OfflineFallbackPolicy.shouldTriggerOfflineFallback(
            false,
            true,
            WebViewClient.ERROR_TIMEOUT
        ));

        assertFalse(OfflineFallbackPolicy.shouldTriggerOfflineFallback(
            true,
            false,
            WebViewClient.ERROR_TIMEOUT
        ));
    }
}
