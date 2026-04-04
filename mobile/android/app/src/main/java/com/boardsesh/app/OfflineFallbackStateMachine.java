package com.boardsesh.app;

final class OfflineFallbackStateMachine {
    private boolean attemptedCacheFallback = false;
    private boolean mainFrameLoadHadError = false;
    private String lastFailedUrl = null;

    synchronized void onPageStarted() {
        mainFrameLoadHadError = false;
    }

    synchronized void onMainFrameError(String failedUrl) {
        mainFrameLoadHadError = true;
        if (failedUrl != null && !failedUrl.isEmpty()) {
            lastFailedUrl = failedUrl;
        }
    }

    synchronized void onPageFinished() {
        if (!mainFrameLoadHadError) {
            attemptedCacheFallback = false;
            lastFailedUrl = null;
        }
    }

    synchronized boolean shouldAttemptCacheFallback() {
        if (attemptedCacheFallback) {
            return false;
        }

        attemptedCacheFallback = true;
        return true;
    }

    synchronized String getLastFailedUrl() {
        return lastFailedUrl;
    }
}
