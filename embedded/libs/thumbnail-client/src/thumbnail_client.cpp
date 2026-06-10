#include "thumbnail_client.h"

#include <ctype.h>
#include <stdlib.h>
#include <string.h>

#include <config/board_config.h>
#include <log_buffer.h>

#include <utility>

#ifndef UNIT_TEST
#include <HTTPClient.h>
#include <WiFiClient.h>
#include <WiFiClientSecure.h>
#endif

namespace {

bool startsWithLiteral(const char* value, const char* prefix) {
    if (!value || !prefix) return false;
    return strncmp(value, prefix, strlen(prefix)) == 0;
}

void stripPathAfterAuthority(char* value) {
    if (!value) return;

    char* schemeEnd = strstr(value, "://");
    if (!schemeEnd) return;

    char* authorityStart = schemeEnd + 3;
    char* pathStart = strchr(authorityStart, '/');
    if (pathStart) {
        *pathStart = '\0';
    }
}

bool isBoardseshWebSocketRenderHost(const char* value) {
    if (!value) return false;
    return strcmp(value, "ws.boardsesh.com") == 0 ||
           strcmp(value, "https://ws.boardsesh.com") == 0 ||
           strcmp(value, "http://ws.boardsesh.com") == 0 ||
           strcmp(value, "wss://ws.boardsesh.com") == 0 ||
           strcmp(value, "ws://ws.boardsesh.com") == 0;
}

void copyTrimmed(const char* source, char* dest, size_t destSize) {
    if (!dest || destSize == 0) return;
    dest[0] = '\0';
    if (!source) return;

    const char* start = source;
    while (*start && isspace(static_cast<unsigned char>(*start))) {
        start++;
    }

    const char* end = source + strlen(source);
    while (end > start && isspace(static_cast<unsigned char>(*(end - 1)))) {
        end--;
    }

    size_t len = static_cast<size_t>(end - start);
    while (len > 0 && start[len - 1] == '/') {
        len--;
    }

    if (len >= destSize) {
        len = destSize - 1;
    }
    memcpy(dest, start, len);
    dest[len] = '\0';
}

bool copySegment(const char* start, size_t len, char* dest, size_t destSize) {
    if (!dest || destSize == 0 || len == 0 || len >= destSize) return false;
    memcpy(dest, start, len);
    dest[len] = '\0';
    return true;
}

bool parseIntegerSegment(const char* value, int& output) {
    if (!value || value[0] == '\0') return false;
    char* end = nullptr;
    long parsed = strtol(value, &end, 10);
    if (!end || *end != '\0') return false;
    output = static_cast<int>(parsed);
    return true;
}

void sortSetIds(char* setIds) {
    if (!setIds || setIds[0] == '\0') return;

    static const int MAX_SET_IDS = 16;
    int parsedSetIds[MAX_SET_IDS];
    int parsedSetCount = 0;

    const char* cursor = setIds;
    while (*cursor && parsedSetCount < MAX_SET_IDS) {
        char* end = nullptr;
        long parsed = strtol(cursor, &end, 10);
        if (end == cursor) {
            return;
        }
        parsedSetIds[parsedSetCount++] = static_cast<int>(parsed);
        cursor = end;
        if (*cursor == ',') {
            cursor++;
        } else if (*cursor != '\0') {
            return;
        }
    }

    if (parsedSetCount == 0) return;

    for (int i = 1; i < parsedSetCount; i++) {
        int currentSetId = parsedSetIds[i];
        int sortIndex = i - 1;
        while (sortIndex >= 0 && parsedSetIds[sortIndex] > currentSetId) {
            parsedSetIds[sortIndex + 1] = parsedSetIds[sortIndex];
            sortIndex--;
        }
        parsedSetIds[sortIndex + 1] = currentSetId;
    }

    char sortedSetIds[64];
    sortedSetIds[0] = '\0';
    size_t used = 0;
    for (int i = 0; i < parsedSetCount; i++) {
        int written = snprintf(sortedSetIds + used, sizeof(sortedSetIds) - used,
                               "%s%d", i == 0 ? "" : ",", parsedSetIds[i]);
        if (written < 0 || static_cast<size_t>(written) >= sizeof(sortedSetIds) - used) {
            return;
        }
        used += static_cast<size_t>(written);
    }

    strncpy(setIds, sortedSetIds, 63);
    setIds[63] = '\0';
}

bool isQuerySafe(char value) {
    unsigned char c = static_cast<unsigned char>(value);
    return isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~';
}

void appendQueryPair(String& url, const char* key, const char* value, bool& hasQuery) {
    url += hasQuery ? "&" : "?";
    hasQuery = true;
    url += key;
    url += "=";
    url += urlEncodeQueryValue(value);
}

String buildLedPositionsQueryValue(const ThumbnailLedPosition* positions, int positionCount) {
    String value;
    if (!positions || positionCount <= 0) return value;

    for (int i = 0; i < positionCount; i++) {
        if (positions[i].position < 0) continue;
        if (value.length() > 0) {
            value += ",";
        }
        value += String(positions[i].position);
        value += ":";
        value += String(positions[i].r);
        value += ":";
        value += String(positions[i].g);
        value += ":";
        value += String(positions[i].b);
        if (positions[i].role >= 0) {
            value += ":";
            value += String(positions[i].role);
        }
    }

    return value;
}

void clearThumbnail(const RemoteThumbnailDisplayHooks& hooks) {
    if (hooks.clearThumbnail) {
        hooks.clearThumbnail(hooks.context);
    }
}

void showClimb(const RemoteThumbnailDisplayRequest& request, const RemoteThumbnailDisplayHooks& hooks) {
    if (!hooks.showClimb) return;
    hooks.showClimb(hooks.context,
                    request.climbName,
                    request.climbGrade ? request.climbGrade : "",
                    request.gradeColor ? request.gradeColor : "",
                    request.angle,
                    request.climbUuid ? request.climbUuid : "",
                    request.boardTypeName ? request.boardTypeName : "kilter");
}

void showThumbnailLoading(const RemoteThumbnailDisplayHooks& hooks) {
    if (hooks.showThumbnailLoading) {
        hooks.showThumbnailLoading(hooks.context);
    }
}

void setThumbnailJpeg(const RemoteThumbnailDisplayHooks& hooks, std::vector<uint8_t>&& data, const char* cacheKey) {
    if (hooks.setThumbnailJpeg) {
        hooks.setThumbnailJpeg(hooks.context, std::move(data), cacheKey);
    }
}

ThumbnailFetchResult fetchThumbnailJpeg(const RemoteThumbnailDisplayHooks& hooks,
                                        const char* url,
                                        std::vector<uint8_t>& output) {
    if (!hooks.fetchJpeg) {
        return ThumbnailFetchResult(ThumbnailFetchStatus::NETWORK_ERROR);
    }
    return hooks.fetchJpeg(hooks.context, url, output);
}

#ifndef UNIT_TEST
bool isHttpsUrl(const char* url) {
    return startsWithLiteral(url, "https://");
}
#endif

}  // namespace

