"""Whether the business is open right now, so the follow-up promise fits the time of the call.

Tom (2026-10-05): on a Sunday Blake promised a callback "within the next 30 minutes to an hour" for a business that is
closed on weekends. When the business is closed, or will close within the window being promised, the caller hears "by
the next business day" instead.
"""
from __future__ import annotations

import re
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

# The business's own time zone is not stored yet; every business prepared so far is in California.
TIME_ZONE = ZoneInfo('America/Los_Angeles')
# Used when the website lists no hours: weekdays, 8am to 5pm.
WEEKDAY_HOURS = {day: [(8 * 60, 17 * 60)] for day in range(5)}

_DAYS = ('mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun')
_DAY = r"(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?"
_CLOCK = r"(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?"
_SPAN = re.compile(rf"\b{_DAY}(?:\s*(?:-|–|to|through|thru)\s*{_DAY})?\s*[:,-]?\s*{_CLOCK}\s*(?:-|–|to)\s*{_CLOCK}", re.I)
_ALWAYS_OPEN = re.compile(r"\b24\s*/\s*7\b|\b24 hours\b|\bopen 24\b", re.I)


def _minute(hour: str, minute: str | None, half: str) -> int:
    return (int(hour) % 12 + (12 if half.lower() == 'p' else 0)) * 60 + int(minute or 0)


def opening_hours(label: str) -> dict[int, list[tuple[int, int]]] | None:
    """Opening times by weekday (Monday is 0) from a label such as "Monday - Friday: 8am - 5pm; Sat 9am-1pm", in
    minutes after midnight, or None when the label has no day with times."""
    hours: dict[int, list[tuple[int, int]]] = {}
    for match in _SPAN.finditer(label or ''):
        first = _DAYS.index(match.group(1).lower()[:3])
        last = _DAYS.index((match.group(2) or match.group(1)).lower()[:3])
        days = range(first, last + 1) if first <= last else [*range(first, 7), *range(0, last + 1)]
        span = (_minute(*match.group(3, 4, 5)), _minute(*match.group(6, 7, 8)))
        for day in days:
            hours.setdefault(day, []).append(span)
    return hours or None


def _label(bundle: dict) -> str:
    hours = (bundle.get('profile') or {}).get('hours')
    return str(hours.get('label') or '') if isinstance(hours, dict) else str(hours or '')


def open_for(bundle: dict, minutes: int = 0, now: datetime | None = None) -> bool:
    """True when the business is open now and still open `minutes` from now, by its published hours, or by weekday
    business hours when it lists none."""
    label = _label(bundle)
    if _ALWAYS_OPEN.search(label):
        return True
    hours = opening_hours(label) or WEEKDAY_HOURS
    now = (now or datetime.now(TIME_ZONE)).astimezone(TIME_ZONE)
    later = now + timedelta(minutes=minutes)
    if later.date() != now.date():
        return False
    start, end = now.hour * 60 + now.minute, later.hour * 60 + later.minute
    return any(opens <= start and end <= closes for opens, closes in hours.get(now.weekday(), []))
