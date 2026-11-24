import struct
import unittest
from datetime import datetime, timezone

from audit_reporting_tzdata import analyze_tzif


def tzif(transitions=(), offsets=(0,), footer="UTC0", version=b"2"):
    """Minimal TZif v2+ with identical 32- and 64-bit data blocks."""
    names = b"STD\0DST\0"
    header = struct.pack(">4sc15x6I", b"TZif", version, 0, 0, 0, len(transitions), len(offsets), len(names))

    def block(epoch_width):
        return (header
                + b"".join(struct.pack(epoch_width, stamp) for stamp, _ in transitions)
                + bytes(index for _, index in transitions)
                + b"".join(struct.pack(">iBB", offset, index > 0, 4 * index)
                           for index, offset in enumerate(offsets))
                + names)

    return block(">i") + block(">q") + b"\n" + footer.encode() + b"\n"


class TimezoneArtifactAuditTest(unittest.TestCase):
    def test_ordinary_fixed_and_recurring_rules_pass(self):
        self.assertEqual(analyze_tzif(tzif()), (None, None, 0, b"UTC0"))
        spacing, seam, max_offset, _ = analyze_tzif(tzif(
            offsets=(0, 3600), footer="STD0DST,M3.2.0,M11.1.0",
        ))
        self.assertGreater(spacing, 3600)
        self.assertIsNone(seam)
        self.assertEqual(max_offset, 3600)

    def test_overlapping_explicit_and_generated_changes_fail(self):
        self.assertRaisesRegex(ValueError, "too close", analyze_tzif,
                               tzif(((10_000, 1), (10_900, 0)), (0, 3600)))
        self.assertRaisesRegex(ValueError, "too close", analyze_tzif,
                               tzif(offsets=(0, 3600), footer="STD0DST,M3.1.0/2,M3.1.0/3"))

    def test_discontinuous_fixed_and_recurring_footers_fail(self):
        self.assertRaisesRegex(ValueError, "fixed footer is discontinuous", analyze_tzif,
                               tzif(((10_000, 1),), (0, 3600)))
        self.assertRaisesRegex(ValueError, "recurring footer is discontinuous", analyze_tzif,
                               tzif(((10_000, 1),), (0, 3600), "STD0DST,M3.2.0,M11.1.0"))

    def test_recurrence_seam_rejects_a_too_close_first_tail_change(self):
        first_spring_shift = int(datetime(2024, 3, 10, 2, tzinfo=timezone.utc).timestamp())
        self.assertRaisesRegex(ValueError, "too close", analyze_tzif,
                               tzif(((first_spring_shift - 900, 0),), (0, 3600),
                                    "STD0DST,M3.2.0,M11.1.0"))

    def test_bad_offset_and_unsupported_artifact_fail(self):
        self.assertRaisesRegex(ValueError, "outside the UTC envelope", analyze_tzif,
                               tzif(offsets=(0, -36 * 3600)))
        self.assertRaises(ValueError, analyze_tzif, b"not a timezone file")

    def test_posix_footer_validation_does_not_depend_on_python_parser_leniency(self):
        for footer in ("bad#rule", "BAD#RULE0", "UTC", "U0", "STD0DST,M3.2X0,M11.1.0",
                       "STD0DST,M3.2.0/2:60,M11.1.0"):
            with self.subTest(footer=footer):
                self.assertRaisesRegex(ValueError, "not a valid TZ string", analyze_tzif, tzif(footer=footer))

    def test_quoted_abbreviations_and_extended_transition_times_pass(self):
        self.assertEqual(analyze_tzif(tzif(offsets=(20700,), footer="<+0545>-5:45")),
                         (None, None, 20700, b"<+0545>-5:45"))
        spacing, seam, max_offset, _ = analyze_tzif(tzif(
            offsets=(0, -3600), footer="STD0DST1,M3.2.0/-1,M11.1.0/26", version=b"3",
        ))
        self.assertGreater(spacing, 3600)
        self.assertIsNone(seam)
        self.assertEqual(max_offset, 3600)


if __name__ == "__main__":
    unittest.main()
