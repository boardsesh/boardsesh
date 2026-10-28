#pragma once

#include <cstddef>
#include <cstdint>
#include <cstring>

namespace gym_fixture::cache_validation {
inline uint16_t little16(const uint8_t* bytes) {
    return bytes[0] | (static_cast<uint16_t>(bytes[1]) << 8);
}
inline uint16_t big16(const uint8_t* bytes) {
    return (static_cast<uint16_t>(bytes[0]) << 8) | bytes[1];
}

inline bool geometry(const uint8_t* bytes, size_t size, unsigned width, unsigned height, unsigned count) {
    if (!bytes || width == 0 || width > 330 || height == 0 || height > 330 || count == 0 || count > 1024 ||
        size != 12 + count * 8 || memcmp(bytes, "BSGM", 4) != 0 || little16(bytes + 4) != 1 ||
        little16(bytes + 6) != count || little16(bytes + 8) != width || little16(bytes + 10) != height)
        return false;
    unsigned previous = 0;
    for (unsigned index = 0; index < count; ++index) {
        const uint8_t* entry = bytes + 12 + index * 8;
        unsigned position = little16(entry);
        unsigned radius = little16(entry + 6);
        if ((index > 0 && position <= previous) || little16(entry + 2) >= width || little16(entry + 4) >= height ||
            radius == 0 || radius > 255)
            return false;
        previous = position;
    }
    return true;
}

// Inspect the baseline header before the MCU decoder sees the input. SHA-256
// authenticates the entire downloaded asset against the manifest separately.
inline bool jpeg(const uint8_t* bytes, size_t size, unsigned width, unsigned height) {
    if (!bytes || size < 4 || size > 65536 || width == 0 || width > 330 || height == 0 || height > 330 ||
        bytes[0] != 0xFF || bytes[1] != 0xD8 || bytes[size - 2] != 0xFF || bytes[size - 1] != 0xD9)
        return false;
    bool dimensionsMatch = false;
    size_t offset = 2;
    while (offset + 4 <= size) {
        if (bytes[offset++] != 0xFF)
            return false;
        while (offset < size && bytes[offset] == 0xFF)
            ++offset;
        if (offset + 3 > size)
            return false;
        uint8_t marker = bytes[offset++];
        size_t length = big16(bytes + offset);
        if (length < 2 || length > size - offset)
            return false;
        if (marker == 0xDA)
            return dimensionsMatch && length >= 6 && offset + length < size - 2;
        if (marker == 0xC0) {
            if (length < 11 || bytes[offset + 2] != 8 || big16(bytes + offset + 3) != height ||
                big16(bytes + offset + 5) != width || (bytes[offset + 7] != 1 && bytes[offset + 7] != 3) ||
                length != 8u + static_cast<size_t>(bytes[offset + 7]) * 3u)
                return false;
            dimensionsMatch = true;
        } else if (marker >= 0xC1 && marker <= 0xCF && marker != 0xC4 && marker != 0xC8 && marker != 0xCC) {
            return false;
        }
        offset += length;
    }
    return false;
}
}  // namespace gym_fixture::cache_validation

// Native tests exercise the same binary validators without an ESP32 SDK.
#ifndef FIXTURE_CACHE_VALIDATION_ONLY
#include <Arduino.h>
#include <ArduinoJson.h>
#include <esp_partition.h>

#include <HTTPClient.h>
#include <LittleFS.h>
#include <NetworkClientSecure.h>
#include <config_manager.h>
#include <mbedtls/sha256.h>
#include <vector>