bool parseBoardRenderRoute(const char* boardPath, BoardRenderRoute& route) {
    memset(&route, 0, sizeof(route));
    route.layoutId = -1;
    route.sizeId = -1;

    if (!boardPath || boardPath[0] == '\0') return false;

    const char* cursor = boardPath;
    while (*cursor == '/') {
        cursor++;
    }

    char segments[5][64];
    memset(segments, 0, sizeof(segments));
    int segmentCount = 0;
    const char* segmentStart = cursor;

    while (*cursor && segmentCount < 5) {
        if (*cursor == '/') {
            size_t segmentLen = static_cast<size_t>(cursor - segmentStart);
            if (segmentLen > 0) {
                if (!copySegment(segmentStart, segmentLen, segments[segmentCount], sizeof(segments[segmentCount]))) {
                    return false;
                }
                segmentCount++;
            }
            segmentStart = cursor + 1;
        }
        cursor++;
    }

    if (segmentCount < 5 && cursor > segmentStart) {
        size_t segmentLen = static_cast<size_t>(cursor - segmentStart);
        if (!copySegment(segmentStart, segmentLen, segments[segmentCount], sizeof(segments[segmentCount]))) {
            return false;
        }
        segmentCount++;
    }

    int offset = 0;
    if (segmentCount >= 5 && strlen(segments[0]) == 2 && islower(segments[0][0]) && islower(segments[0][1])) {
        offset = 1;
    }

    if (segmentCount - offset < 4) return false;

    if (!copySegment(segments[offset], strlen(segments[offset]), route.boardName, sizeof(route.boardName))) {
        return false;
    }
    if (!parseIntegerSegment(segments[offset + 1], route.layoutId)) return false;
    if (!parseIntegerSegment(segments[offset + 2], route.sizeId)) return false;
    if (!copySegment(segments[offset + 3], strlen(segments[offset + 3]), route.setIds, sizeof(route.setIds))) {
        return false;
    }
    sortSetIds(route.setIds);

    return route.boardName[0] != '\0' && route.setIds[0] != '\0';
}

