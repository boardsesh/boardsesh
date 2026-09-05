// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

#include "ch422g.h"

CH422G::CH422G() : _wire(nullptr), _ioState(0), _ocState(0) {}

bool CH422G::begin(TwoWire& wire) {
    _wire = &wire;

    // Configure mode: IO0-7 as push-pull outputs (bit 0 = 1)
    writeReg(CH422G_REG_SET, 0x01);

    // Set all IO pins HIGH initially (TP_RST, LCD_BL, LCD_RST all released)
    _ioState = 0xFF;
    writeIO();

    // Set OC pins HIGH
    _ocState = 0x0F;
    writeOC();

    return true;
}

void CH422G::digitalWrite(uint8_t pin, uint8_t val) {
    if (val) {
        _ioState |= (1 << pin);
    } else {
        _ioState &= ~(1 << pin);
    }
    writeIO();
}

void CH422G::pinMode(uint8_t pin, uint8_t mode) {
    // CH422G EXIO pins are always output in push-pull mode
    (void)pin;
    (void)mode;
}

void CH422G::resetLCD() {
    // Pull LCD reset low
    digitalWrite(EXIO_PIN_LCD_RST, 0);
    delay(20);
    // Release LCD reset
    digitalWrite(EXIO_PIN_LCD_RST, 1);
    delay(150);
}

void CH422G::resetTouch() {
    // Pull touch reset low
    digitalWrite(EXIO_PIN_TP_RST, 0);
    delay(20);
    // Release touch reset
    digitalWrite(EXIO_PIN_TP_RST, 1);
    delay(50);
}

void CH422G::setBacklight(bool on) {
    digitalWrite(EXIO_PIN_LCD_BL, on ? 1 : 0);
}

void CH422G::writeIO() {
    writeReg(CH422G_REG_IO, _ioState);
}

void CH422G::writeOC() {
    writeReg(CH422G_REG_OC, _ocState);
}

void CH422G::writeReg(uint8_t addr, uint8_t data) {
    if (!_wire) return;

    _wire->beginTransmission(addr);
    _wire->write(data);
    _wire->endTransmission();
}