namespace gym_fixture {

// This partition is the verified blank tail, not the pre-existing factory
// assets/storage covered by the old "spiffs" partition. Never format by default.
class FixtureCache {
  public:
    bool begin(String& error) {
        _available = false;
        _loaded = false;
        const esp_partition_t* partition =
            esp_partition_find_first(ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_ANY, "fixture_cache");
        if (!partition || partition->address != 0xF20000 || partition->size != 0xD0000 || partition->encrypted)
            return fail(error, "Fixture cache partition does not match the reserved region");

        // State 1 authorizes recovery only from our interrupted initial format.
        // State 2 never authorizes reformatting an existing, damaged cache.
        int state = Config.getInt("fx_cache_owner", 0);
        if (state != OWNER_INITIALIZING && state != OWNER_READY) {
            uint8_t block[256];
            for (size_t offset = 0; offset < partition->size; offset += sizeof(block)) {
                if (esp_partition_read(partition, offset, block, sizeof(block)) != ESP_OK)
                    return fail(error, "Cannot verify the reserved cache region");
                for (uint8_t byte : block) {
                    if (byte != 0xFF)
                        return fail(error, "Reserved cache region contains unowned data; left untouched");
                }
                yield();
            }
            if (!Config.setInt("fx_cache_owner", OWNER_INITIALIZING))
                return fail(error, "Cannot record cache ownership");
            state = OWNER_INITIALIZING;
        }

        bool mounted = LittleFS.begin(false, "/fixture_cache", 6, "fixture_cache");
        if (!mounted && state == OWNER_INITIALIZING) {
            // begin(false) has set the explicit label even when mounting fails.
            mounted = LittleFS.format() && LittleFS.begin(false, "/fixture_cache", 6, "fixture_cache");
        }
        if (!mounted)
            return fail(error, "Fixture cache cannot mount; existing data left untouched");
        if (state != OWNER_READY && !Config.setInt("fx_cache_owner", OWNER_READY))
            return fail(error, "Cannot finalize cache ownership");
        _active = Config.getInt("fx_cache_slot", -1);
        if (_active < 0 || _active > 1)
            _active = -1;
        _available = true;
        error = "";
        return true;
    }

    bool available() const { return _available; }

    bool load(const String& gymRef, const String& endpoint, JsonDocument& manifest, String& error) {
        _loaded = false;
        manifest.clear();
        if (!_available)
            return fail(error, "Fixture cache unavailable");
        // No pointer means no generation has ever committed. Never activate an
        // uncommitted staged manifest merely because its downloads completed.
        int committed = Config.getInt("fx_cache_slot", -1);
        if (committed < 0 || committed > 1)
            return fail(error, "No committed fixture cache");
        JsonDocument record;
        if (!loadSlot(committed, gymRef, endpoint, record, error))
            return false;
        _active = committed;
        _manifest.set(record["manifest"]);
        manifest.set(record["manifest"]);
        _loaded = true;
        error = "";
        return true;
    }

    bool stage(JsonVariantConst manifest, const String& gymRef, const String& endpoint, String& error) {
        if (!_available)
            return fail(error, "Fixture cache unavailable");
        if (!validateManifest(manifest, endpoint, error))
            return false;
        JsonDocument record;
        record["gymRef"] = gymRef;
        record["endpoint"] = endpoint;
        record["manifest"].set(manifest);
        if (measureJson(record) > MAX_MANIFEST_BYTES)
            return fail(error, "Fixture manifest exceeds cache limit");

        const int committed = Config.getInt("fx_cache_slot", -1);
        if (committed < -1 || committed > 1)
            return fail(error, "Invalid committed cache slot");
        const int staging = committed == 0 ? 1 : 0;
        if (!clearSlot(staging, error))
            return false;
        JsonArrayConst boards = manifest["boards"].as<JsonArrayConst>();
        std::vector<uint8_t> bytes;
        for (size_t index = 0; index < boards.size(); ++index) {
            JsonVariantConst preview = boards[index]["preview"];
            for (bool image : {true, false}) {
                const char* url = preview[image ? "imageUrl" : "geometryUrl"];
                size_t expected = preview[image ? "imageBytes" : "geometryBytes"].as<size_t>();
                if (!download(url, expected, bytes, error) || !validateAsset(bytes, preview, image, error) ||
                    !writeBytes(assetPath(staging, index, image), bytes.data(), bytes.size(), error))
                    return false;
            }
        }
        const String recordPath = manifestPath(staging);
        File output = LittleFS.open(recordPath, FILE_WRITE);
        if (!output)
            return fail(error, "Cannot create staged manifest");
        size_t written = serializeJson(record, output);
        output.flush();
        output.close();
        if (written != measureJson(record))
            return fail(error, "Incomplete staged manifest write");
        // Validate the persisted generation before the single atomic NVS commit.
        JsonDocument verified;
        if (!loadSlot(staging, gymRef, endpoint, verified, error))
            return false;
        if (!Config.setInt("fx_cache_slot", staging))
            return fail(error, "Cannot commit fixture cache");
        _active = staging;
        _manifest.set(manifest);
        _loaded = true;
        error = "";
        return true;
    }

