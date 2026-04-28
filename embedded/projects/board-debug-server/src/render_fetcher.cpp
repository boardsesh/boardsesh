#include "render_fetcher.h"

#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <esp_heap_caps.h>

#include <log_buffer.h>

namespace board_debug {

namespace {

constexpr size_t kMaxBodyBytes = 384 * 1024;  // 384KB; thumbnail PNG comes in well under this.
constexpr uint32_t kHttpTimeoutMs = 10000;

String urlEncode(const String& s) {
    String out;
    out.reserve(s.length() * 3);
    static const char* hex = "0123456789ABCDEF";
    for (size_t i = 0; i < s.length(); i++) {
        char c = s[i];
        if (isalnum(static_cast<unsigned char>(c)) || c == '-' || c == '_' || c == '.' || c == '~') {
            out += c;
        } else {
            out += '%';
            out += hex[(c >> 4) & 0x0F];
            out += hex[c & 0x0F];
        }
    }
    return out;
}

}  // namespace

void RenderFetcher::begin(LGFX_Device* display, int16_t targetX, int16_t targetY,
                          int16_t targetWidth, int16_t targetHeight) {
    _display = display;
    _targetX = targetX;
    _targetY = targetY;
    _targetWidth = targetWidth;
    _targetHeight = targetHeight;
}

String RenderFetcher::buildUrl(const RenderRequest& request) const {
    String url = "https://www.boardsesh.com/api/internal/board-render";
    url += "?board_name=";
    url += boardNameToString(request.board);
    url += "&layout_id=";
    url += String(request.layoutId);
    url += "&size_id=";
    url += String(request.sizeId);
    url += "&set_ids=";
    url += urlEncode(request.setIdsCsv);
    if (request.angle >= 0) {
        url += "&angle=";
        url += String(request.angle);
    }
    url += "&frames=";
    url += urlEncode(request.frames);
    url += "&thumbnail=1&include_background=1&format=png";
    return url;
}

RenderResult RenderFetcher::fetchAndDisplay(const RenderRequest& request) {
    RenderResult result{RenderStatus::NETWORK_ERROR, -1, 0, 0, 0};
    _lastError = "";
    _lastUrl = buildUrl(request);

    Logger.logln("[render] GET %s", _lastUrl.c_str());

    WiFiClientSecure client;
    client.setInsecure();  // dev-rig; the office network is the only TLS surface.
    client.setTimeout(kHttpTimeoutMs / 1000);

    HTTPClient http;
    http.setTimeout(kHttpTimeoutMs);
    http.setReuse(false);
    http.setFollowRedirects(HTTPC_FORCE_FOLLOW_REDIRECTS);

    if (!http.begin(client, _lastUrl)) {
        _lastError = "http begin failed";
        return result;
    }
    http.addHeader("Accept", "image/png");
    http.addHeader("User-Agent", "Boardsesh-DebugFirmware/0.1");

    const uint32_t fetchStart = millis();
    const int code = http.GET();
    result.httpCode = code;
    if (code != 200) {
        result.status = code <= 0 ? RenderStatus::NETWORK_ERROR : RenderStatus::HTTP_ERROR;
        _lastError = String("http ") + code;
        Logger.logln("[render] http error %d", code);
        http.end();
        return result;
    }

    const int contentLength = http.getSize();
    if (contentLength > 0 && static_cast<size_t>(contentLength) > kMaxBodyBytes) {
        result.status = RenderStatus::BODY_TOO_LARGE;
        result.bytes = contentLength;
        _lastError = "body too large";
        Logger.logln("[render] body too large: %d", contentLength);
        http.end();
        return result;
    }

    // Pull the whole body into a PSRAM buffer; LovyanGFX wants contiguous bytes.
    const size_t reserveSize = contentLength > 0 ? static_cast<size_t>(contentLength) : 64 * 1024;
    uint8_t* buf = static_cast<uint8_t*>(heap_caps_malloc(reserveSize, MALLOC_CAP_SPIRAM));
    if (!buf) {
        buf = static_cast<uint8_t*>(malloc(reserveSize));
    }
    if (!buf) {
        _lastError = "alloc failed";
        Logger.logln("[render] alloc %u failed", static_cast<unsigned>(reserveSize));
        http.end();
        return result;
    }

    size_t cap = reserveSize;
    size_t total = 0;
    WiFiClient* stream = http.getStreamPtr();
    while (http.connected()) {
        const size_t avail = stream->available();
        if (avail == 0) {
            if (contentLength > 0 && total >= static_cast<size_t>(contentLength)) break;
            delay(2);
            continue;
        }
        if (total + avail > kMaxBodyBytes) {
            free(buf);
            buf = nullptr;
            result.status = RenderStatus::BODY_TOO_LARGE;
            result.bytes = total + avail;
            _lastError = "body too large";
            http.end();
            return result;
        }
        if (total + avail > cap) {
            size_t newCap = cap * 2;
            while (newCap < total + avail) newCap *= 2;
            if (newCap > kMaxBodyBytes) newCap = kMaxBodyBytes;
            uint8_t* newBuf = static_cast<uint8_t*>(heap_caps_realloc(buf, newCap, MALLOC_CAP_SPIRAM));
            if (!newBuf) newBuf = static_cast<uint8_t*>(realloc(buf, newCap));
            if (!newBuf) {
                free(buf);
                _lastError = "realloc failed";
                http.end();
                return result;
            }
            buf = newBuf;
            cap = newCap;
        }
        const int read = stream->readBytes(buf + total, avail);
        if (read <= 0) break;
        total += read;
        if (contentLength > 0 && total >= static_cast<size_t>(contentLength)) break;
    }
    result.bytes = total;
    result.fetchMs = millis() - fetchStart;
    http.end();

    if (total == 0) {
        free(buf);
        _lastError = "empty body";
        return result;
    }

    if (!_display) {
        free(buf);
        _lastError = "display not initialized";
        result.status = RenderStatus::DECODE_ERROR;
        return result;
    }

    // Clear the target rectangle so a smaller image doesn't leave stale pixels.
    _display->fillRect(_targetX, _targetY, _targetWidth, _targetHeight, TFT_BLACK);

    const uint32_t drawStart = millis();
    // LovyanGFX scales the image to fit `maxWidth` x `maxHeight` while preserving aspect ratio
    // when scale_x/scale_y are 0. We pass the target rect dims so the decoded PNG fills the area.
    const bool ok = _display->drawPng(buf, total, _targetX, _targetY,
                                      _targetWidth, _targetHeight);
    result.drawMs = millis() - drawStart;
    free(buf);

    if (!ok) {
        result.status = RenderStatus::DECODE_ERROR;
        _lastError = "png decode failed";
        Logger.logln("[render] png decode failed (%u bytes)", static_cast<unsigned>(total));
        return result;
    }

    result.status = RenderStatus::OK;
    Logger.logln("[render] ok: %u bytes in %ums fetch + %ums draw",
                 static_cast<unsigned>(total), static_cast<unsigned>(result.fetchMs),
                 static_cast<unsigned>(result.drawMs));
    return result;
}

}  // namespace board_debug
