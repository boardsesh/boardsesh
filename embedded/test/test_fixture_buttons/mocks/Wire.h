#pragma once
#include <cstdint>
#include <utility>
#include <vector>

struct FixtureMockWire {
    uint8_t registers[256]{};
    uint8_t address = 0;
    int chip = 0;
    bool failReads = false;
    bool failWrites = false;
    std::vector<uint8_t> bytes;
    std::vector<std::pair<uint8_t, uint8_t>> writes;

    void beginTransmission(int device) { chip = device; bytes.clear(); }
    void write(uint8_t byte) { bytes.push_back(byte); }
    int endTransmission(bool = true) {
        address = bytes.at(0);
        if (bytes.size() == 2) {
            if (failWrites) return 4;
            writes.emplace_back(address, bytes[1]);
            if (address == 0x49) registers[address] &= ~bytes[1];
            else registers[address] = bytes[1];
        }
        return 0;
    }
    int requestFrom(uint8_t, uint8_t) { return failReads ? 0 : 1; }
    int read() { return registers[address]; }
};

inline FixtureMockWire Wire;
