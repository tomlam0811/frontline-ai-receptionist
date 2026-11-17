"""Business hours tests: when the business is open decides the follow-up promise. No provider or network calls."""
from __future__ import annotations

import os
import sys
import unittest
from datetime import datetime

sys.path.insert(0, os.path.dirname(__file__))

from business_hours import TIME_ZONE, open_for, opening_hours
from conversation import result_line
from speech import follow_up_line
from test_conversation import task, uid

A1 = {'profile': {'hours': {'label': 'Monday - Friday: 8am - 5pm'}}}


def at(day: int, hour: int, minute: int = 0) -> datetime:
    """A time in the business's zone during the week of Monday 2026-10-05."""
    return datetime(2026, 10, 5 + day, hour, minute, tzinfo=TIME_ZONE)


class OpeningHours(unittest.TestCase):
    def test_reads_day_ranges_and_single_days(self):
        hours = opening_hours('Monday - Friday: 8am - 5pm; Sat 9:30am-1pm')
        self.assertEqual(hours[0], [(480, 1020)])
        self.assertEqual(hours[4], [(480, 1020)])
        self.assertEqual(hours[5], [(570, 780)])
        self.assertNotIn(6, hours)
        self.assertEqual(opening_hours('Mon to Thu 7 a.m. to 6 p.m.')[3], [(420, 1080)])

    def test_a_label_without_times_has_no_hours(self):
        self.assertIsNone(opening_hours('Saturday: By Appointment Only'))
        self.assertIsNone(opening_hours(''))


class OpenFor(unittest.TestCase):
    def test_published_hours(self):
        self.assertTrue(open_for(A1, now=at(0, 10)))
        self.assertFalse(open_for(A1, now=at(6, 10)))  # Sunday
        self.assertFalse(open_for(A1, now=at(0, 7, 30)))
        self.assertFalse(open_for(A1, now=at(0, 17, 30)))

    def test_an_urgent_window_needs_the_next_hour_open(self):
        self.assertTrue(open_for(A1, 60, now=at(0, 15, 30)))
        self.assertFalse(open_for(A1, 60, now=at(0, 16, 30)))

    def test_unknown_hours_mean_weekdays_eight_to_five(self):
        for bundle in ({}, {'profile': {'hours': None}}, {'profile': {'hours': {'label': 'By appointment'}}}):
            self.assertTrue(open_for(bundle, now=at(2, 9)))
            self.assertFalse(open_for(bundle, now=at(5, 11)))  # Saturday

    def test_always_open(self):
        self.assertTrue(open_for({'profile': {'hours': {'label': 'Open 24/7 for emergencies'}}}, 60, now=at(6, 23, 30)))


class ClosedFollowUp(unittest.TestCase):
    def test_a_closed_business_promises_the_next_business_day(self):
        # Tom, 2026-10-05: on a weekend Blake can't know anyone is in, so the caller hears the next business day.
        saved = task(status="succeeded", fields={"contactPhone": "4085550100"}, receipt={"operationId": uid(20)})
        line = result_line("service_request", saved, None, "A-1 Heating and Cooling", open_now=False, open_an_hour=False)
        self.assertIn("by the next business day", line)
        self.assertNotIn("within one business day", line)
        urgent = task(status="succeeded", fields={"contactPhone": "4085550100", "notes": "Wants it done as soon as possible."},
                      receipt={"operationId": uid(20)})
        line = result_line("service_request", urgent, None, "A-1 Heating and Cooling", open_now=False, open_an_hour=False)
        self.assertIn("as soon as they can, by the next business day at the latest", line)
        self.assertNotIn("30 minutes", line)
        # Open now but closing within the hour: urgent still gets no 30-minute promise.
        line = result_line("service_request", urgent, None, "A-1 Heating and Cooling", open_now=True, open_an_hour=False)
        self.assertNotIn("30 minutes", line)

    def test_the_owner_demo_line_follows_the_same_hours(self):
        self.assertEqual(follow_up_line("A-1 Heating and Cooling", {"contactPhone": "1"}, open_now=False, open_an_hour=False),
                         "Someone from A-1 Heating and Cooling will follow up by phone by the next business day.")


if __name__ == '__main__':
    unittest.main()
