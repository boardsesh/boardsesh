#include <thumbnail_client.h>
#include <unity.h>

#include <vector>

void setUp(void) {}

void tearDown(void) {}

struct FakeRemoteThumbnailState {
    int clearThumbnailCalls;
    int showClimbCalls;
    int showThumbnailLoadingCalls;
    int setThumbnailJpegCalls;
    int fetchJpegCalls;
    String lastFetchUrl;
    String lastCacheKey;
    ThumbnailFetchResult fetchResult;
    std::vector<uint8_t> fetchOutput;

    FakeRemoteThumbnailState()
        : clearThumbnailCalls(0),
          showClimbCalls(0),
          showThumbnailLoadingCalls(0),
          setThumbnailJpegCalls(0),
          fetchJpegCalls(0),
          fetchResult(ThumbnailFetchStatus::NETWORK_ERROR) {}
};

RemoteThumbnailDisplayRequest makeRemoteThumbnailRequest(const char* frames = "p1073r42,p1090r43") {
    RemoteThumbnailDisplayRequest request = {
        "https://www.boardsesh.com",
        "kilter/1/7/20,1/40",
        frames,
        "Test Climb",
        "V5",
        "#00ff00",
        40,
        "climb-uuid",
        "kilter",
    };
    return request;
}

void fakeClearThumbnail(void* context) {
    static_cast<FakeRemoteThumbnailState*>(context)->clearThumbnailCalls++;
}

void fakeShowClimb(void* context,
                   const char* climbName,
                   const char* climbGrade,
                   const char* gradeColor,
                   int angle,
                   const char* climbUuid,
                   const char* boardTypeName) {
    (void)climbName;
    (void)climbGrade;
    (void)gradeColor;
    (void)angle;
    (void)climbUuid;
    (void)boardTypeName;
    static_cast<FakeRemoteThumbnailState*>(context)->showClimbCalls++;
}

void fakeShowThumbnailLoading(void* context) {
    static_cast<FakeRemoteThumbnailState*>(context)->showThumbnailLoadingCalls++;
}

void fakeSetThumbnailJpeg(void* context, std::vector<uint8_t>&& jpegData, const char* cacheKey) {
    FakeRemoteThumbnailState* state = static_cast<FakeRemoteThumbnailState*>(context);
    state->setThumbnailJpegCalls++;
    state->lastCacheKey = cacheKey ? cacheKey : "";
    state->fetchOutput = std::move(jpegData);
}

ThumbnailFetchResult fakeFetchJpeg(void* context, const char* url, std::vector<uint8_t>& output) {
    FakeRemoteThumbnailState* state = static_cast<FakeRemoteThumbnailState*>(context);
    state->fetchJpegCalls++;
    state->lastFetchUrl = url ? url : "";
    output = state->fetchOutput;
    return state->fetchResult;
}

RemoteThumbnailDisplayHooks makeRemoteThumbnailHooks(FakeRemoteThumbnailState& state) {
    RemoteThumbnailDisplayHooks hooks = {
        &state,
        fakeClearThumbnail,
        fakeShowClimb,
        fakeShowThumbnailLoading,
        fakeSetThumbnailJpeg,
        fakeFetchJpeg,
    };
    return hooks;
}

void test_parse_board_render_route_sorts_set_ids_and_ignores_angle(void) {
    BoardRenderRoute route;
    bool parsed = parseBoardRenderRoute("kilter/1/7/20,1/40", route);

    TEST_ASSERT_TRUE(parsed);
    TEST_ASSERT_EQUAL_STRING("kilter", route.boardName);
    TEST_ASSERT_EQUAL(1, route.layoutId);
    TEST_ASSERT_EQUAL(7, route.sizeId);
    TEST_ASSERT_EQUAL_STRING("1,20", route.setIds);
}

void test_parse_board_render_route_keeps_every_set_id_on_the_widest_board(void) {
    // Decoy layout 2 / size 1 carries 19 hold sets, the widest shipped config.
    // At the old 16-id cap this parsed the first 16, sorted those, and wrote
    // them back over the route — the device then asked for a Decoy board with
    // three of its hold sets missing.
    BoardRenderRoute route;
    bool parsed = parseBoardRenderRoute(
        "decoy/2/1/20,19,18,17,16,15,14,13,12,11,10,9,8,7,6,5,4,3,2/40", route);

    TEST_ASSERT_TRUE(parsed);
    TEST_ASSERT_EQUAL_STRING("decoy", route.boardName);
    TEST_ASSERT_EQUAL_STRING("2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20", route.setIds);
}

void test_parse_board_render_route_leaves_a_set_list_past_the_cap_intact(void) {
    // Past MAX_SET_IDS the list is left exactly as it arrived rather than
    // truncated. Sorting only aligns the request with the server's cache key —
    // the server canonicalises set ids itself, so an unsorted list still renders
    // the right board while a short one does not.
    BoardRenderRoute route;
    const char* tooMany = "25,24,23,22,21,20,19,18,17,16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1";
    String path = String("decoy/2/1/") + tooMany + "/40";
    bool parsed = parseBoardRenderRoute(path.c_str(), route);

    TEST_ASSERT_TRUE(parsed);
    TEST_ASSERT_EQUAL_STRING(tooMany, route.setIds);
}