String normalizeRenderBaseUrl(const char* baseUrl) {
    char trimmed[160];
    copyTrimmed(baseUrl, trimmed, sizeof(trimmed));

    if (trimmed[0] == '\0') {
        copyTrimmed(DEFAULT_RENDER_BASE_URL, trimmed, sizeof(trimmed));
    }
    stripPathAfterAuthority(trimmed);

    if (isBoardseshWebSocketRenderHost(trimmed)) {
        return String(DEFAULT_RENDER_BASE_URL);
    }

    if (startsWithLiteral(trimmed, "wss://")) {
        String normalized = "https://";
        normalized += trimmed + 6;
        return normalized;
    }
    if (startsWithLiteral(trimmed, "ws://")) {
        String normalized = "http://";
        normalized += trimmed + 5;
        return normalized;
    }
    if (startsWithLiteral(trimmed, "https://") || startsWithLiteral(trimmed, "http://")) {
        return String(trimmed);
    }

    String normalized = "https://";
    normalized += trimmed;
    return normalized;
}

String urlEncodeQueryValue(const char* value) {
    static const char HEX_DIGITS[] = "0123456789ABCDEF";

    String encoded;
    if (!value) return encoded;

    for (const char* cursor = value; *cursor; cursor++) {
        unsigned char current = static_cast<unsigned char>(*cursor);
        if (isQuerySafe(*cursor)) {
            encoded += *cursor;
        } else {
            encoded += "%";
            encoded += HEX_DIGITS[(current >> 4) & 0x0F];
            encoded += HEX_DIGITS[current & 0x0F];
        }
    }

    return encoded;
}

String buildBoardRenderThumbnailUrl(const char* renderBaseUrl,
                                    const char* boardPath,
                                    const char* frames,
                                    const ThumbnailUrlOptions& options) {
    BoardRenderRoute route;
    if (!parseBoardRenderRoute(boardPath, route)) {
        return "";
    }

    String url = normalizeRenderBaseUrl(renderBaseUrl);
    url += "/api/internal/board-render";

    bool hasQuery = false;
    appendQueryPair(url, "board_name", route.boardName, hasQuery);
    appendQueryPair(url, "layout_id", String(route.layoutId).c_str(), hasQuery);
    appendQueryPair(url, "size_id", String(route.sizeId).c_str(), hasQuery);
    appendQueryPair(url, "set_ids", route.setIds, hasQuery);
    appendQueryPair(url, "frames", frames ? frames : "", hasQuery);
    if (options.thumbnail) {
        appendQueryPair(url, "thumbnail", "1", hasQuery);
    }
    if (options.includeBackground) {
        appendQueryPair(url, "include_background", "1", hasQuery);
    }
    appendQueryPair(url, "format", options.format ? options.format : "jpg", hasQuery);

    return url;
}

