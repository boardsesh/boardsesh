// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

#ifndef CH422G_H
#define CH422G_H

#include <Arduino.h>
#include <Wire.h>

// CH422G I2C IO Expander
// Used on Waveshare ESP32-S3-Touch-LCD-7 for display reset and backlight control

// CH422G I2C addresses (7-bit, for use with Wire.beginTransmission)
#define CH422G_REG_SET  0x24   // Mode/configuration register
#define CH422G_REG_OC   0x23   // OC output (OC0-OC3, pins 8-11)
#define CH422G_REG_IO   0x38   // IO output (IO0-IO7, pins 0-7)

// EXIO pin assignments on the Waveshare 7" board (IO0-IO7 bit positions)
#define EXIO_PIN_TP_RST    1   // Touch panel reset (active low)
#define EXIO_PIN_LCD_BL    2   // LCD backlight enable (active high)
#define EXIO_PIN_LCD_RST   3   // LCD panel reset (active low)
#define EXIO_PIN_SD_CS     4   // SD card chip select
#define EXIO_PIN_USB_SEL   5   // USB mode selection

class CH422G {
  public:
    CH422G();

    // Initialize with I2C bus (must be initialized with correct SDA/SCL before calling)
    bool begin(TwoWire& wire = Wire);

    // Set output pin value (0 or 1)
    void digitalWrite(uint8_t pin, uint8_t val);

    // Set pin mode (OUTPUT only supported for EXIO pins)
    void pinMode(uint8_t pin, uint8_t mode);

    // Reset the LCD panel via EXIO pin
    void resetLCD();

    // Reset the touch panel via EXIO pin
    void resetTouch();

    // Enable/disable backlight via EXIO pin
    void setBacklight(bool on);

  private:
    TwoWire* _wire;
    uint8_t _ioState;   // Current IO pin states (IO0-IO7)
    uint8_t _ocState;   // Current OC pin states (OC0-OC3)

    void writeIO();
    void writeOC();
    void writeReg(uint8_t addr, uint8_t data);
};

#endif  // CH422G_H