void test_parse_board_render_route_holds_the_widest_list_the_parser_accepts(void) {
    // 24 three-digit ids is 95 characters, the worst case MAX_SET_IDS allows.
    // The buffer has to hold it, or a config the parser would accept is instead
    // dropped whole by copySegment and shows as a blank thumbnail.
    BoardRenderRoute route;
    String setIds = "100";
    for (int i = 1; i < 24; i++) {
        setIds += ",";
        setIds += String(100 + i);
    }
    String path = String("decoy/2/1/") + setIds + "/40";
    bool parsed = parseBoardRenderRoute(path.c_str(), route);

    TEST_ASSERT_EQUAL(95, static_cast<int>(setIds.length()));
    TEST_ASSERT_TRUE(parsed);
    TEST_ASSERT_EQUAL_STRING(setIds.c_str(), route.setIds);
}

void test_parse_board_render_route_accepts_locale_prefixed_path(void) {
    BoardRenderRoute route;
    bool parsed = parseBoardRenderRoute("/es/tension/2/10/3,1/list", route);

    TEST_ASSERT_TRUE(parsed);
    TEST_ASSERT_EQUAL_STRING("tension", route.boardName);
    TEST_ASSERT_EQUAL(2, route.layoutId);
    TEST_ASSERT_EQUAL(10, route.sizeId);
    TEST_ASSERT_EQUAL_STRING("1,3", route.setIds);
}

void test_parse_board_render_route_rejects_missing_segments(void) {
    BoardRenderRoute route;

    TEST_ASSERT_FALSE(parseBoardRenderRoute("kilter/1/7", route));
    TEST_ASSERT_FALSE(parseBoardRenderRoute("", route));
    TEST_ASSERT_FALSE(parseBoardRenderRoute(nullptr, route));
}

void test_normalize_render_base_url_handles_ws_and_trailing_slashes(void) {
    TEST_ASSERT_EQUAL_STRING("https://ws.boardsesh.com", normalizeRenderBaseUrl("wss://ws.boardsesh.com/graphql/").c_str());
    TEST_ASSERT_EQUAL_STRING("http://localhost:3000", normalizeRenderBaseUrl(" http://localhost:3000/ ").c_str());
    TEST_ASSERT_EQUAL_STRING("https://www.boardsesh.com", normalizeRenderBaseUrl("").c_str());
    TEST_ASSERT_EQUAL_STRING("https://preview.boardsesh.com", normalizeRenderBaseUrl("preview.boardsesh.com").c_str());
}

void test_url_encode_query_value_encodes_frames(void) {
    TEST_ASSERT_EQUAL_STRING("p1r42%2Cp2r43%2Bx%20hold", urlEncodeQueryValue("p1r42,p2r43+x hold").c_str());
}

void test_build_board_render_thumbnail_url_uses_jpeg_endpoint(void) {
    String url = buildBoardRenderThumbnailUrl("https://www.boardsesh.com/",
                                             "kilter/1/7/20,1/40",
                                             "p1073r42,p1090r43");

    TEST_ASSERT_EQUAL_STRING(
        "https://www.boardsesh.com/api/internal/board-render?board_name=kilter&layout_id=1&size_id=7&set_ids=1%2C20&frames=p1073r42%2Cp1090r43&thumbnail=1&include_background=1&format=jpg",
        url.c_str());
}

void test_build_board_render_thumbnail_url_returns_empty_for_bad_path(void) {
    TEST_ASSERT_EQUAL_STRING("", buildBoardRenderThumbnailUrl("https://www.boardsesh.com", "kilter/1", "p1r42").c_str());
}

void test_thumbnail_url_matches_cache_only_for_same_non_empty_url(void) {
    const char* url =
        "https://www.boardsesh.com/api/internal/board-render?board_name=kilter&layout_id=1&size_id=7";

    TEST_ASSERT_TRUE(thumbnailUrlMatchesCache(url, url));
    TEST_ASSERT_FALSE(thumbnailUrlMatchesCache(url, "https://www.boardsesh.com/different.jpg"));
    TEST_ASSERT_FALSE(thumbnailUrlMatchesCache("", ""));
    TEST_ASSERT_FALSE(thumbnailUrlMatchesCache(nullptr, url));
    TEST_ASSERT_FALSE(thumbnailUrlMatchesCache(url, nullptr));
}

void test_handle_remote_thumbnail_display_cache_hit_does_not_refresh_display(void) {
    FakeRemoteThumbnailState state;
    RemoteThumbnailDisplayRequest request = makeRemoteThumbnailRequest();
    RemoteThumbnailDisplayHooks hooks = makeRemoteThumbnailHooks(state);
    String currentCacheKey = buildBoardRenderThumbnailUrl(request.renderBaseUrl, request.boardPath, request.frames);

    RemoteThumbnailDisplayResult result = handleRemoteThumbnailDisplay(request, hooks, currentCacheKey);

    TEST_ASSERT_TRUE(result == RemoteThumbnailDisplayResult::CACHE_HIT);
    TEST_ASSERT_EQUAL(0, state.clearThumbnailCalls);
    TEST_ASSERT_EQUAL(0, state.showClimbCalls);
    TEST_ASSERT_EQUAL(0, state.showThumbnailLoadingCalls);
    TEST_ASSERT_EQUAL(0, state.setThumbnailJpegCalls);
    TEST_ASSERT_EQUAL(0, state.fetchJpegCalls);
}

