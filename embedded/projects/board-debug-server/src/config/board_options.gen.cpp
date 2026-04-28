// AUTO-GENERATED. Run scripts/generate_debug_data.ts to regenerate.
#include "board_options.h"

namespace board_debug {

static const SetOption kKilter_L_1_S_7_sets[] = {
    {1, "Bolt Ons"},
    {20, "Screw Ons"},
};
static const SetOption kKilter_L_1_S_8_sets[] = {
    {1, "Bolt Ons"},
    {20, "Screw Ons"},
};
static const SetOption kKilter_L_1_S_10_sets[] = {
    {1, "Bolt Ons"},
    {20, "Screw Ons"},
};
static const SetOption kKilter_L_1_S_14_sets[] = {
    {1, "Bolt Ons"},
    {20, "Screw Ons"},
};
static const SetOption kKilter_L_1_S_27_sets[] = {
    {1, "Bolt Ons"},
    {20, "Screw Ons"},
};
static const SetOption kKilter_L_1_S_28_sets[] = {
    {1, "Bolt Ons"},
    {20, "Screw Ons"},
};
static const SizeOption kKilter_L_1_sizes[] = {
    {7, "12 x 14", "Commerical", kKilter_L_1_S_7_sets, 2},
    {8, "8 x 12", "Home", kKilter_L_1_S_8_sets, 2},
    {10, "12 x 12 with kickboard", "Square", kKilter_L_1_S_10_sets, 2},
    {14, "7 x 10", "Small", kKilter_L_1_S_14_sets, 2},
    {27, "12 x 12 without kickboard", "Square", kKilter_L_1_S_27_sets, 2},
    {28, "16 x 12", "Super Wide", kKilter_L_1_S_28_sets, 2},
};
static const SetOption kKilter_L_8_S_17_sets[] = {
    {26, "Mainline"},
    {27, "Auxiliary"},
};
static const SetOption kKilter_L_8_S_18_sets[] = {
    {26, "Mainline"},
};
static const SetOption kKilter_L_8_S_19_sets[] = {
    {27, "Auxiliary"},
};
static const SetOption kKilter_L_8_S_21_sets[] = {
    {26, "Mainline"},
    {27, "Auxiliary"},
};
static const SetOption kKilter_L_8_S_22_sets[] = {
    {26, "Mainline"},
};
static const SetOption kKilter_L_8_S_23_sets[] = {
    {26, "Mainline"},
    {27, "Auxiliary"},
    {28, "Mainline Kickboard"},
    {29, "Auxiliary Kickboard"},
};
static const SetOption kKilter_L_8_S_24_sets[] = {
    {26, "Mainline"},
    {28, "Mainline Kickboard"},
    {29, "Auxiliary Kickboard"},
};
static const SetOption kKilter_L_8_S_25_sets[] = {
    {26, "Mainline"},
    {27, "Auxiliary"},
    {28, "Mainline Kickboard"},
    {29, "Auxiliary Kickboard"},
};
static const SetOption kKilter_L_8_S_26_sets[] = {
    {26, "Mainline"},
    {28, "Mainline Kickboard"},
    {29, "Auxiliary Kickboard"},
};
static const SetOption kKilter_L_8_S_29_sets[] = {
    {27, "Auxiliary"},
};
static const SizeOption kKilter_L_8_sizes[] = {
    {17, "7x10", "Full Ride LED Kit", kKilter_L_8_S_17_sets, 2},
    {18, "7x10", "Mainline LED Kit", kKilter_L_8_S_18_sets, 1},
    {19, "7x10", "Auxiliary LED Kit", kKilter_L_8_S_19_sets, 1},
    {21, "10x10", "Full Ride LED Kit", kKilter_L_8_S_21_sets, 2},
    {22, "10x10", "Mainline LED Kit", kKilter_L_8_S_22_sets, 1},
    {23, "8x12", "Full Ride LED Kit", kKilter_L_8_S_23_sets, 4},
    {24, "8x12", "Mainline LED Kit", kKilter_L_8_S_24_sets, 3},
    {25, "10x12", "Full Ride LED Kit", kKilter_L_8_S_25_sets, 4},
    {26, "10x12", "Mainline LED Kit", kKilter_L_8_S_26_sets, 3},
    {29, "10x10", "Auxiliary LED Kit", kKilter_L_8_S_29_sets, 1},
};
static const LayoutOption kKilter_layouts[] = {
    {1, "Kilter Board Original", kKilter_L_1_sizes, 6},
    {8, "Kilter Board Homewall", kKilter_L_8_sizes, 10},
};

static const SetOption kTension_L_9_S_1_sets[] = {
    {8, "Set A"},
    {9, "Set B"},
    {10, "Set C"},
    {11, "Foot Set"},
};
static const SetOption kTension_L_9_S_2_sets[] = {
    {8, "Set A"},
    {9, "Set B"},
    {10, "Set C"},
    {11, "Foot Set"},
};
static const SetOption kTension_L_9_S_3_sets[] = {
    {8, "Set A"},
    {9, "Set B"},
    {10, "Set C"},
    {11, "Foot Set"},
};
static const SetOption kTension_L_9_S_4_sets[] = {
    {8, "Set A"},
    {9, "Set B"},
    {10, "Set C"},
    {11, "Foot Set"},
};
static const SetOption kTension_L_9_S_5_sets[] = {
    {8, "Set A"},
    {9, "Set B"},
    {10, "Set C"},
    {11, "Foot Set"},
};
static const SizeOption kTension_L_9_sizes[] = {
    {1, "Full Wall", "Rows: KB1, KB2, 1-18 Columns: A-K", kTension_L_9_S_1_sets, 4},
    {2, "Half Kickboard", "Rows: KB2, 1-18 Columns: A-K", kTension_L_9_S_2_sets, 4},
    {3, "No Kickboard", "Rows: 1-18 Columns: A-K", kTension_L_9_S_3_sets, 4},
    {4, "Short", "Rows: 1-15 Columns: A-K", kTension_L_9_S_4_sets, 4},
    {5, "Short & Narrow", "Rows: 1-15 Columns: B.5-I.5", kTension_L_9_S_5_sets, 4},
};
static const SetOption kTension_L_10_S_6_sets[] = {
    {12, "Wood"},
    {13, "Plastic"},
};
static const SetOption kTension_L_10_S_7_sets[] = {
    {12, "Wood"},
    {13, "Plastic"},
};
static const SetOption kTension_L_10_S_8_sets[] = {
    {12, "Wood"},
    {13, "Plastic"},
};
static const SetOption kTension_L_10_S_9_sets[] = {
    {12, "Wood"},
    {13, "Plastic"},
};
static const SizeOption kTension_L_10_sizes[] = {
    {6, "12 high x 12 wide", "", kTension_L_10_S_6_sets, 2},
    {7, "10 high x 12 wide", "", kTension_L_10_S_7_sets, 2},
    {8, "12 high x 8 wide", "", kTension_L_10_S_8_sets, 2},
    {9, "10 high x 8 wide", "", kTension_L_10_S_9_sets, 2},
};
static const SetOption kTension_L_11_S_6_sets[] = {
    {12, "Wood"},
    {13, "Plastic"},
};
static const SetOption kTension_L_11_S_7_sets[] = {
    {12, "Wood"},
    {13, "Plastic"},
};
static const SetOption kTension_L_11_S_8_sets[] = {
    {12, "Wood"},
    {13, "Plastic"},
};
static const SetOption kTension_L_11_S_9_sets[] = {
    {12, "Wood"},
    {13, "Plastic"},
};
static const SizeOption kTension_L_11_sizes[] = {
    {6, "12 high x 12 wide", "", kTension_L_11_S_6_sets, 2},
    {7, "10 high x 12 wide", "", kTension_L_11_S_7_sets, 2},
    {8, "12 high x 8 wide", "", kTension_L_11_S_8_sets, 2},
    {9, "10 high x 8 wide", "", kTension_L_11_S_9_sets, 2},
};
static const LayoutOption kTension_layouts[] = {
    {9, "Original Layout", kTension_L_9_sizes, 5},
    {10, "Tension Board 2 Mirror", kTension_L_10_sizes, 4},
    {11, "Tension Board 2 Spray", kTension_L_11_sizes, 4},
};

static const SetOption kDecoy_L_2_S_1_sets[] = {
    {2, "Foundation"},
    {3, "Footholds 1"},
    {4, "Footholds 2"},
    {5, "Rollies"},
    {6, "Pacos"},
    {7, "Schist"},
    {8, "Incuts"},
    {9, "Sams"},
    {10, "Flat Edge"},
    {11, "Pinches"},
    {12, "Limestone"},
    {13, "Limestone Feet"},
    {14, "Limestone Feet 12x12"},
    {15, "Foundation 12x12"},
    {16, "Pacos 12x12"},
    {17, "Rollies 12x12"},
    {18, "Sams 12x12"},
    {19, "Schist 12x12"},
    {20, "Foundation Feet 12x12"},
};
static const SetOption kDecoy_L_2_S_2_sets[] = {
    {2, "Foundation"},
    {3, "Footholds 1"},
    {4, "Footholds 2"},
    {5, "Rollies"},
    {6, "Pacos"},
    {7, "Schist"},
    {8, "Incuts"},
    {9, "Sams"},
    {10, "Flat Edge"},
    {11, "Pinches"},
    {12, "Limestone"},
    {13, "Limestone Feet"},
};
static const SetOption kDecoy_L_2_S_3_sets[] = {
    {2, "Foundation"},
    {3, "Footholds 1"},
    {4, "Footholds 2"},
    {5, "Rollies"},
    {6, "Pacos"},
    {7, "Schist"},
    {8, "Incuts"},
    {9, "Sams"},
    {10, "Flat Edge"},
    {11, "Pinches"},
    {12, "Limestone"},
    {13, "Limestone Feet"},
};
static const SizeOption kDecoy_L_2_sizes[] = {
    {1, "12 x 12", "", kDecoy_L_2_S_1_sets, 19},
    {2, "8 x 12", "", kDecoy_L_2_S_2_sets, 12},
    {3, "8 x 10", "", kDecoy_L_2_S_3_sets, 12},
};
static const LayoutOption kDecoy_layouts[] = {
    {2, "Dungeon Trainer", kDecoy_L_2_sizes, 3},
};

static const SetOption kTouchstone_L_1_S_1_sets[] = {
    {1, "All Holds"},
};
static const SizeOption kTouchstone_L_1_sizes[] = {
    {1, "Full Size", "", kTouchstone_L_1_S_1_sets, 1},
};
static const LayoutOption kTouchstone_layouts[] = {
    {1, "Winter 2020", kTouchstone_L_1_sizes, 1},
};

static const SetOption kGrasshopper_L_1_S_1_sets[] = {
    {1, "Engage"},
    {2, "Flow"},
    {3, "Power"},
};
static const SetOption kGrasshopper_L_1_S_2_sets[] = {
    {1, "Engage"},
    {2, "Flow"},
    {3, "Power"},
};
static const SetOption kGrasshopper_L_1_S_3_sets[] = {
    {1, "Engage"},
    {2, "Flow"},
    {3, "Power"},
};
static const SetOption kGrasshopper_L_1_S_4_sets[] = {
    {1, "Engage"},
    {2, "Flow"},
    {3, "Power"},
    {4, "Gradient"},
    {5, "Dimension"},
    {6, "Tweeners"},
};
static const SetOption kGrasshopper_L_1_S_5_sets[] = {
    {1, "Engage"},
    {2, "Flow"},
    {3, "Power"},
    {4, "Gradient"},
    {6, "Tweeners"},
};
static const SetOption kGrasshopper_L_1_S_6_sets[] = {
    {1, "Engage"},
    {2, "Flow"},
    {3, "Power"},
    {4, "Gradient"},
    {6, "Tweeners"},
};
static const SizeOption kGrasshopper_L_1_sizes[] = {
    {1, "GrandMaster", "12 x 12", kGrasshopper_L_1_S_1_sets, 3},
    {2, "Master", "8 x 12", kGrasshopper_L_1_S_2_sets, 3},
    {3, "Ninja", "8 x 10", kGrasshopper_L_1_S_3_sets, 3},
    {4, "GrandMaster", "12 x 12 with Tweeners", kGrasshopper_L_1_S_4_sets, 6},
    {5, "Master", "8 x 12 with Tweeners", kGrasshopper_L_1_S_5_sets, 5},
    {6, "Ninja", "8 x 10 with Tweeners", kGrasshopper_L_1_S_6_sets, 5},
};
static const LayoutOption kGrasshopper_layouts[] = {
    {1, "Grasshopper 2020", kGrasshopper_L_1_sizes, 6},
};

static const SetOption kMoonboard_L_1_S_1_sets[] = {
    {1, "Original School Holds"},
};
static const SizeOption kMoonboard_L_1_sizes[] = {
    {1, "Standard", "11x18 Grid", kMoonboard_L_1_S_1_sets, 1},
};
static const SetOption kMoonboard_L_2_S_1_sets[] = {
    {2, "Hold Set A"},
    {3, "Hold Set B"},
    {4, "Original School Holds"},
};
static const SizeOption kMoonboard_L_2_sizes[] = {
    {1, "Standard", "11x18 Grid", kMoonboard_L_2_S_1_sets, 3},
};
static const SetOption kMoonboard_L_3_S_1_sets[] = {
    {5, "Hold Set D"},
    {6, "Hold Set E"},
    {7, "Hold Set F"},
    {8, "Wooden Holds"},
    {9, "Wooden Holds B"},
    {10, "Wooden Holds C"},
};
static const SizeOption kMoonboard_L_3_sizes[] = {
    {1, "Standard", "11x18 Grid", kMoonboard_L_3_S_1_sets, 6},
};
static const SetOption kMoonboard_L_4_S_1_sets[] = {
    {11, "Hold Set A"},
    {12, "Hold Set B"},
    {13, "Hold Set C"},
    {14, "Original School Holds"},
    {15, "Screw-on Feet"},
    {16, "Wooden Holds"},
};
static const SizeOption kMoonboard_L_4_sizes[] = {
    {1, "Standard", "11x18 Grid", kMoonboard_L_4_S_1_sets, 6},
};
static const SetOption kMoonboard_L_5_S_1_sets[] = {
    {17, "Hold Set A"},
    {18, "Hold Set B"},
    {19, "Original School Holds"},
    {20, "Screw-on Feet"},
    {21, "Wooden Holds"},
    {22, "Wooden Holds B"},
    {23, "Wooden Holds C"},
};
static const SizeOption kMoonboard_L_5_sizes[] = {
    {1, "Standard", "11x18 Grid", kMoonboard_L_5_S_1_sets, 7},
};
static const LayoutOption kMoonboard_layouts[] = {
    {1, "MoonBoard 2010", kMoonboard_L_1_sizes, 1},
    {2, "MoonBoard 2016", kMoonboard_L_2_sizes, 1},
    {3, "MoonBoard 2024", kMoonboard_L_3_sizes, 1},
    {4, "MoonBoard Masters 2017", kMoonboard_L_4_sizes, 1},
    {5, "MoonBoard Masters 2019", kMoonboard_L_5_sizes, 1},
};

const BoardCatalogEntry kBoardCatalog[] = {
    {BoardName::KILTER, "kilter", kKilter_layouts, 2},
    {BoardName::TENSION, "tension", kTension_layouts, 3},
    {BoardName::DECOY, "decoy", kDecoy_layouts, 1},
    {BoardName::TOUCHSTONE, "touchstone", kTouchstone_layouts, 1},
    {BoardName::GRASSHOPPER, "grasshopper", kGrasshopper_layouts, 1},
    {BoardName::MOONBOARD, "moonboard", kMoonboard_layouts, 5},
};
const size_t kBoardCatalogCount = sizeof(kBoardCatalog) / sizeof(kBoardCatalog[0]);

}  // namespace board_debug
