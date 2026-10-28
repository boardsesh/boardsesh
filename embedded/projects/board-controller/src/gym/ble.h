#pragma once

#include <Arduino.h>
#include <ArduinoJson.h>
#include <NimBLEDevice.h>
#include <esp_mac.h>

#include <array>
#include <atomic>
#include <aurora_protocol.h>
#include <cstring>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <mbedtls/sha256.h>
#include <moonboard_protocol.h>
#include <string>
#include <utility>
#include <vector>

namespace gym_fixture {

struct CompletedUpdate {
    size_t boardIndex = 0;
    uint64_t sequence = 0;
    std::vector<LedCommand> commands;
    int angle = 0;
};

// One NUS service backs independent radio identities. Only the local address
// selected by the controller routes a connection; the phone address never does.
class FixtureBle : private NimBLEServerCallbacks, private NimBLECharacteristicCallbacks {
  public:
    FixtureBle() = default;
    FixtureBle(const FixtureBle&) = delete;
    FixtureBle& operator=(const FixtureBle&) = delete;

    bool begin(JsonVariantConst manifest, String& error) {
        std::array<Board, MAX_BOARDS> proposed{};
        const JsonArrayConst boards = manifest["boards"].as<JsonArrayConst>();
        const String gymUuid = manifest["gymUuid"].as<String>();
        if (gymUuid.length() == 0 || boards.size() < 1 || boards.size() > MAX_BOARDS)
            return fail(error, "Invalid BLE gym manifest");
        uint8_t deviceMac[6];
        if (esp_read_mac(deviceMac, ESP_MAC_BT) != ESP_OK)
            return fail(error, "Cannot read the device Bluetooth identity");
        for (size_t index = 0; index < boards.size(); ++index) {
            JsonVariantConst source = boards[index];
            Board& board = proposed[index];
            board.uuid = source["uuid"].as<String>();
            board.serial = source["serialNumber"].as<String>();
            board.family = source["boardType"].as<String>();
            board.name = source["advertisedName"].as<String>();
            board.angle = source["angle"].as<int>();
            board.rows = source["layoutId"].as<int>() == 6 || source["layoutId"].as<int>() == 7 ? 12 : 18;
            const bool moonboard = board.family == "moonboard";
            const String expected =
                moonboard ? String("MoonBoard A#") + board.serial
                          : String(board.family == "kilter" ? "Kilter" : "Tension") + " Board#" + board.serial + "@3";
            if ((board.family != "kilter" && board.family != "tension" && !moonboard) || board.uuid.length() == 0 ||
                board.serial.length() < 4 || board.serial.length() > 32 || board.name != expected ||
                board.name.length() > 29 || board.angle < 0 || board.angle > 90)
                return fail(error, "Unsupported BLE board identity");
            for (char character : board.serial) {
                if (!((character >= 'A' && character <= 'Z') || (character >= '0' && character <= '9') ||
                      character == ':' || character == '-'))
                    return fail(error, "Invalid BLE board serial");
            }
            std::string identity(reinterpret_cast<const char*>(deviceMac), sizeof(deviceMac));
            identity += "|";
            identity += gymUuid.c_str();
            identity += "|";
            identity += board.uuid.c_str();
            identity += "|";
            identity += board.serial.c_str();
            uint8_t digest[32];
            if (mbedtls_sha256(reinterpret_cast<const uint8_t*>(identity.data()), identity.size(), digest, 0) != 0)
                return fail(error, "Cannot derive BLE board address");
            // NimBLE stores address bytes least-significant first. Set the two
            // high bits for static random; guarantee both bit values below them.
            digest[5] |= 0xC0;
            digest[0] = (digest[0] & 0xFE) | 0x02;
            // The byte-pointer constructor expects MSB-first input and reverses
            // it. Preserve these native LSB-first bytes with the native overload.
            ble_addr_t nativeAddress{};
            nativeAddress.type = BLE_ADDR_RANDOM;
            std::memcpy(nativeAddress.val, digest, sizeof(nativeAddress.val));
            board.address = NimBLEAddress(nativeAddress);
            for (size_t previous = 0; previous < index; ++previous) {
                if (proposed[previous].uuid == board.uuid || proposed[previous].serial == board.serial ||
                    proposed[previous].address == board.address)
                    return fail(error, "Duplicate BLE board identity");
            }
        }
        if (!_mutex)
            _mutex = xSemaphoreCreateMutex();
        if (!_mutex)
            return fail(error, "Cannot allocate BLE state lock");
        stop();
        if (_server && _server->getConnectedCount() != 0)
            return fail(error, "Waiting for old Bluetooth connections to close");
        if (!_server) {
            if (!NimBLEDevice::init("Boardsesh gym fixture"))
                return fail(error, "Cannot initialize Bluetooth");
            NimBLEDevice::setMTU(247);
            _server = NimBLEDevice::createServer();
            if (!_server)
                return fail(error, "Cannot create Bluetooth service");
            _server->setCallbacks(this, false);
            _advertising = NimBLEDevice::getAdvertising();
        }
        if (!_gattReady) {
            NimBLEService* service = _server->getServiceByUUID(NUS_UUID);
            if (!service)
                service = _server->createService(NUS_UUID);
            if (!service)
                return fail(error, "Cannot create Bluetooth UART service");
            _tx = service->getCharacteristic(TX_UUID);
            if (!_tx)
                _tx = service->createCharacteristic(TX_UUID, NIMBLE_PROPERTY::NOTIFY);
            NimBLECharacteristic* rx = service->getCharacteristic(RX_UUID);
            if (!rx)
                rx = service->createCharacteristic(RX_UUID, NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR,
                                                   MAX_WRITE_BYTES);
            if (!_tx || !rx)
                return fail(error, "Cannot create Bluetooth UART characteristics");
            rx->setCallbacks(this);
            service->start();
            if (!_server->start())
                return fail(error, "Cannot start Bluetooth service");
            _gattReady = true;
        }
        {
            Lock lock(_mutex);
            _boards = std::move(proposed);
            _boardCount = boards.size();
            resetConnectionsLocked();
            _pending.fill(false);
            _writes.fill(0);
            _completed.fill(0);
            _rejected.fill(0);
        }
        _enabled = true;
        _needsConfiguration = true;
        if (!configureAll()) {
            stop();
            return fail(error, "Cannot advertise every configured board");
        }
        _needsConfiguration = false;
        _accepting.store(true);
        _lastEnsureAt = millis();
        error = "";
        return true;
    }