void test_handle_remote_thumbnail_display_failure_restores_text_display(void) {
    FakeRemoteThumbnailState state;
    state.fetchResult = ThumbnailFetchResult(ThumbnailFetchStatus::HTTP_ERROR, 503);
    RemoteThumbnailDisplayRequest request = makeRemoteThumbnailRequest();
    RemoteThumbnailDisplayHooks hooks = makeRemoteThumbnailHooks(state);
    String currentCacheKey = "old-thumbnail";

    RemoteThumbnailDisplayResult result = handleRemoteThumbnailDisplay(request, hooks, currentCacheKey);

    TEST_ASSERT_TRUE(result == RemoteThumbnailDisplayResult::FETCH_FAILED);
    TEST_ASSERT_EQUAL_STRING("", currentCacheKey.c_str());
    TEST_ASSERT_EQUAL(1, state.fetchJpegCalls);
    TEST_ASSERT_EQUAL(1, state.clearThumbnailCalls);
    TEST_ASSERT_EQUAL(2, state.showClimbCalls);
    TEST_ASSERT_EQUAL(1, state.showThumbnailLoadingCalls);
    TEST_ASSERT_EQUAL(0, state.setThumbnailJpegCalls);
}

void test_handle_remote_thumbnail_display_success_sets_thumbnail_without_clear(void) {
    FakeRemoteThumbnailState state;
    state.fetchResult = ThumbnailFetchResult(ThumbnailFetchStatus::OK, 200, 3);
    state.fetchOutput = {0xff, 0xd8, 0xff};
    RemoteThumbnailDisplayRequest request = makeRemoteThumbnailRequest();
    RemoteThumbnailDisplayHooks hooks = makeRemoteThumbnailHooks(state);
    String currentCacheKey = "";

    RemoteThumbnailDisplayResult result = handleRemoteThumbnailDisplay(request, hooks, currentCacheKey);

    TEST_ASSERT_TRUE(result == RemoteThumbnailDisplayResult::FETCHED);
    TEST_ASSERT_TRUE(currentCacheKey.length() > 0);
    TEST_ASSERT_EQUAL(1, state.fetchJpegCalls);
    TEST_ASSERT_EQUAL(0, state.clearThumbnailCalls);
    TEST_ASSERT_EQUAL(1, state.showClimbCalls);
    TEST_ASSERT_EQUAL(1, state.showThumbnailLoadingCalls);
    TEST_ASSERT_EQUAL(1, state.setThumbnailJpegCalls);
    TEST_ASSERT_EQUAL_STRING(currentCacheKey.c_str(), state.lastCacheKey.c_str());
}

void test_fetch_jpeg_is_stubbed_in_native_tests(void) {
    ThumbnailClient client;
    std::vector<uint8_t> output;

    ThumbnailFetchResult result = client.fetchJpeg("https://www.boardsesh.com/test.jpg", output);

    TEST_ASSERT_EQUAL(ThumbnailFetchStatus::UNSUPPORTED_IN_TEST, result.status);
    TEST_ASSERT_TRUE(output.empty());
}

int main(int argc, char** argv) {
    (void)argc;
    (void)argv;

    UNITY_BEGIN();
    RUN_TEST(test_parse_board_render_route_sorts_set_ids_and_ignores_angle);
    RUN_TEST(test_parse_board_render_route_keeps_every_set_id_on_the_widest_board);
    RUN_TEST(test_parse_board_render_route_leaves_a_set_list_past_the_cap_intact);
    RUN_TEST(test_parse_board_render_route_holds_the_widest_list_the_parser_accepts);
    RUN_TEST(test_parse_board_render_route_accepts_locale_prefixed_path);
    RUN_TEST(test_parse_board_render_route_rejects_missing_segments);
    RUN_TEST(test_normalize_render_base_url_handles_ws_and_trailing_slashes);
    RUN_TEST(test_url_encode_query_value_encodes_frames);
    RUN_TEST(test_build_board_render_thumbnail_url_uses_jpeg_endpoint);
    RUN_TEST(test_build_board_render_thumbnail_url_returns_empty_for_bad_path);
    RUN_TEST(test_thumbnail_url_matches_cache_only_for_same_non_empty_url);
    RUN_TEST(test_handle_remote_thumbnail_display_cache_hit_does_not_refresh_display);
    RUN_TEST(test_handle_remote_thumbnail_display_failure_restores_text_display);
    RUN_TEST(test_handle_remote_thumbnail_display_success_sets_thumbnail_without_clear);
    RUN_TEST(test_fetch_jpeg_is_stubbed_in_native_tests);
    return UNITY_END();
}