    bool readAsset(size_t boardIndex, bool image, std::vector<uint8_t>& bytes, String& error) {
        bytes.clear();
        if (!_available || !_loaded || boardIndex >= _manifest["boards"].size())
            return fail(error, "No loaded asset for this board");
        JsonVariantConst preview = _manifest["boards"][boardIndex]["preview"];
        size_t expected = preview[image ? "imageBytes" : "geometryBytes"].as<size_t>();
        return readBytes(assetPath(_active, boardIndex, image), expected, bytes, error) &&
               validateAsset(bytes, preview, image, error);
    }

  private:
    static constexpr size_t MAX_MANIFEST_BYTES = 32768;
    static constexpr size_t MAX_IMAGE_BYTES = 65536;
    static constexpr int OWNER_INITIALIZING = 0x46583201;
    static constexpr int OWNER_READY = 0x46583202;
    bool _available = false;
    bool _loaded = false;
    int _active = -1;
    JsonDocument _manifest;

    static bool fail(String& error, const char* message) {
        error = message;
        return false;
    }

    static String manifestPath(int slot) { return String("/g") + slot + "-manifest.json"; }
    static String assetPath(int slot, size_t board, bool image) {
        return String("/g") + slot + "-b" + static_cast<unsigned>(board) + (image ? ".jpg" : ".bin");
    }

    static bool clearSlot(int slot, String& error) {
        const String record = manifestPath(slot);
        if (LittleFS.exists(record) && !LittleFS.remove(record))
            return fail(error, "Cannot clear inactive manifest");
        for (size_t board = 0; board < 3; ++board) {
            for (bool image : {true, false}) {
                String path = assetPath(slot, board, image);
                if (LittleFS.exists(path) && !LittleFS.remove(path))
                    return fail(error, "Cannot clear inactive asset");
            }
        }
        return true;
    }

    // Strict HTTPS origin parser: reject userinfo, ambiguous slashes, controls,
    // invalid ports and fragments. WSS is accepted only for the configured endpoint.
    static String secureOrigin(const String& url, bool endpoint) {
        int start = url.startsWith("https://") ? 8 : (endpoint && url.startsWith("wss://") ? 6 : -1);
        if (start < 0)
            return "";
        for (size_t index = 0; index < url.length(); ++index) {
            unsigned char character = url[index];
            if (character <= 32 || character >= 127 || character == '\\' || character == '#')
                return "";
        }
        int end = url.length();
        for (int index = start; index < end; ++index) {
            if (url[index] == '/' || url[index] == '?') {
                end = index;
                break;
            }
        }
        String authority = url.substring(start, end);
        authority.toLowerCase();
        int colon = authority.indexOf(':');
        String host = colon < 0 ? authority : authority.substring(0, colon);
        if (host.length() == 0 || host.startsWith(".") || host.endsWith("."))
            return "";
        for (size_t index = 0; index < host.length(); ++index) {
            char character = host[index];
            if (!((character >= 'a' && character <= 'z') || (character >= '0' && character <= '9') ||
                  character == '-' || character == '.'))
                return "";
        }
        unsigned port = 443;
        if (colon >= 0) {
            String digits = authority.substring(colon + 1);
            if (digits.length() == 0 || digits.length() > 5)
                return "";
            port = 0;
            for (size_t index = 0; index < digits.length(); ++index) {
                if (digits[index] < '0' || digits[index] > '9')
                    return "";
                port = port * 10 + digits[index] - '0';
            }
            if (port == 0 || port > 65535)
                return "";
        }
        return String("https://") + host + (port == 443 ? String("") : String(":") + port);
    }