    void stop() {
        _enabled = false;
        _accepting.store(false);
        if (!_server)
            return;
        // stop() in NimBLE 2.5.2 clears a copy of its activity flags. Stop each
        // instance explicitly, then remove it only after stopping its radio.
        for (size_t index = 0; _advertising && index < _boardCount; ++index) {
            _advertising->stop(index);
            _advertising->removeInstance(index);
        }
        for (uint16_t handle : _server->getPeerDevices())
            _server->disconnect(handle);
        const unsigned long startedAt = millis();
        while (_server->getConnectedCount() != 0 && millis() - startedAt < 2000)
            delay(5);
        if (_mutex) {
            Lock lock(_mutex);
            _pending.fill(false);
            if (_server->getConnectedCount() == 0)
                resetConnectionsLocked();
        }
    }

    void loop() {
        if (!_enabled || millis() - _lastEnsureAt < 250)
            return;
        _lastEnsureAt = millis();
        if (!ble_hs_synced()) {
            _accepting.store(false);
            _needsConfiguration = true;
            return;
        }
        if (_needsConfiguration) {
            if (configureAll()) {
                _needsConfiguration = false;
                _accepting.store(true);
            }
            return;
        }
        for (size_t index = 0; index < _boardCount; ++index) {
            // Query the host, not NimBLE's cached isActive flags, which survive
            // host reset incorrectly in 2.5.2. Reconfigure missing controller data.
            if (ble_gap_ext_adv_active(index) == 0 && !_advertising->start(index)) {
                _accepting.store(false);
                _needsConfiguration = true;
            }
        }
    }