String buildBoardRenderLedPositionsThumbnailUrl(const char* renderBaseUrl,
                                                const char* boardName,
                                                int layoutId,
                                                int sizeId,
                                                const char* setIds,
                                                const ThumbnailLedPosition* positions,
                                                int positionCount,
                                                const ThumbnailUrlOptions& options) {
    if (!boardName || boardName[0] == '\0' || layoutId <= 0 || sizeId <= 0 ||
        !setIds || setIds[0] == '\0' || !positions || positionCount <= 0) {
        return "";
    }

    String ledPositions = buildLedPositionsQueryValue(positions, positionCount);
    if (ledPositions.length() == 0) {
        return "";
    }

    String url = normalizeRenderBaseUrl(renderBaseUrl);
    url += "/api/internal/board-render";

    bool hasQuery = false;
    appendQueryPair(url, "board_name", boardName, hasQuery);
    appendQueryPair(url, "layout_id", String(layoutId).c_str(), hasQuery);
    appendQueryPair(url, "size_id", String(sizeId).c_str(), hasQuery);
    appendQueryPair(url, "set_ids", setIds, hasQuery);
    appendQueryPair(url, "led_positions", ledPositions.c_str(), hasQuery);
    if (options.thumbnail) {
        appendQueryPair(url, "thumbnail", "1", hasQuery);
    }
    if (options.includeBackground) {
        appendQueryPair(url, "include_background", "1", hasQuery);
    }
    appendQueryPair(url, "format", options.format ? options.format : "jpg", hasQuery);

    return url;
}

const char* thumbnailFetchStatusName(ThumbnailFetchStatus status) {
    switch (status) {
        case ThumbnailFetchStatus::OK:
            return "ok";
        case ThumbnailFetchStatus::INVALID_URL:
            return "invalid_url";
        case ThumbnailFetchStatus::HTTP_ERROR:
            return "http_error";
        case ThumbnailFetchStatus::BODY_TOO_LARGE:
            return "body_too_large";
        case ThumbnailFetchStatus::EMPTY_BODY:
            return "empty_body";
        case ThumbnailFetchStatus::NETWORK_ERROR:
            return "network_error";
        case ThumbnailFetchStatus::UNSUPPORTED_IN_TEST:
            return "unsupported_in_test";
        default:
            return "unknown";
    }
}

bool thumbnailUrlMatchesCache(const char* thumbnailUrl, const char* currentCacheKey) {
    return thumbnailUrl && currentCacheKey && thumbnailUrl[0] != '\0' && strcmp(thumbnailUrl, currentCacheKey) == 0;
}

RemoteThumbnailDisplayResult handleRemoteThumbnailDisplay(const RemoteThumbnailDisplayRequest& request,
                                                          const RemoteThumbnailDisplayHooks& hooks,
                                                          String& currentCacheKey) {
    if (!request.boardPath || request.boardPath[0] == '\0' || !request.frames || request.frames[0] == '\0') {
        currentCacheKey = "";
        clearThumbnail(hooks);
        return RemoteThumbnailDisplayResult::FALLBACK_REQUIRED;
    }

    String thumbnailUrl = buildBoardRenderThumbnailUrl(request.renderBaseUrl, request.boardPath, request.frames);
    if (thumbnailUrl.length() == 0) {
        currentCacheKey = "";
        clearThumbnail(hooks);
        return RemoteThumbnailDisplayResult::FALLBACK_REQUIRED;
    }

    if (thumbnailUrlMatchesCache(thumbnailUrl.c_str(), currentCacheKey.c_str())) {
        return RemoteThumbnailDisplayResult::CACHE_HIT;
    }

    Logger.logln("Thumbnail: fetching render preview (%u chars)", (unsigned)thumbnailUrl.length());
    showClimb(request, hooks);
    showThumbnailLoading(hooks);

    std::vector<uint8_t> jpegData;
    ThumbnailFetchResult thumbnailResult = fetchThumbnailJpeg(hooks, thumbnailUrl.c_str(), jpegData);
    if (thumbnailResult.ok()) {
        currentCacheKey = thumbnailUrl;
        Logger.logln("Thumbnail: fetched %u bytes", (unsigned)thumbnailResult.bytesRead);
        setThumbnailJpeg(hooks, std::move(jpegData), currentCacheKey.c_str());
        return RemoteThumbnailDisplayResult::FETCHED;
    }

    currentCacheKey = "";
    clearThumbnail(hooks);
    Logger.logln("Thumbnail: fetch failed (%s, http=%d)",
                 thumbnailFetchStatusName(thumbnailResult.status), thumbnailResult.httpStatus);
    showClimb(request, hooks);
    return RemoteThumbnailDisplayResult::FETCH_FAILED;
}