    static bool validHash(JsonVariantConst hash) {
        if (!hash.is<const char*>())
            return false;
        const char* text = hash.as<const char*>();
        if (strlen(text) != 64)
            return false;
        for (size_t index = 0; index < 64; ++index) {
            if (!((text[index] >= '0' && text[index] <= '9') || (text[index] >= 'a' && text[index] <= 'f')))
                return false;
        }
        return true;
    }

    static bool validateManifest(JsonVariantConst manifest, const String& endpoint, String& error) {
        String origin = secureOrigin(endpoint, true);
        JsonArrayConst boards = manifest["boards"].as<JsonArrayConst>();
        if (origin.length() == 0 || boards.isNull() || boards.size() == 0 || boards.size() > 3)
            return fail(error, "Invalid fixture manifest or HTTPS endpoint");
        for (JsonVariantConst board : boards) {
            JsonVariantConst preview = board["preview"];
            for (const char* field : {"width", "height", "positionCount", "imageBytes", "geometryBytes"}) {
                if (!preview[field].is<unsigned>() || preview[field].as<unsigned>() == 0)
                    return fail(error, "Invalid asset dimensions or size");
            }
            if (preview["width"].as<unsigned>() > 330 || preview["height"].as<unsigned>() > 330 ||
                preview["positionCount"].as<unsigned>() > 1024 ||
                preview["imageBytes"].as<unsigned>() > MAX_IMAGE_BYTES ||
                preview["geometryBytes"].as<unsigned>() != 12 + preview["positionCount"].as<unsigned>() * 8)
                return fail(error, "Asset exceeds fixture limits");
            if (!validHash(preview["imageSha256"]) || !validHash(preview["geometrySha256"]))
                return fail(error, "Invalid asset digest");
            for (const char* field : {"imageUrl", "geometryUrl"}) {
                if (!preview[field].is<const char*>() ||
                    secureOrigin(preview[field].as<const char*>(), false) != origin)
                    return fail(error, "Asset URL must use the configured HTTPS origin");
            }
        }
        return true;
    }

    static bool validateAsset(const std::vector<uint8_t>& bytes, JsonVariantConst preview, bool image, String& error) {
        const size_t expected = preview[image ? "imageBytes" : "geometryBytes"].as<size_t>();
        if (bytes.size() != expected || bytes.empty())
            return fail(error, "Asset length mismatch");
        uint8_t digest[32];
        if (mbedtls_sha256(bytes.data(), bytes.size(), digest, 0) != 0)
            return fail(error, "Cannot verify asset digest");
        const char* hash = preview[image ? "imageSha256" : "geometrySha256"];
        constexpr char hex[] = "0123456789abcdef";
        for (size_t index = 0; index < 32; ++index) {
            if (hash[index * 2] != hex[digest[index] >> 4] || hash[index * 2 + 1] != hex[digest[index] & 15])
                return fail(error, "Asset digest mismatch");
        }
        const unsigned width = preview["width"];
        const unsigned height = preview["height"];
        if (!image) {
            const unsigned count = preview["positionCount"];
            return cache_validation::geometry(bytes.data(), bytes.size(), width, height, count) ||
                   fail(error, "Invalid BSGM geometry");
        }
        return cache_validation::jpeg(bytes.data(), bytes.size(), width, height) ||
               fail(error, "JPEG must be baseline with matching preview dimensions");
    }