    bool takeUpdate(CompletedUpdate& update) {
        if (!_mutex)
            return false;
        Lock lock(_mutex);
        size_t selected = MAX_BOARDS;
        for (size_t index = 0; index < _boardCount; ++index) {
            if (_pending[index] && (selected == MAX_BOARDS || _updates[index].sequence < _updates[selected].sequence))
                selected = index;
        }
        if (selected == MAX_BOARDS)
            return false;
        update = std::move(_updates[selected]);
        _pending[selected] = false;
        return true;
    }

    unsigned connectionCount() const { return _connectionCount.load(); }

    bool isAdvertising(size_t boardIndex) const {
        return _enabled && boardIndex < _boardCount && ble_hs_synced() && ble_gap_ext_adv_active(boardIndex) != 0;
    }

    void appendStatus(JsonArray boards) const {
        if (!_mutex)
            return;
        // Serialize bounded snapshots outside the lock. BLE callbacks never
        // wait on JSON allocation, network I/O or display work.
        std::array<Board, MAX_BOARDS> snapshot;
        std::array<unsigned, MAX_BOARDS> connections{}, writes{}, completed{}, rejected{};
        size_t boardCount;
        {
            Lock lock(_mutex);
            snapshot = _boards;
            boardCount = _boardCount;
            writes = _writes;
            completed = _completed;
            rejected = _rejected;
            for (const Connection& connection : _connections) {
                if (connection.handle != BLE_HS_CONN_HANDLE_NONE && connection.boardIndex < boardCount)
                    ++connections[connection.boardIndex];
            }
        }
        for (size_t index = 0; index < boardCount; ++index) {
            JsonObject board = index < boards.size() ? boards[index].as<JsonObject>() : boards.add<JsonObject>();
            board["uuid"] = snapshot[index].uuid;
            board["name"] = snapshot[index].name;
            board["address"] = snapshot[index].address.toString();
            board["advertising"] = isAdvertising(index);
            board["connections"] = connections[index];
            board["writes"] = writes[index];
            board["updates"] = completed[index];
            board["rejected"] = rejected[index];
        }
    }

  private:
    static constexpr size_t MAX_BOARDS = 3;
    static constexpr size_t MAX_WRITE_BYTES = 512;
    static constexpr size_t MAX_COMMANDS = 1024;
    static constexpr size_t MAX_MOON_BYTES = 2048;
    static constexpr unsigned long PARTIAL_TIMEOUT_MS = 2000;
    static constexpr const char* NUS_UUID = "6E400001-B5A3-F393-E0A9-E50E24DCCA9E";
    static constexpr const char* RX_UUID = "6E400002-B5A3-F393-E0A9-E50E24DCCA9E";
    static constexpr const char* TX_UUID = "6E400003-B5A3-F393-E0A9-E50E24DCCA9E";
    static constexpr const char* AURORA_UUID = "4488B571-7806-4DF6-BCFF-A2897E4953FF";

    struct Lock {
        explicit Lock(SemaphoreHandle_t mutex) : mutex(mutex) { xSemaphoreTake(mutex, portMAX_DELAY); }
        ~Lock() { xSemaphoreGive(mutex); }
        SemaphoreHandle_t mutex;
    };
    struct Board {
        String uuid, serial, family, name;
        NimBLEAddress address{};
        int angle = 0;
        int rows = 18;
    };
    enum class MoonStage { Idle, Config, Hash, Payload };
    struct Connection {
        uint16_t handle = BLE_HS_CONN_HANDLE_NONE;
        size_t boardIndex = MAX_BOARDS;
        AuroraProtocol aurora;
        MoonBoardProtocol moon;
        std::vector<uint8_t> frame;
        std::string moonFrame;
        MoonStage moonStage = MoonStage::Idle;
        unsigned version = 0;
        size_t commandCount = 0;
        unsigned long lastInputAt = 0;

