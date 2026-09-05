// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

/**
 * Unit tests for MoonBoard protocol parsing and frames generation.
 */

#include <moonboard_protocol.h>
#include <unity.h>

static MoonBoardProtocol* protocol;

void setUp(void) {
    protocol = new MoonBoardProtocol();
}

void tearDown(void) {
    delete protocol;
    protocol = nullptr;
}

void test_initial_state_is_empty(void) {
    TEST_ASSERT_EQUAL(0, protocol->getLedCommands().size());
    TEST_ASSERT_EQUAL_STRING("", protocol->getFrames().c_str());
    TEST_ASSERT_FALSE(protocol->getLightsAboveHolds());
}

void test_hold_id_to_serial_position_matches_expected_serpentine_order(void) {
    TEST_ASSERT_EQUAL(0, MoonBoardProtocol::holdIdToSerialPosition(1));
    TEST_ASSERT_EQUAL(17, MoonBoardProtocol::holdIdToSerialPosition(188));
    TEST_ASSERT_EQUAL(35, MoonBoardProtocol::holdIdToSerialPosition(2));
    TEST_ASSERT_EQUAL(197, MoonBoardProtocol::holdIdToSerialPosition(198));
}

void test_serial_position_to_hold_id_matches_expected_serpentine_order(void) {
    TEST_ASSERT_EQUAL(1, MoonBoardProtocol::serialPositionToHoldId(0));
    TEST_ASSERT_EQUAL(188, MoonBoardProtocol::serialPositionToHoldId(17));
    TEST_ASSERT_EQUAL(2, MoonBoardProtocol::serialPositionToHoldId(35));
    TEST_ASSERT_EQUAL(198, MoonBoardProtocol::serialPositionToHoldId(197));
    TEST_ASSERT_EQUAL(-1, MoonBoardProtocol::serialPositionToHoldId(198));
}

void test_parse_simple_problem_payload(void) {
    const char payload[] = "l#S0,P35,E197#";
    const bool complete = protocol->addData(reinterpret_cast<const uint8_t*>(payload), strlen(payload));

    TEST_ASSERT_TRUE(complete);
    TEST_ASSERT_EQUAL_STRING("p1r42p2r43p198r44", protocol->getFrames().c_str());
    TEST_ASSERT_EQUAL(3, protocol->getDecodedProblem().holds.size());
    TEST_ASSERT_EQUAL(3, protocol->getLedCommands().size());
    TEST_ASSERT_FALSE(protocol->getLightsAboveHolds());
}

void test_parse_chunked_payload(void) {
    const char chunk1[] = "l#S0,P";
    const char chunk2[] = "35,E197#";

    TEST_ASSERT_FALSE(protocol->addData(reinterpret_cast<const uint8_t*>(chunk1), strlen(chunk1)));
    TEST_ASSERT_TRUE(protocol->addData(reinterpret_cast<const uint8_t*>(chunk2), strlen(chunk2)));
    TEST_ASSERT_EQUAL_STRING("p1r42p2r43p198r44", protocol->getFrames().c_str());
}

void test_parse_chunked_payload_with_split_frame_delimiter(void) {
    const char chunk1[] = "l";
    const char chunk2[] = "#S0,P35,E197#";

    TEST_ASSERT_FALSE(protocol->addData(reinterpret_cast<const uint8_t*>(chunk1), strlen(chunk1)));
    TEST_ASSERT_TRUE(protocol->addData(reinterpret_cast<const uint8_t*>(chunk2), strlen(chunk2)));
    TEST_ASSERT_EQUAL_STRING("p1r42p2r43p198r44", protocol->getFrames().c_str());
}