    static bool readBytes(const String& path, size_t expected, std::vector<uint8_t>& bytes, String& error) {
        bytes.clear();
        if (expected == 0 || expected > MAX_IMAGE_BYTES)
            return fail(error, "Invalid cached asset size");
        File file = LittleFS.open(path, FILE_READ);
        if (!file || file.size() != expected)
            return fail(error, "Cached asset missing or truncated");
        bytes.resize(expected);
        if (file.read(bytes.data(), expected) != expected) {
            bytes.clear();
            return fail(error, "Cannot read cached asset");
        }
        return true;
    }

    static bool writeBytes(const String& path, const uint8_t* bytes, size_t size, String& error) {
        File file = LittleFS.open(path, FILE_WRITE);
        if (!file)
            return fail(error, "Cannot create staged asset");
        size_t written = file.write(bytes, size);
        file.flush();
        file.close();
        return written == size || fail(error, "Incomplete staged asset write");
    }

    static bool loadSlot(int slot, const String& gymRef, const String& endpoint, JsonDocument& record, String& error) {
        File file = LittleFS.open(manifestPath(slot), FILE_READ);
        if (!file || file.size() == 0 || file.size() > MAX_MANIFEST_BYTES)
            return fail(error, "Cached manifest unavailable");
        if (deserializeJson(record, file) || !record["gymRef"].is<const char*>() ||
            !record["endpoint"].is<const char*>() || record["gymRef"].as<String>() != gymRef ||
            record["endpoint"].as<String>() != endpoint)
            return fail(error, "Cached manifest does not match this gym and endpoint");
        file.close();
        JsonVariantConst manifest = record["manifest"];
        if (!validateManifest(manifest, endpoint, error))
            return false;
        JsonArrayConst boards = manifest["boards"].as<JsonArrayConst>();
        std::vector<uint8_t> bytes;
        for (size_t index = 0; index < boards.size(); ++index) {
            JsonVariantConst preview = boards[index]["preview"];
            for (bool image : {true, false}) {
                size_t expected = preview[image ? "imageBytes" : "geometryBytes"].as<size_t>();
                if (!readBytes(assetPath(slot, index, image), expected, bytes, error) ||
                    !validateAsset(bytes, preview, image, error))
                    return false;
            }
        }
        return true;
    }

    class DownloadSink : public Stream {
      public:
        DownloadSink(std::vector<uint8_t>& bytes, size_t expected)
            : _bytes(bytes), _expected(expected), _start(millis()) {}
        size_t write(uint8_t byte) override { return write(&byte, 1); }
        size_t write(const uint8_t* buffer, size_t size) override {
            if (millis() - _start > 30000 || size > _expected - _bytes.size())
                return 0;
            _bytes.insert(_bytes.end(), buffer, buffer + size);
            return size;
        }
        int available() override { return 0; }
        int read() override { return -1; }
        int peek() override { return -1; }
        void flush() override {}

      private:
        std::vector<uint8_t>& _bytes;
        size_t _expected;
        unsigned long _start;
    };

    static bool download(const char* url, size_t expected, std::vector<uint8_t>& bytes, String& error) {
        bytes.clear();
        NetworkClientSecure client;
        client.useBuiltinCACertBundle();
        HTTPClient http;
        http.setConnectTimeout(5000);
        http.setTimeout(5000);
        http.setFollowRedirects(HTTPC_DISABLE_FOLLOW_REDIRECTS);
        if (!http.begin(client, url))
            return fail(error, "Cannot initialize verified HTTPS asset download");
        int status = http.GET();
        if (status != HTTP_CODE_OK || (http.getSize() >= 0 && static_cast<size_t>(http.getSize()) != expected)) {
            http.end();
            return fail(error, "Asset download failed or has an unexpected length");
        }
        bytes.reserve(expected);
        DownloadSink sink(bytes, expected);
        int received = http.writeToStream(&sink);
        http.end();
        if (received < 0 || static_cast<size_t>(received) != expected || bytes.size() != expected) {
            bytes.clear();
            return fail(error, "Asset download incomplete or exceeds its limit");
        }
        return true;
    }
};

}  // namespace gym_fixture
#endif  // FIXTURE_CACHE_VALIDATION_ONLY