        void clearParser() {
            aurora.clear();
            moon.clear();
            frame.clear();
            moonFrame.clear();
            moonStage = MoonStage::Idle;
            version = 0;
            commandCount = 0;
            lastInputAt = 0;
        }
    };
    SemaphoreHandle_t _mutex = nullptr;
    NimBLEServer* _server = nullptr;
    NimBLECharacteristic* _tx = nullptr;
    NimBLEExtAdvertising* _advertising = nullptr;
    std::array<Board, MAX_BOARDS> _boards{};
    std::array<Connection, MAX_BOARDS> _connections{};
    std::array<CompletedUpdate, MAX_BOARDS> _updates{};
    std::array<bool, MAX_BOARDS> _pending{};
    std::array<unsigned, MAX_BOARDS> _writes{}, _completed{}, _rejected{};
    std::atomic<unsigned> _connectionCount{0};
    std::atomic<bool> _accepting{false};
    size_t _boardCount = 0;
    uint64_t _sequence = 0;
    bool _enabled = false;
    bool _gattReady = false;
    bool _needsConfiguration = false;
    unsigned long _lastEnsureAt = 0;

    static bool fail(String& error, const char* message) {
        error = message;
        return false;
    }

    void resetConnectionsLocked() {
        for (Connection& connection : _connections) {
            connection.handle = BLE_HS_CONN_HANDLE_NONE;
            connection.boardIndex = MAX_BOARDS;
            connection.clearParser();
        }
        _connectionCount.store(0);
    }

    bool configureAll() {
        if (!_advertising || !ble_hs_synced())
            return false;
        for (size_t index = 0; index < _boardCount; ++index) {
            _advertising->stop(index);
            _advertising->removeInstance(index);
            NimBLEExtAdvertisement advertisement;
            advertisement.setLegacyAdvertising(true);
            advertisement.setConnectable(true);
            advertisement.setScannable(true);
            advertisement.setAddress(_boards[index].address);
            advertisement.setFlags(BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP);
            advertisement.addServiceUUID(_boards[index].family == "moonboard" ? NUS_UUID : AURORA_UUID);
            NimBLEExtAdvertisement scanResponse;
            scanResponse.setName(_boards[index].name.c_str());
            if (!_advertising->setInstanceData(index, advertisement) ||
                !_advertising->setScanResponseData(index, scanResponse) || !_advertising->start(index))
                return false;
        }
        return true;
    }

    void onConnect(NimBLEServer* server, NimBLEConnInfo& info) override {
        ble_gap_conn_desc descriptor{};
        bool accepted = false;
        if (_accepting.load() && ble_gap_conn_find(info.getConnHandle(), &descriptor) == 0) {
            const NimBLEAddress localAddress(descriptor.our_ota_addr);
            Lock lock(_mutex);
            if (_accepting.load()) {
                for (size_t index = 0; index < _boardCount && !accepted; ++index) {
                    if (localAddress != _boards[index].address)
                        continue;
                    for (Connection& connection : _connections) {
                        if (connection.handle != BLE_HS_CONN_HANDLE_NONE)
                            continue;
                        connection.clearParser();
                        connection.handle = info.getConnHandle();
                        connection.boardIndex = index;
                        _connectionCount.fetch_add(1);
                        accepted = true;
                        break;
                    }
                }
            }
        }
        if (!accepted)
            server->disconnect(info.getConnHandle());
    }

    void onDisconnect(NimBLEServer*, NimBLEConnInfo& info, int) override {
        Lock lock(_mutex);
        for (Connection& connection : _connections) {
            if (connection.handle == info.getConnHandle()) {
                connection.handle = BLE_HS_CONN_HANDLE_NONE;
                connection.boardIndex = MAX_BOARDS;
                connection.clearParser();
                _connectionCount.fetch_sub(1);
                break;
            }
        }
    }

