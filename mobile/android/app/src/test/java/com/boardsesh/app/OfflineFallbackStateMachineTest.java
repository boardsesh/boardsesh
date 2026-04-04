package com.boardsesh.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class OfflineFallbackStateMachineTest {
    @Test
    public void firstFailureAttemptsCache_secondFailureShowsOfflineFlow() {
        OfflineFallbackStateMachine state = new OfflineFallbackStateMachine();

        state.onPageStarted();
        state.onMainFrameError("https://boardsesh.com");

        // Real flow: cache attempt is decided immediately after the first error.
        assertTrue(state.shouldAttemptCacheFallback());

        // First failing navigation can still "finish" with an error callback sequence.
        state.onPageFinished();
        assertFalse(state.shouldAttemptCacheFallback());
        assertEquals("https://boardsesh.com", state.getLastFailedUrl());
    }

    @Test
    public void successfulFinishResetsAttemptAndFailedUrl() {
        OfflineFallbackStateMachine state = new OfflineFallbackStateMachine();

        state.onPageStarted();
        state.onMainFrameError("https://boardsesh.com/foo");
        state.onPageFinished();
        assertTrue(state.shouldAttemptCacheFallback());

        state.onPageStarted();
        state.onPageFinished();

        assertTrue(state.shouldAttemptCacheFallback());
        assertNull(state.getLastFailedUrl());
    }
}
