"""Name spelling tests: a spelling the caller gives, even split across turns, goes into their name whole."""
from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))

from intake import ServiceRequestTask, asks_something, spelled_turn, spelling_line, with_country_code
from test_conversation import Context, FakeFlow, task

CONTACT = {"serviceNeed": "Pressure washing", "callerName": "Sarah Blakely", "contactPhone": "(562) 867-0990", "phoneConfirmed": True}


class SplitSpelling(unittest.IsolatedAsyncioTestCase):
    def test_letters_split_across_two_turns_are_one_spelling(self):
        # Magnus's call, 2026-10-06: he paused between "B L A K" and "E L Y", and Blake read back only "E-L-Y".
        self.assertEqual(spelled_turn(["Uh, B L A K", "E L Y"]), "B L A K E L Y")
        self.assertIn("B-L-A-K-E-L-Y", spelling_line(spelled_turn(["Uh, B L A K", "E L Y"])))
        self.assertEqual(spelled_turn(["My name is Sarah.", "E L Y"]), "E L Y")
        self.assertEqual(spelled_turn(["Let me spell the last name. B L A K", "E L Y"]), "B L A K E L Y")
        self.assertEqual(spelled_turn(["B L A K", "Yes."]), "Yes.")

    async def test_the_name_gets_the_whole_spelling(self):
        held = {**CONTACT, "callerName": "Sarah Blak"}
        flow = FakeFlow({"accepted": {"callerName": "Sarah Blakely"}, "rejected": {}, "task": task(fields=CONTACT)})
        flow.caller_texts = ["Uh, B L A K", "E L Y"]
        intake = ServiceRequestTask(flow, task(fields=held), None)
        intake.told_next_step = True
        await intake.record_details(Context(), name="Sarah Blak")
        self.assertEqual(flow.records[-1]["callerName"], "Sarah Blakely")

    async def test_letters_sent_as_the_name_keep_the_whole_name(self):
        spelled = {**CONTACT, "callerName": "Bao Tran"}
        flow = FakeFlow({"accepted": {}, "rejected": {}, "task": task(fields=spelled)})
        flow.caller_texts = ["T-R-A-N.", "Yes."]
        intake = ServiceRequestTask(flow, task(fields=spelled), None)
        intake.told_next_step = True
        await intake.record_details(Context(), name="T R A N")
        self.assertEqual(intake.fields["callerName"], "Bao Tran")


class CountryCode(unittest.TestCase):
    def test_a_leading_one_the_caller_said_is_read_back(self):
        # Tom's 2026-10-06 call: "One five six. Two. Eight six seven." then "Zero nine nine zero.", read back without the one.
        line = 'Next: read the number back as "five six two, eight six seven, oh nine nine oh" and ask if that\'s right.'
        said = ["Uh, name is Sarah Blakely. Phone number is One five six. Two. Eight six seven.", "Zero nine nine zero."]
        self.assertIn('"one, five six two, eight six seven, oh nine nine oh"', with_country_code(line, said, "(562) 867-0990"))
        self.assertEqual(with_country_code(line, ["Five six two, eight six seven, zero nine nine zero."], "(562) 867-0990"), line)


class CallerQuestions(unittest.TestCase):
    def test_a_request_without_a_question_mark_counts_as_a_question(self):
        # Tom's 2026-10-06 call: this got the address question with no answer.
        for text in ("Uh, we're just looking to get an estimate over the phone if we can.", "Is it possible to come Monday",
                     "How much is it", "Do you do awnings?"):
            self.assertTrue(asks_something(text), text)
        for text in ("Yes.", "My name is Fred.", "Will do.", "Any time tomorrow works.", "Two two two South Long Beach Boulevard."):
            self.assertFalse(asks_something(text), text)


if __name__ == '__main__':
    unittest.main()
