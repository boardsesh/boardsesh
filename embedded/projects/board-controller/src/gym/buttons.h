#pragma once

#include <Arduino.h>

#include <Wire.h>

namespace gym_fixture {

// Call from the display/main task, after Display.begin() starts Wire on 15/14.
class FixtureButtons {
  public:
    bool begin() {
        pinMode(kNextPin, INPUT_PULLUP);
        rawDown_ = stableDown_ = digitalRead(kNextPin) == LOW;
        changedAt_ = lastPmuPoll_ = millis();
        pressArmed_ = false;  // A button held during boot is not a new press.
        begun_ = true;
        pmuReady_ = false;
        uint8_t chipId = 0;
        uint8_t enabled = 0;
        if (!readRegister(0x03, chipId) || chipId != 0x4A || !readRegister(kIrqEnable, enabled))
            return false;
        // Preserve every other interrupt and all power/charger/ADC settings.
        if (!writeRegister(kIrqEnable, enabled | kShortPress) || !writeRegister(kIrqStatus, kShortPress))
            return false;
        pmuReady_ = true;
        return true;
    }

    // +1: user key short release; -1: PWR short press; 0: no event.
    // GPIO18 remains usable if begin() reports a missing/unreachable PMU.
    int poll() {
        if (!begun_)
            return 0;
        const uint32_t now = millis();
        const bool down = digitalRead(kNextPin) == LOW;
        if (down != rawDown_) {
            rawDown_ = down;
            changedAt_ = now;
        }
        if (rawDown_ != stableDown_ && uint32_t(now - changedAt_) >= kDebounceMs) {
            stableDown_ = rawDown_;
            if (stableDown_) {
                pressedAt_ = changedAt_;
                pressArmed_ = true;
            } else {
                const bool shortPress = pressArmed_ && uint32_t(changedAt_ - pressedAt_) < kLongPressMs;
                pressArmed_ = false;
                // A simultaneous PWR interrupt stays latched until the next poll.
                if (shortPress)
                    return 1;
            }
        }
        if (pmuReady_ && uint32_t(now - lastPmuPoll_) >= kPmuPollMs) {
            lastPmuPoll_ = now;
            uint8_t status = 0;
            if (readRegister(kIrqStatus, status) && (status & kShortPress) && writeRegister(kIrqStatus, kShortPress))
                return -1;
        }
        return 0;
    }

  private:
    static constexpr uint8_t kNextPin = 18;
    static constexpr uint8_t kPmuAddress = 0x34;
    static constexpr uint8_t kIrqEnable = 0x41;
    static constexpr uint8_t kIrqStatus = 0x49;
    // Vendor XPowersParams.hpp: XPOWERS_AXP2101_PKEY_SHORT_IRQ = _BV(11).
    // Register 2 contains bits 8..15; status is write-one-to-clear.
    static constexpr uint8_t kShortPress = 0x08;
    static constexpr uint32_t kDebounceMs = 30;
    static constexpr uint32_t kLongPressMs = 800;
    static constexpr uint32_t kPmuPollMs = 50;

    static bool readRegister(uint8_t address, uint8_t& result) {
        Wire.beginTransmission(kPmuAddress);
        Wire.write(address);
        if (Wire.endTransmission(false) != 0)
            return false;
        if (Wire.requestFrom(kPmuAddress, uint8_t(1)) != 1)
            return false;
        result = static_cast<uint8_t>(Wire.read());
        return true;
    }

    static bool writeRegister(uint8_t address, uint8_t contents) {
        Wire.beginTransmission(kPmuAddress);
        Wire.write(address);
        Wire.write(contents);
        return Wire.endTransmission() == 0;
    }

    bool begun_ = false;
    bool pmuReady_ = false;
    bool rawDown_ = false;
    bool stableDown_ = false;
    bool pressArmed_ = false;
    uint32_t changedAt_ = 0;
    uint32_t pressedAt_ = 0;
    uint32_t lastPmuPoll_ = 0;
};

}  // namespace gym_fixture