    void onWrite(NimBLECharacteristic* characteristic, NimBLEConnInfo& info) override {
        if (!_accepting.load())
            return;
        const auto payload = characteristic->getValue();
        Lock lock(_mutex);
        if (!_accepting.load())
            return;
        for (Connection& connection : _connections) {
            if (connection.handle != info.getConnHandle() || connection.boardIndex >= _boardCount)
                continue;
            ++_writes[connection.boardIndex];
            if (payload.size() == 0)
                return;
            if (payload.size() > MAX_WRITE_BYTES) {
                connection.clearParser();
                ++_rejected[connection.boardIndex];
                return;
            }
            const unsigned long now = millis();
            if (connection.lastInputAt != 0 && now - connection.lastInputAt > PARTIAL_TIMEOUT_MS)
                connection.clearParser();
            connection.lastInputAt = now;
            for (size_t index = 0; index < payload.size(); ++index) {
                if (_boards[connection.boardIndex].family == "moonboard")
                    receiveMoonByte(connection, payload[index]);
                else
                    receiveAuroraByte(connection, payload[index]);
            }
            return;
        }
    }

    void publishLocked(Connection& connection, const std::vector<LedCommand>& commands) {
        if (commands.size() > MAX_COMMANDS) {
            ++_rejected[connection.boardIndex];
            return;
        }
        CompletedUpdate& update = _updates[connection.boardIndex];
        update.boardIndex = connection.boardIndex;
        update.sequence = ++_sequence;
        update.commands = commands;
        update.angle = _boards[connection.boardIndex].angle;
        _pending[connection.boardIndex] = true;
        ++_completed[connection.boardIndex];
    }

    void resetAuroraSequence(Connection& connection) {
        connection.aurora.clear();
        connection.version = 0;
        connection.commandCount = 0;
        ++_rejected[connection.boardIndex];
    }

    void receiveAuroraByte(Connection& connection, uint8_t byte) {
        auto& frame = connection.frame;
        if (frame.empty() && byte != FRAME_SOH)
            return;
        frame.push_back(byte);
        while (frame.size() >= 4) {
            if (frame[0] != FRAME_SOH || frame[1] == 0 || frame[3] != FRAME_STX) {
                frame.erase(frame.begin());
                resetAuroraSequence(connection);
                continue;
            }
            const size_t frameSize = frame[1] + 5;
            if (frame.size() < frameSize)
                return;
            const uint8_t command = frame[4];
            const bool v2 = command == 'P' || command == 'N' || command == 'M' || command == 'O';
            const bool v3 = command == 'T' || command == 'R' || command == 'Q' || command == 'S';
            uint8_t checksum = 0;
            for (size_t index = 4; index < frameSize - 1; ++index)
                checksum += frame[index];
            if ((!v2 && !v3) || frame[frameSize - 1] != FRAME_ETX ||
                frame[2] != static_cast<uint8_t>(checksum ^ 0xFF) || (frame[1] - 1) % (v2 ? 2 : 3) != 0) {
                frame.erase(frame.begin());
                resetAuroraSequence(connection);
                continue;
            }
            const size_t count = (frame[1] - 1) / (v2 ? 2 : 3);
            const bool first = command == 'N' || command == 'R';
            const bool only = command == 'P' || command == 'T';
            const bool last = command == 'O' || command == 'S';
            if (first || only) {
                connection.aurora.clear();
                connection.version = only ? 0 : (v2 ? 2 : 3);
                connection.commandCount = 0;
            }
            const bool sequenceValid = only || first || connection.version == (v2 ? 2u : 3u);
            if (!sequenceValid || connection.commandCount + count > MAX_COMMANDS) {
                resetAuroraSequence(connection);
            } else {
                connection.commandCount += count;
                if (connection.aurora.addData(frame.data(), frameSize))
                    publishLocked(connection, connection.aurora.getLedCommands());
                if (only || last) {
                    connection.version = 0;
                    connection.commandCount = 0;
                }
            }
            frame.erase(frame.begin(), frame.begin() + frameSize);
        }
    }

