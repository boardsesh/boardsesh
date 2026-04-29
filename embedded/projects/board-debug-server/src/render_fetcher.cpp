#include "render_fetcher.h"

#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <esp_heap_caps.h>

#include <log_buffer.h>

namespace board_debug {

namespace {

constexpr size_t kMaxBodyBytes = 1024 * 1024;  // 1MB; covers ~480px PNGs with the homewall background composited in.
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
    // width=480 hits the panel's image-area width once the backend supports
    // the param. thumbnail=1 is sent alongside as a graceful fallback for any
    // backend version that doesn't (it'll just use the 200px thumbnail).
    url += "&width=480&thumbnail=1&include_background=1&format=png";
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
    // ESP32 HTTPClient has no built-in decompression; force identity so a
    // helpful CDN doesn't hand us a gzipped body we can't decode.
    http.addHeader("Accept-Encoding", "identity");
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

    // Cloudflare returns the body with `Transfer-Encoding: chunked` (no
    // Content-Length), so we can't read raw from the stream — the bytes
    // would still have hex chunk-size markers embedded. HTTPClient's
    // writeToStream() handles the chunk framing for us; we just need a Stream
    // subclass that buffers into PSRAM.
    const size_t reserveSize = contentLength > 0 ? static_cast<size_t>(contentLength) : 256 * 1024;
    uint8_t* buf = static_cast<uint8_t*>(heap_caps_malloc(reserveSize, MALLOC_CAP_SPIRAM));
    if (!buf) buf = static_cast<uint8_t*>(malloc(reserveSize));
    if (!buf) {
        _lastError = "alloc failed";
        Logger.logln("[render] alloc %u failed", static_cast<unsigned>(reserveSize));
        http.end();
        return result;
    }

    struct PsramSink : public Stream {
        uint8_t* buf = nullptr;
        size_t cap = 0;
        size_t total = 0;
        bool overflowed = false;
        bool growFailed = false;

        bool grow(size_t need) {
            if (need <= cap) return true;
            size_t newCap = cap == 0 ? 4096 : cap * 2;
            while (newCap < need) newCap *= 2;
            if (newCap > kMaxBodyBytes) newCap = kMaxBodyBytes;
            if (newCap < need) {
                overflowed = true;
                return false;
            }
            uint8_t* newBuf = static_cast<uint8_t*>(heap_caps_realloc(buf, newCap, MALLOC_CAP_SPIRAM));
            if (!newBuf) newBuf = static_cast<uint8_t*>(realloc(buf, newCap));
            if (!newBuf) {
                growFailed = true;
                return false;
            }
            buf = newBuf;
            cap = newCap;
            return true;
        }

        size_t write(uint8_t b) override {
            if (!grow(total + 1)) return 0;
            buf[total++] = b;
            return 1;
        }
        size_t write(const uint8_t* data, size_t len) override {
            if (!grow(total + len)) {
                size_t headroom = cap > total ? cap - total : 0;
                if (headroom > 0) {
                    memcpy(buf + total, data, headroom);
                    total += headroom;
                }
                return headroom;
            }
            memcpy(buf + total, data, len);
            total += len;
            return len;
        }
        int available() override { return 0; }
        int read() override { return -1; }
        int peek() override { return -1; }
        void flush() override {}
    } sink;
    sink.buf = buf;
    sink.cap = reserveSize;

    const int written = http.writeToStream(&sink);
    buf = sink.buf;  // sink may have realloc'd
    size_t total = sink.total;
    result.bytes = total;
    result.fetchMs = millis() - fetchStart;
    http.end();

    if (sink.overflowed) {
        free(buf);
        result.status = RenderStatus::BODY_TOO_LARGE;
        _lastError = "body too large";
        return result;
    }
    if (sink.growFailed) {
        free(buf);
        _lastError = "realloc failed";
        return result;
    }
    if (written < 0) {
        free(buf);
        _lastError = String("writeToStream err ") + written;
        return result;
    }

    if (total == 0) {
        free(buf);
        _lastError = "empty body";
        return result;
    }

    // Diagnostic: log magic + size mismatch so a "decode failed" later isn't
    // ambiguous. PNG signature is 89 50 4E 47 0D 0A 1A 0A.
    Logger.logln("[render] body %u bytes (expected %d), magic %02X %02X %02X %02X %02X %02X %02X %02X",
                 static_cast<unsigned>(total), contentLength,
                 buf[0], total > 1 ? buf[1] : 0, total > 2 ? buf[2] : 0,
                 total > 3 ? buf[3] : 0, total > 4 ? buf[4] : 0,
                 total > 5 ? buf[5] : 0, total > 6 ? buf[6] : 0,
                 total > 7 ? buf[7] : 0);
    if (contentLength > 0 && total != static_cast<size_t>(contentLength)) {
        free(buf);
        result.status = RenderStatus::DECODE_ERROR;
        _lastError = String("short read: ") + total + "/" + contentLength;
        return result;
    }
    if (total < 8 || buf[0] != 0x89 || buf[1] != 0x50 || buf[2] != 0x4E || buf[3] != 0x47) {
        free(buf);
        result.status = RenderStatus::DECODE_ERROR;
        _lastError = "not a PNG (bad signature)";
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
