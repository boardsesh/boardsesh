#ifndef THUMBNAIL_CLIENT_H
#define THUMBNAIL_CLIENT_H

#include <Arduino.h>
#include <stddef.h>
#include <stdint.h>

#include <vector>

#define THUMBNAIL_RENDER_BASE_KEY "render_base_url"
#define THUMBNAIL_MAX_JPEG_BYTES 65536
#define THUMBNAIL_HTTP_TIMEOUT_MS 4000

// Longest path segment the route parser will carry, and therefore the longest
// set-ids list a device can ask for.
//
// 24 ids (MAX_SET_IDS, matching the server) at three digits each plus their
// separators is 95 characters. Every buffer the list passes through is sized
// from this one constant, because they have to agree: while the path splitter
// held 64, a 24-id list was refused before `setIds` ever saw it and the whole
// route was dropped — which reads as a blank thumbnail, not a short one.
static const size_t MAX_ROUTE_SEGMENT = 96;

struct BoardRenderRoute {
    char boardName[24];
    int layoutId;
    int sizeId;
    char setIds[MAX_ROUTE_SEGMENT];
};

struct ThumbnailUrlOptions {
    bool thumbnail;
    bool includeBackground;
    const char* format;

    ThumbnailUrlOptions() : thumbnail(true), includeBackground(true), format("jpg") {}
};

enum class ThumbnailFetchStatus {
    OK,
    INVALID_URL,
    HTTP_ERROR,
    BODY_TOO_LARGE,
    EMPTY_BODY,
    NETWORK_ERROR,
    UNSUPPORTED_IN_TEST
};

struct ThumbnailFetchResult {
    ThumbnailFetchStatus status;
    int httpStatus;
    size_t bytesRead;

    ThumbnailFetchResult(ThumbnailFetchStatus statusValue = ThumbnailFetchStatus::OK,
                         int httpStatusValue = 0,
                         size_t bytesReadValue = 0)
        : status(statusValue), httpStatus(httpStatusValue), bytesRead(bytesReadValue) {}

    bool ok() const { return status == ThumbnailFetchStatus::OK; }
};

struct RemoteThumbnailDisplayRequest {
    const char* renderBaseUrl;
    const char* boardPath;
    const char* frames;
    const char* climbName;
    const char* climbGrade;
    const char* gradeColor;
    int angle;
    const char* climbUuid;
    const char* boardTypeName;
};

struct RemoteThumbnailDisplayHooks {
    void* context;
    void (*clearThumbnail)(void* context);
    void (*showClimb)(void* context,
                      const char* climbName,
                      const char* climbGrade,
                      const char* gradeColor,
                      int angle,
                      const char* climbUuid,
                      const char* boardTypeName);
    void (*showThumbnailLoading)(void* context);
    void (*setThumbnailJpeg)(void* context, std::vector<uint8_t>&& data, const char* cacheKey);
    ThumbnailFetchResult (*fetchJpeg)(void* context, const char* url, std::vector<uint8_t>& output);
};

enum class RemoteThumbnailDisplayResult {
    FALLBACK_REQUIRED,
    CACHE_HIT,
    FETCHED,
    FETCH_FAILED
};

bool parseBoardRenderRoute(const char* boardPath, BoardRenderRoute& route);
String normalizeRenderBaseUrl(const char* baseUrl);
String urlEncodeQueryValue(const char* value);
String buildBoardRenderThumbnailUrl(const char* renderBaseUrl,
                                    const char* boardPath,
                                    const char* frames,
                                    const ThumbnailUrlOptions& options = ThumbnailUrlOptions());
const char* thumbnailFetchStatusName(ThumbnailFetchStatus status);
bool thumbnailUrlMatchesCache(const char* thumbnailUrl, const char* currentCacheKey);
RemoteThumbnailDisplayResult handleRemoteThumbnailDisplay(const RemoteThumbnailDisplayRequest& request,
                                                          const RemoteThumbnailDisplayHooks& hooks,
                                                          String& currentCacheKey);

class ThumbnailClient {
  public:
    explicit ThumbnailClient(size_t maxBytes = THUMBNAIL_MAX_JPEG_BYTES);
    ThumbnailFetchResult fetchJpeg(const char* url, std::vector<uint8_t>& output);

  private:
    size_t _maxBytes;
};

#endif  // THUMBNAIL_CLIENT_H
