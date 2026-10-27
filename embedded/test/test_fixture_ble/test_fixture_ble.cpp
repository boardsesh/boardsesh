#include "ble.h"

#include <cstdio>
#include <cstdlib>
#include <initializer_list>
#include <log_buffer.h>

using gym_fixture::CompletedUpdate;
static unsigned checks = 0;
#define CHECK(expression)                                                      \
    do {                                                                       \
        ++checks;                                                              \
        if (!(expression)) {                                                   \
            std::fprintf(stderr, "FAIL line %d: %s\n", __LINE__, #expression); \
            std::abort();                                                      \
        }                                                                      \
    } while (false)

FixtureJsonNode makeBoard(const char* family, const char* uuid, const char* serial, int layout) {
    FixtureJsonNode board;
    board.object["uuid"] = uuid;
    board.object["serialNumber"] = serial;
    board.object["boardType"] = family;
    const std::string name =
        std::string(family) == "moonboard"
            ? std::string("MoonBoard A#") + serial
            : std::string(std::string(family) == "kilter" ? "Kilter" : "Tension") + " Board#" + serial + "@3";
    board.object["advertisedName"] = name.c_str();
    board.object["angle"] = 40;
    board.object["layoutId"] = layout;
    return board;
}
std::vector<uint8_t> frame(uint8_t command, std::initializer_list<uint16_t> positions) {
    std::vector<uint8_t> body{command};
    for (auto position : positions) {
        body.push_back(position & 255);
        body.push_back(position >> 8);
        body.push_back(28);
    }
    uint8_t checksum = 0;
    for (auto byte : body)
        checksum += byte;
    std::vector<uint8_t> bytes{1, static_cast<uint8_t>(body.size()), static_cast<uint8_t>(checksum ^ 255), 2};
    bytes.insert(bytes.end(), body.begin(), body.end());
    bytes.push_back(3);
    return bytes;
}
int main() {
    Logger.enableSerial(false);
    FixtureJsonNode manifest;
    manifest.object["gymUuid"] = "production-qa-gym";
    manifest.object["boards"].array = {makeBoard("kilter", "board-kilter", "99000001", 8),
                                       makeBoard("tension", "board-tension", "99000002", 10),
                                       makeBoard("moonboard", "board-moon", "99000003", 3)};
    gym_fixture::FixtureBle fixture;
    String error;
    CHECK(fixture.begin(JsonVariantConst(&manifest), error));
    for (size_t index = 0; index < 3; index++)
        CHECK(fixture.isAdvertising(index));
    auto addresses = fixture_ble_host::addresses;
    for (auto address : addresses)
        CHECK((address.val[5] & 0xc0) == 0xc0);
    auto* service = NimBLEDevice::server.getServiceByUUID("6E400001-B5A3-F393-E0A9-E50E24DCCA9E");
    auto* rx = service->getCharacteristic("6E400002-B5A3-F393-E0A9-E50E24DCCA9E");
    auto write = [&](uint16_t handle, const std::vector<uint8_t>& bytes) { rx->write(handle, bytes); };
    auto moon = [&](uint16_t handle, const char* text) {
        write(handle, std::vector<uint8_t>(text, text + std::strlen(text)));
    };
    CompletedUpdate update;
    for (size_t index = 0; index < 3; index++)
        NimBLEDevice::server.connect(index, 10 + index);
    CHECK(fixture.connectionCount() == 3);
    auto first = frame('T', {123});
    write(10, {first.begin(), first.begin() + 3});
    CHECK(!fixture.takeUpdate(update));
    write(11, frame('T', {777}));
    write(10, {first.begin() + 3, first.end()});
    CHECK(fixture.takeUpdate(update) && update.boardIndex == 1 && update.commands[0].position == 777);
    CHECK(fixture.takeUpdate(update) && update.boardIndex == 0 && update.commands[0].position == 123);
    write(10, frame('R', {4}));
    write(11, frame('S', {99}));
    CHECK(!fixture.takeUpdate(update));
    write(10, frame('S', {8}));
    CHECK(fixture.takeUpdate(update) && update.boardIndex == 0 && update.commands.size() == 2 &&
          update.commands[1].position == 8);
    auto invalid = frame('T', {1});
    invalid[2] ^= 1;
    write(10, invalid);
    CHECK(!fixture.takeUpdate(update));
    invalid = frame('T', {});
    invalid.insert(invalid.end() - 1, 42);
    invalid[1] = 2;
    invalid[2] = static_cast<uint8_t>((84 + 42) ^ 255);
    write(10, invalid);
    CHECK(!fixture.takeUpdate(update));
    write(10, frame('S', {4}));
    CHECK(!fixture.takeUpdate(update));
    std::vector<uint8_t> body{'R'};
    for (unsigned i = 0; i < 84; i++) {
        body.push_back(i);
        body.push_back(0);
        body.push_back(28);
    }
    auto packet = [&](uint8_t command) {
        body[0] = command;
        uint8_t sum = 0;
        for (auto byte : body)
            sum += byte;
        std::vector<uint8_t> bytes{1, 253, static_cast<uint8_t>(sum ^ 255), 2};
        bytes.insert(bytes.end(), body.begin(), body.end());
        bytes.push_back(3);
        return bytes;
    };
    write(10, packet('R'));
    for (unsigned count = 0; count < 20; count++)
        write(10, packet('Q'));
    write(10, frame('S', {1}));
    CHECK(!fixture.takeUpdate(update));
    write(10, frame('T', {}));
    CHECK(fixture.takeUpdate(update) && update.commands.empty());
    write(10, frame('T', {1}));
    write(11, frame('T', {2}));
    write(10, frame('T', {3}));
    CHECK(fixture.takeUpdate(update) && update.boardIndex == 1 && update.commands[0].position == 2);
    CHECK(fixture.takeUpdate(update) && update.boardIndex == 0 && update.commands[0].position == 3);
    moon(12, "l#S");
    CHECK(!fixture.takeUpdate(update));
    moon(12, "0,P17,E197#");
    CHECK(fixture.takeUpdate(update) && update.boardIndex == 2 && update.commands.size() == 3 &&
          update.commands.back().position == 197);
    moon(12, "l#Snope#");
    CHECK(!fixture.takeUpdate(update));
    moon(12, "l#S198#");
    CHECK(!fixture.takeUpdate(update));
    moon(12, "l#S0,#");
    CHECK(!fixture.takeUpdate(update));
    moon(12, "~Dl#S1,E5#");
    CHECK(fixture.takeUpdate(update) && update.commands.size() == 3 && update.commands[1].position == 2 &&
          update.commands[1].r == 255 && update.commands[1].g == 255);
    moon(12, "l##");
    CHECK(fixture.takeUpdate(update) && update.commands.empty());
    manifest.object["boards"].array[2].object["layoutId"] = 6;
    CHECK(fixture.begin(JsonVariantConst(&manifest), error));
    CHECK(fixture.connectionCount() == 0);
    for (size_t index = 0; index < 3; index++)
        CHECK(std::memcmp(addresses[index].val, fixture_ble_host::addresses[index].val, 6) == 0);
    NimBLEDevice::server.connect(2, 22);
    moon(22, "~Ml#S10,P11,E131#");
    CHECK(fixture.takeUpdate(update) && update.commands.size() == 3 && update.commands.back().position == 131);
    moon(22, "~MDl#S10#");
    CHECK(fixture.takeUpdate(update) && update.commands.size() == 2 && update.commands.back().position == 11);
    moon(22, "~DMl#P13#");
    CHECK(fixture.takeUpdate(update) && update.commands.size() == 2 && update.commands.back().position == 12);
    moon(22, "l#S132#");
    CHECK(!fixture.takeUpdate(update));
    fixture_ble_host::synced = false;
    fixtureBleTestMillis += 300;
    fixture.loop();
    moon(22, "l#S10#");
    CHECK(!fixture.takeUpdate(update));
    NimBLEDevice::server.disconnect(22);
    fixture_ble_host::active.fill(false);
    fixture_ble_host::configured.fill(false);
    fixture_ble_host::synced = true;
    fixtureBleTestMillis += 300;
    fixture.loop();
    for (size_t index = 0; index < 3; index++)
        CHECK(fixture.isAdvertising(index));
    NimBLEDevice::server.connect(2, 23);
    moon(23, "l#S10#");
    CHECK(fixture.takeUpdate(update) && update.commands[0].position == 10);
    fixture.stop();
    CHECK(fixture.connectionCount() == 0);
    for (size_t index = 0; index < 3; index++)
        CHECK(!fixture.isAdvertising(index));
    NimBLEDevice::server.connect(0, 50);
    CHECK(fixture.connectionCount() == 0 && fixture_ble_host::peers.empty());
    manifest.object["boards"].array[0] = makeBoard("kilter", "board-kilter", "99000999", 8);
    CHECK(fixture.begin(JsonVariantConst(&manifest), error));
    CHECK(std::memcmp(addresses[0].val, fixture_ble_host::addresses[0].val, 6) != 0);
    auto valid = fixture_ble_host::addresses[0];
    fixture_ble_host::addresses[0].val[0] ^= 0x80;
    NimBLEDevice::server.connect(0, 51);
    CHECK(fixture.connectionCount() == 0 && fixture_ble_host::peers.empty());
    fixture_ble_host::addresses[0] = valid;
    fixture.stop();
    std::printf("Fixture BLE: %u checks passed\n", checks);
}