ThumbnailClient::ThumbnailClient(size_t maxBytes) : _maxBytes(maxBytes) {}

ThumbnailFetchResult ThumbnailClient::fetchJpeg(const char* url, std::vector<uint8_t>& output) {
    output.clear();

    if (!url || url[0] == '\0') {
        return ThumbnailFetchResult(ThumbnailFetchStatus::INVALID_URL);
    }

#ifdef UNIT_TEST
    return ThumbnailFetchResult(ThumbnailFetchStatus::UNSUPPORTED_IN_TEST);
#else
    HTTPClient http;
    http.setTimeout(THUMBNAIL_HTTP_TIMEOUT_MS);
    http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);

    WiFiClient plainClient;
    WiFiClientSecure secureClient;
    bool beginOk = false;
    if (isHttpsUrl(url)) {
        // Arduino ESP32 does not ship with the public root CA bundle we need here.
        // HTTPS still encrypts the JPEG request, but the user-configured render host
        // is not certificate-validated; keep the response size cap and JPEG decoder
        // choice conservative because this endpoint can be changed in device config.
        secureClient.setInsecure();
        beginOk = http.begin(secureClient, url);
    } else {
        beginOk = http.begin(plainClient, url);
    }

    if (!beginOk) {
        Logger.logln("Thumbnail: invalid render URL: %s", url);
        return ThumbnailFetchResult(ThumbnailFetchStatus::INVALID_URL);
    }

    http.addHeader("Connection", "close");

    int httpStatus = http.GET();
    if (httpStatus != HTTP_CODE_OK) {
        Logger.logln("Thumbnail: HTTP %d fetching %s", httpStatus, url);
        http.end();
        return ThumbnailFetchResult(ThumbnailFetchStatus::HTTP_ERROR, httpStatus);
    }

    int contentLength = http.getSize();
    if (contentLength > 0 && static_cast<size_t>(contentLength) > _maxBytes) {
        Logger.logln("Thumbnail: image too large (%d bytes)", contentLength);
        http.end();
        return ThumbnailFetchResult(ThumbnailFetchStatus::BODY_TOO_LARGE, httpStatus);
    }

    output.reserve(contentLength > 0 ? static_cast<size_t>(contentLength) : 8192);
    WiFiClient* stream = http.getStreamPtr();
    uint8_t buffer[512];
    size_t totalRead = 0;
    unsigned long lastReadAt = millis();

    while (http.connected() && (contentLength < 0 || totalRead < static_cast<size_t>(contentLength))) {
        size_t availableBytes = stream->available();
        if (availableBytes == 0) {
            if (millis() - lastReadAt > THUMBNAIL_HTTP_TIMEOUT_MS) {
                Logger.logln("Thumbnail: timed out while reading response");
                break;
            }
            delay(1);
            continue;
        }

        size_t readLimit = availableBytes < sizeof(buffer) ? availableBytes : sizeof(buffer);
        int bytesRead = stream->readBytes(buffer, readLimit);
        if (bytesRead <= 0) break;

        totalRead += static_cast<size_t>(bytesRead);
        if (totalRead > _maxBytes) {
            output.clear();
            http.end();
            return ThumbnailFetchResult(ThumbnailFetchStatus::BODY_TOO_LARGE, httpStatus, totalRead);
        }

        output.insert(output.end(), buffer, buffer + bytesRead);
        lastReadAt = millis();
    }

    http.end();

    if (output.empty()) {
        return ThumbnailFetchResult(ThumbnailFetchStatus::EMPTY_BODY, httpStatus, 0);
    }

    if (contentLength > 0 && totalRead < static_cast<size_t>(contentLength)) {
        output.clear();
        return ThumbnailFetchResult(ThumbnailFetchStatus::NETWORK_ERROR, httpStatus, totalRead);
    }

    return ThumbnailFetchResult(ThumbnailFetchStatus::OK, httpStatus, output.size());
#endif
}