void test_parse_payload_with_aux_markers(void) {
    const char payload[] = "~Dl#S0,R35,F19,E197#";
    const bool complete = protocol->addData(reinterpret_cast<const uint8_t*>(payload), strlen(payload));

    TEST_ASSERT_TRUE(complete);
    TEST_ASSERT_TRUE(protocol->getLightsAboveHolds());
    TEST_ASSERT_EQUAL_STRING("~Dl#S0,R35,F19,E197#", protocol->getRawPayload().c_str());
    TEST_ASSERT_EQUAL_STRING("S0,R35,F19,E197", protocol->getProblemPayload().c_str());
    TEST_ASSERT_EQUAL_STRING("p1r42p2r43p178r45p178r46p198r44", protocol->getFrames().c_str());
    TEST_ASSERT_EQUAL(4, protocol->getDecodedProblem().holds.size());
    TEST_ASSERT_FALSE(protocol->getDecodedProblem().holds[0].hasAuxMarker);
    TEST_ASSERT_FALSE(protocol->getDecodedProblem().holds[1].hasAuxMarker);
    TEST_ASSERT_TRUE(protocol->getDecodedProblem().holds[2].hasAuxMarker);
    TEST_ASSERT_FALSE(protocol->getDecodedProblem().holds[3].hasAuxMarker);
    TEST_ASSERT_EQUAL(5, protocol->getLedCommands().size());
}

void test_left_match_and_foot_roles_use_distinct_codes(void) {
    const char payload[] = "l#L35,M19,F18#";
    const bool complete = protocol->addData(reinterpret_cast<const uint8_t*>(payload), strlen(payload));

    TEST_ASSERT_TRUE(complete);
    TEST_ASSERT_EQUAL_STRING("p2r47p178r48p189r45", protocol->getFrames().c_str());
}

void test_empty_payload_clears_frames(void) {
    const char firstPayload[] = "l#S0,E197#";
    const char clearPayload[] = "l##";

    TEST_ASSERT_TRUE(protocol->addData(reinterpret_cast<const uint8_t*>(firstPayload), strlen(firstPayload)));
    TEST_ASSERT_EQUAL_STRING("p1r42p198r44", protocol->getFrames().c_str());

    TEST_ASSERT_TRUE(protocol->addData(reinterpret_cast<const uint8_t*>(clearPayload), strlen(clearPayload)));
    TEST_ASSERT_EQUAL_STRING("", protocol->getFrames().c_str());
    TEST_ASSERT_EQUAL(0, protocol->getLedCommands().size());
}

void test_unknown_tokens_and_out_of_range_positions_are_skipped(void) {
    const char payload[] = "l#X10,S999,E197#";
    const bool complete = protocol->addData(reinterpret_cast<const uint8_t*>(payload), strlen(payload));

    TEST_ASSERT_TRUE(complete);
    TEST_ASSERT_EQUAL_STRING("p198r44", protocol->getFrames().c_str());
    TEST_ASSERT_EQUAL(1, protocol->getLedCommands().size());
}

void test_clear_resets_protocol_state(void) {
    const char payload[] = "l#S0,E197#";
    TEST_ASSERT_TRUE(protocol->addData(reinterpret_cast<const uint8_t*>(payload), strlen(payload)));

    protocol->clear();

    TEST_ASSERT_EQUAL_STRING("", protocol->getFrames().c_str());
    TEST_ASSERT_EQUAL_STRING("", protocol->getRawPayload().c_str());
    TEST_ASSERT_EQUAL(0, protocol->getLedCommands().size());
    TEST_ASSERT_FALSE(protocol->getLightsAboveHolds());
}

int main(int argc, char** argv) {
    UNITY_BEGIN();

    RUN_TEST(test_initial_state_is_empty);
    RUN_TEST(test_hold_id_to_serial_position_matches_expected_serpentine_order);
    RUN_TEST(test_serial_position_to_hold_id_matches_expected_serpentine_order);
    RUN_TEST(test_parse_simple_problem_payload);
    RUN_TEST(test_parse_chunked_payload);
    RUN_TEST(test_parse_chunked_payload_with_split_frame_delimiter);
    RUN_TEST(test_parse_payload_with_aux_markers);
    RUN_TEST(test_left_match_and_foot_roles_use_distinct_codes);
    RUN_TEST(test_empty_payload_clears_frames);
    RUN_TEST(test_unknown_tokens_and_out_of_range_positions_are_skipped);
    RUN_TEST(test_clear_resets_protocol_state);

    return UNITY_END();
}