    void receiveMoonByte(Connection& connection, uint8_t byte) {
        const char character = static_cast<char>(byte);
        if (character == '~') {
            connection.moonFrame = "~";
            connection.moonStage = MoonStage::Config;
            return;
        }
        if (character == 'l' && connection.moonStage != MoonStage::Payload) {
            if (connection.moonStage == MoonStage::Config)
                connection.moonFrame += character;
            else
                connection.moonFrame = "l";
            connection.moonStage = MoonStage::Hash;
            return;
        }
        if (connection.moonStage == MoonStage::Idle)
            return;
        if (connection.moonFrame.size() >= MAX_MOON_BYTES) {
            connection.moonFrame.clear();
            connection.moonStage = MoonStage::Idle;
            ++_rejected[connection.boardIndex];
            return;
        }
        if (connection.moonStage == MoonStage::Config) {
            // The manufacturer Mini flag may accompany the additional-LED
            // flag. Geometry still comes from the configured layout; retain D
            // for the shared decoder instead of dropping it when M follows.
            if ((character == 'D' || character == 'M') && connection.moonFrame.find(character) == std::string::npos) {
                connection.moonFrame += character;
                return;
            }
            if (character == 'l') {
                connection.moonFrame += character;
                connection.moonStage = MoonStage::Hash;
                return;
            }
        } else if (connection.moonStage == MoonStage::Hash && character == '#') {
            connection.moonFrame += character;
            connection.moonStage = MoonStage::Payload;
            return;
        } else if (connection.moonStage == MoonStage::Payload) {
            connection.moonFrame += character;
            if (character != '#')
                return;
            completeMoonFrame(connection);
        }
        connection.moonFrame.clear();
        connection.moonStage = MoonStage::Idle;
    }

    void completeMoonFrame(Connection& connection) {
        const std::string& frame = connection.moonFrame;
        const size_t opening = frame.find('#');
        const size_t end = frame.size() - 1;
        size_t tokens = 0;
        const int rows = _boards[connection.boardIndex].rows;
        size_t cursor = opening + 1;
        while (cursor < end) {
            const char role = frame[cursor++];
            if (std::strchr("SsRrPpLlMmFfEe", role) == nullptr || cursor >= end || frame[cursor] < '0' ||
                frame[cursor] > '9') {
                ++_rejected[connection.boardIndex];
                return;
            }
            unsigned position = 0;
            while (cursor < end && frame[cursor] >= '0' && frame[cursor] <= '9') {
                position = position * 10 + frame[cursor++] - '0';
                if (position >= static_cast<unsigned>(11 * rows)) {
                    ++_rejected[connection.boardIndex];
                    return;
                }
            }
            if (++tokens > static_cast<size_t>(11 * rows) ||
                (cursor < end && (frame[cursor++] != ',' || cursor == end))) {
                ++_rejected[connection.boardIndex];
                return;
            }
        }
        connection.moon.clear();
        if (!connection.moon.addData(reinterpret_cast<const uint8_t*>(frame.data()), frame.size())) {
            ++_rejected[connection.boardIndex];
            return;
        }
        const auto& problem = connection.moon.getDecodedProblem();
        if (problem.holds.size() != tokens) {
            ++_rejected[connection.boardIndex];
            return;
        }
        std::vector<LedCommand> commands;
        commands.reserve(tokens * 2);
        size_t commandIndex = 0;
        for (const auto& hold : problem.holds) {
            commands.push_back(problem.ledCommands[commandIndex++]);
            if (hold.hasAuxMarker)
                ++commandIndex;  // Replace the legacy parser's fixed 18-row auxiliary mapping.
            const int column = hold.serialPosition / rows;
            const int offset = hold.serialPosition % rows;
            if (problem.lightsAboveHolds && hold.token != 'E' && hold.token != 'e' && offset > 0 && offset < rows - 1) {
                const int adjacent = hold.serialPosition + (column % 2 == 0 ? 1 : -1);
                commands.push_back(LedCommand{adjacent, 255, 255, 0});
            }
        }
        // Positions remain manufacturer wire positions, including Mini's
        // 12-row serpentine order. The downloaded geometry owns pixel mapping.
        publishLocked(connection, commands);
    }
};

}  // namespace gym_fixture
