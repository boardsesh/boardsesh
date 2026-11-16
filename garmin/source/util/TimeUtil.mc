using Toybox.Time;
using Toybox.Time.Gregorian;
using Toybox.Lang;

module TimeUtil {

    // Unsigned elapsed milliseconds across the signed uptime rollover.
    // Supports intervals shorter than one full counter period (~50 days).
    function elapsedTimerMs(startMs as Lang.Number, nowMs as Lang.Number) as Lang.Long {
        return (nowMs.toLong() - startMs.toLong()) & 0xffffffffl;
    }

    // Current UTC time as an ISO-8601 string, e.g. "2026-07-05T14:03:09Z".
    //
    // Gregorian.utcInfo with FORMAT_SHORT yields numeric fields. The backend
    // expects an ISO-8601 instant for SaveTickInput.climbedAt.
    function nowIso() as Lang.String {
        var info = Gregorian.utcInfo(Time.now(), Time.FORMAT_SHORT);
        return Lang.format("$1$-$2$-$3$T$4$:$5$:$6$Z", [
            info.year.format("%04d"),
            info.month.format("%02d"),
            info.day.format("%02d"),
            info.hour.format("%02d"),
            info.min.format("%02d"),
            info.sec.format("%02d")
        ]);
    }

    // Epoch seconds (Long) for exactly the form nowIso() writes
    // ("2026-07-05T14:03:09Z"), or null for anything else, including impossible
    // dates. Pure arithmetic: Gregorian.moment raises an uncatchable VM error
    // ("Invalid Value") for a date such as 31 February.
    function parseIsoUtc(text) {
        if (!(text instanceof Lang.String) || text.length() != 20 ||
                !text.substring(4, 5).equals("-") || !text.substring(7, 8).equals("-") ||
                !text.substring(10, 11).equals("T") || !text.substring(13, 14).equals(":") ||
                !text.substring(16, 17).equals(":") || !text.substring(19, 20).equals("Z")) {
            return null;
        }
        var year = _digits(text, 0, 4);
        var month = _digits(text, 5, 7);
        var day = _digits(text, 8, 10);
        var hour = _digits(text, 11, 13);
        var minute = _digits(text, 14, 16);
        var second = _digits(text, 17, 19);
        if (year == null || month == null || day == null || hour == null || minute == null || second == null ||
                year < 1970 || year > 2100 || month < 1 || month > 12 || day < 1 ||
                day > _daysInMonth(year, month) || hour > 23 || minute > 59 || second > 59) {
            return null;
        }
        return _daysFromCivil(year, month, day).toLong() * 86400l + hour * 3600 + minute * 60 + second;
    }

    function _daysInMonth(year as Lang.Number, month as Lang.Number) as Lang.Number {
        if (month == 2) { return (year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)) ? 29 : 28; }
        return (month == 4 || month == 6 || month == 9 || month == 11) ? 30 : 31;
    }

    // Days since 1970-01-01 for a proleptic Gregorian date in 1970..2100
    // (H. Hinnant's days_from_civil, non-negative years only).
    function _daysFromCivil(year as Lang.Number, month as Lang.Number, day as Lang.Number) as Lang.Number {
        var marchYear = month <= 2 ? year - 1 : year;
        var era = marchYear / 400;
        var yearOfEra = marchYear - era * 400;
        var monthFromMarch = month > 2 ? month - 3 : month + 9;
        var dayOfYear = (153 * monthFromMarch + 2) / 5 + day - 1;
        var dayOfEra = yearOfEra * 365 + yearOfEra / 4 - yearOfEra / 100 + dayOfYear;
        return era * 146097 + dayOfEra - 719468;
    }

    function _digits(text as Lang.String, start as Lang.Number, end as Lang.Number) {
        var chars = text.substring(start, end).toCharArray();
        var value = 0;
        for (var index = 0; index < chars.size(); index += 1) {
            var code = chars[index].toNumber();
            if (code < 48 || code > 57) { return null; }
            value = value * 10 + (code - 48);
        }
        return value;
    }
}
