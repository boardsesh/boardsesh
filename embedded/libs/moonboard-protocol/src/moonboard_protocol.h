// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

#ifndef MOONBOARD_PROTOCOL_H
#define MOONBOARD_PROTOCOL_H

#include <Arduino.h>

#include <led_controller.h>
#include <vector>

// Frames role codes aligned with Boardsesh MoonBoard rendering
#define MOONBOARD_ROLE_START 42
#define MOONBOARD_ROLE_HAND 43
#define MOONBOARD_ROLE_FINISH 44
#define MOONBOARD_ROLE_FOOT 45
#define MOONBOARD_ROLE_AUX 46
#define MOONBOARD_ROLE_LEFT 47
#define MOONBOARD_ROLE_MATCH 48

struct MoonBoardParsedHold {
    uint16_t serialPosition;
    uint16_t holdId;
    uint16_t ledIndex;
    char token;
    uint8_t roleCode;
    bool hasAuxMarker;
};

struct MoonBoardDecodedProblem {
    std::vector<LedCommand> ledCommands;
    std::vector<MoonBoardParsedHold> holds;
    String frames;
    String rawPayload;
    String problemPayload;
    bool lightsAboveHolds;
};

class MoonBoardProtocol {
  public:
    MoonBoardProtocol();

    // Add incoming BLE data to the parser buffer.
    // Returns true when a full MoonBoard payload has been decoded.
    bool addData(const uint8_t* data, size_t length);

    // Legacy helper matching AuroraProtocol's interface.
    bool processPacket(const uint8_t* data, size_t length);

    void clear();
    void setDebug(bool enabled);

    const std::vector<LedCommand>& getLedCommands() const;
    const MoonBoardDecodedProblem& getDecodedProblem() const;
    const String& getFrames() const;
    const String& getRawPayload() const;
    const String& getProblemPayload() const;
    bool getLightsAboveHolds() const;

    static int serialPositionToHoldId(int serialPosition);
    static int holdIdToSerialPosition(int holdId);

  private:
    enum ParserState {
        PARSER_IDLE,
        PARSER_CONFIG,
        PARSER_WAIT_FOR_PAYLOAD_START,
        PARSER_READING_PAYLOAD,
    };

    ParserState parserState;
    bool pendingLightsAboveHolds;
    bool debugEnabled;
    String rawPayloadBuffer;
    String problemPayloadBuffer;
    MoonBoardDecodedProblem decodedProblem;

    void resetParser();
    bool finalizePayload();
    bool decodeProblem(const String& payload, bool lightsAboveHolds);

    static uint8_t tokenToRoleCode(char token);
    static void tokenToColor(char token, uint8_t& r, uint8_t& g, uint8_t& b);
};

extern MoonBoardProtocol MoonBoard;

#endif
