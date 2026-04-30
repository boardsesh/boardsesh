package com.boardsesh.app.tabs;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

/**
 * Parity check for {@link TabContainerController#tabForPath(String)}. The
 * mapping must stay identical to {@code packages/web/app/lib/tab-routing.ts}
 * and {@code MultiWebViewController.tabForPath} on iOS — drift causes a deep
 * link or cross-tab navigation to land in the wrong tab.
 */
public class TabContainerControllerTest {

    @Test
    public void rootPath_mapsToHome() {
        assertEquals("home", TabContainerController.tabForPath("/"));
    }

    @Test
    public void createSuffix_mapsToCreate() {
        assertEquals("create", TabContainerController.tabForPath("/create"));
        assertEquals("create", TabContainerController.tabForPath("/kilter/create"));
    }

    @Test
    public void feedPrefix_mapsToFeed() {
        assertEquals("feed", TabContainerController.tabForPath("/feed"));
        assertEquals("feed", TabContainerController.tabForPath("/feed/some-user"));
    }

    @Test
    public void youPrefix_mapsToYou() {
        assertEquals("you", TabContainerController.tabForPath("/you"));
        assertEquals("you", TabContainerController.tabForPath("/you/settings"));
    }

    @Test
    public void playlistsPrefix_mapsToLibrary() {
        assertEquals("library", TabContainerController.tabForPath("/playlists"));
        assertEquals("library", TabContainerController.tabForPath("/playlists/123"));
    }

    @Test
    public void otherPaths_mapToClimbs() {
        assertEquals("climbs", TabContainerController.tabForPath("/kilter/1/2/3/40"));
        assertEquals("climbs", TabContainerController.tabForPath("/tension"));
    }

    @Test
    public void emptyOrNullPath_mapsToClimbs() {
        assertEquals("climbs", TabContainerController.tabForPath(null));
        assertEquals("climbs", TabContainerController.tabForPath(""));
    }
}
