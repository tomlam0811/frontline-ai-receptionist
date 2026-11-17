"""Voice v2 code paths without paid providers: status lines, intake records, the save guard and CallFlow writes."""
import asyncio
import inspect
import json
import os
import re
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

sys.path.insert(0, os.path.dirname(__file__))

import conversation
import intake as intake_module
import prompts
from conversation import CallFlow, FrontDesk, guarded_reply, result_line
from intake import (ADDRESS_STEP, AVAILABILITY_STEP, was_said, AppointmentTask, ComplaintTask, ServiceRequestTask, calling_for_someone, confirms_number, joined_phone, without_segment_repeat, combined_attempts, house_number_as_digits,
                    next_step, note_parts, notes_text, number_was_said, said_digits, service_area_state, spoken_phone, state_was_said,
                    status_line)
from livekit.agents import Agent, ToolResult
from runtime import RuntimeContractError, RuntimeHttpError
from test_voice import FakeSession, uid

BUNDLE = {"mode": "business_demo", "businessName": "Example Valley Cleaning", "workflowRevision": 1, "stateRevision": 1}


class Context:
    """RunContext with a speech handle whose interruption setting is kept as a history."""
    def __init__(self):
        self.history = []
        context = self
        class Handle:
            @property
            def allow_interruptions(self): return context.history[-1] if context.history else True
            @allow_interruptions.setter
            def allow_interruptions(self, value): context.history.append(value)
        self.speech_handle = Handle()
    def disallow_interruptions(self): self.speech_handle.allow_interruptions = False


def task(kind="service_request", status="running", fields=None, **extra):
    return {"taskId": uid(10), "kind": kind, "status": status, "fields": fields or {}, **extra}


class FakeFlow:
    """The CallFlow surface an intake task uses, with backend answers scripted per call."""

    def __init__(self, *responses, finish=None, state=None):
        self.bundle = BUNDLE
        self.responses, self.finish_response, self.state = list(responses), finish, state
        self.records, self.finished, self.cancelled = [], 0, 0
        self.caller_texts = []
        self.asked_for_owner = False
        self.spelling = ''
        self.replies = []

    def take_spelling(self):
        spelled, self.spelling = self.spelling, ''
        return spelled

    async def service_area_state(self):
        return self.state

    async def record(self, fields):
        self.records.append(fields)
        result = self.responses.pop(0)
        if isinstance(result, Exception): raise result
        return result

    async def finish(self):
        self.finished += 1
        return self.finish_response

    async def cancel(self):
        self.cancelled += 1


class StatusLines(unittest.TestCase):
    def test_next_step_follows_the_service_request_checklist(self):
        self.assertEqual(next_step("service_request", {}), "ask what they need done")
        self.assertEqual(next_step("service_request", {"serviceNeed": "patio"}), "ask for their name and phone number together")
        self.assertEqual(next_step("service_request", {"serviceNeed": "patio", "callerName": "Maria"}), "ask for the best number to reach them")
        self.assertEqual(next_step("service_request", {"serviceNeed": "patio", "contactPhone": "(408) 555-0100"}),
                         'read the number back as "four oh eight, five five five, oh one oh oh" and ask if that\'s right, with no other question')
        self.assertEqual(next_step("service_request", {"serviceNeed": "patio", "contactPhone": "4085550100", "phoneConfirmed": True}),
                         "ask for their name")
        done = {"serviceNeed": "patio", "callerName": "Maria", "contactPhone": "4085550100", "phoneConfirmed": True}
        # Tom, 2026-10-03: when works best for them, asked once, then the address of the job.
        self.assertEqual(next_step("service_request", done), AVAILABILITY_STEP)
        self.assertEqual(next_step("service_request", {**done, "notes": "Available: weekday mornings."}), ADDRESS_STEP)
        self.assertEqual(next_step("service_request", done, asked_available=True), ADDRESS_STEP)
        self.assertEqual(next_step("service_request", {**done, "propertyCity": "Tustin"}, asked_available=True), "ask which state Tustin is in")
        for city in ({"propertyState": "California"}, {"cityConfirmed": True}):
            self.assertEqual(next_step("service_request", {**done, "propertyCity": "Tustin", **city}), "wait, the request is complete")

    def test_two_short_attempts_make_one_valid_number(self):
        one, two = "My name is Tom Lam. Four eight five five five two one four seven.", "Or Zero eight five five five two one four seven."
        self.assertEqual(combined_attempts("085552147", [one, two]), "4085552147")
        self.assertEqual(combined_attempts("485552147", [two, one]), "4085552147")
        self.assertEqual(combined_attempts("085552147", [two, two]), "085552147")
        # 2345678901 and 2345678910 both hold both attempts, so nothing is guessed.
        self.assertEqual(combined_attempts("234567890", ["two three four five six seven eight nine one"]), "234567890")
        self.assertEqual(combined_attempts("485552147", ["four eight five five five two one four seven", "four one two nine nine nine nine nine nine"]), "485552147")
        self.assertEqual(combined_attempts("4085552147", [one, two]), "4085552147")
        # Digits scattered through a sentence are not a phone attempt.
        self.assertEqual(combined_attempts("485552147", ["I'm at 4 Oak Street, apartment 8, and my zip is 3 7 5 3 1 5 3 0 8"]), "485552147")

    def test_a_phone_is_read_back_in_three_three_four_groups(self):
        self.assertEqual(spoken_phone("(408) 555-2147"), "four oh eight, five five five, two one four seven")
        self.assertEqual(spoken_phone("1-408-555-2147"), "four oh eight, five five five, two one four seven")

    def test_the_service_area_state_is_used_only_when_it_is_the_only_one(self):
        self.assertEqual(service_area_state('{"value": "Serving Irvine, Tustin and all of Orange County, California"}'), "California")
        self.assertEqual(service_area_state('{"value": "123 Main St, Irvine, CA 92618"}'), "California")
        self.assertIsNone(service_area_state('{"value": "Serving California and Nevada"}'))
        self.assertIsNone(service_area_state('{"value": "Call us OR email, IN any case"}'))
        self.assertIsNone(service_area_state(''))

    def test_a_status_line_names_actions_in_words_never_field_keys(self):
        line = status_line("service_request", {"accepted": {"callerName": "Maria", "serviceNeed": "patio"}, "rejected": {},
                                               "task": task(fields={"callerName": "Maria", "serviceNeed": "patio"})})
        self.assertEqual(line, "Recorded name and what they need. Next: ask for the best number to reach them.")
        self.assertNotIn("callerName", line)

    def test_a_rejected_phone_asks_for_the_full_number_and_nothing_else(self):
        line = status_line("service_request", {"accepted": {"callerName": "Tom"},
                                               "rejected": {"contactPhone": "That isn't a complete US phone number."},
                                               "task": task(fields={"callerName": "Tom"})})
        self.assertIn("The phone number was not recorded: That isn't a complete US phone number. Next:", line)
        self.assertTrue(line.endswith("ask them to say the whole number again."))
        self.assertNotIn("kept as they gave it", line)

    def test_only_a_full_ten_digit_number_can_be_kept_as_given(self):
        def line(phone, reason):
            return status_line("service_request", {"accepted": {}, "rejected": {"contactPhone": reason}, "task": task()},
                               heard_phone=phone)
        ten = line("4081234567", "That doesn't look like a working US number.")
        self.assertIn("doesn't look quite right", ten)
        self.assertIn("kept as they gave it", ten)
        long = line("40812344567", "That isn't a complete US phone number.")
        self.assertIn("say you caught 11 digits, more than a phone number has", long)
        self.assertNotIn("only caught", long)
        self.assertNotIn("kept as they gave it", long)
        self.assertIn("only caught 9 digits", line("408123456", "That isn't a complete US phone number."))

    def test_a_second_short_number_asks_once_more_without_counting(self):
        reply = {"accepted": {}, "rejected": {"contactPhone": "That isn't a complete US phone number."}, "task": task()}
        first = status_line("service_request", reply, heard_phone="085552147")
        self.assertIn("only caught 9 digits", first)
        second = status_line("service_request", reply, heard_phone="085552147", asked_again=True)
        self.assertIn("once more, slowly", second)
        self.assertNotIn("only caught", second)
        self.assertNotIn("9 digits", second)
        self.assertNotIn("say back", second)

    def test_confirmation_flags_are_not_read_out_as_recorded_details(self):
        line = status_line("complaint", {"accepted": {"phoneConfirmed": True, "noContact": True}, "rejected": {},
                                         "task": task("complaint", fields={"summary": "late"})})
        self.assertFalse(line.startswith("Recorded"))

    def test_complaint_and_appointment_steps(self):
        self.assertEqual(next_step("complaint", {}), "ask what happened")
        self.assertIn("no_contact", next_step("complaint", {"summary": "late crew"}))
        self.assertIn("read the number back", next_step("complaint", {"summary": "late crew", "contactPhone": "4085550100"}))
        self.assertEqual(next_step("appointment_lookup", {}), "ask for the name the appointment is under")


class IntakeRecords(unittest.IsolatedAsyncioTestCase):
    async def test_details_are_recorded_and_the_status_line_comes_back(self):
        stored = {"callerName": "Maria", "serviceNeed": "pressure washing", "propertyCity": "Tustin", "propertyState": "California"}
        flow = FakeFlow({"accepted": stored, "rejected": {}, "task": task(fields=stored)}, state="California")
        flow.caller_texts = ["I'm Maria, I need pressure washing in Tustin."]
        intake, context = ServiceRequestTask(flow, task(), None), Context()
        intake.told_next_step = True  # The next-step line is covered in OpeningLine.
        reply = await intake.record_details(context, name="Maria", service="pressure washing", city="Tustin")
        self.assertEqual(flow.records, [stored])
        self.assertIn("Next: ask for the best number to reach them.", reply)
        # The write cannot be cut off, and the reply after it can be.
        self.assertEqual(context.history, [False, True])
        self.assertFalse(intake.done())

    async def test_a_yes_is_not_taken_as_availability(self):
        fields = {"serviceNeed": "plaza cleaning"}
        flow = FakeFlow({"accepted": {}, "rejected": {}, "task": task(fields=fields)})
        flow.caller_texts = ["Yes, that's right."]
        intake = ServiceRequestTask(flow, task(fields=fields), None)
        await intake.record_details(Context(), available="yes, that is right")
        self.assertEqual(flow.records, [])
        flow.caller_texts = ["Weekday mornings work best."]
        await intake.record_details(Context(), available="weekday mornings")
        self.assertEqual(flow.records, [{"notes": "Available: weekday mornings."}])

    def test_a_known_property_asks_only_for_the_city(self):
        fields = {"serviceNeed": "plaza cleaning", "callerName": "Tom", "contactPhone": "4085552147", "phoneConfirmed": True,
                  "notes": "Property: Westpark Plaza. Available: weekday mornings."}
        self.assertEqual(intake_module.next_step("service_request", fields), intake_module.CITY_STEP)
        fields["notes"] = "Available: weekday mornings."
        self.assertEqual(intake_module.next_step("service_request", fields), intake_module.ADDRESS_STEP)

    async def test_marking_a_plumbing_request_urgent_reminds_bob_of_the_safe_step(self):
        fields = {"serviceNeed": "leak under the sink"}
        flow = FakeFlow({"accepted": {}, "rejected": {}, "task": task(fields=fields)})
        flow.bundle = {**getattr(flow, "bundle", {}), "businessType": "plumbing contractor"}
        intake = ServiceRequestTask(flow, task(fields=fields), None)
        reply = await intake.record_details(Context(), urgent=True)
        self.assertIn("turning off the small valve under the sink", reply)
        self.assertNotIn("valve", await intake.record_details(Context(), name="Priya"))

    async def test_an_urgent_request_says_what_to_tell_a_caller_who_wants_someone_now(self):
        fields = {"serviceNeed": "leak under the sink"}
        flow = FakeFlow({"accepted": {}, "rejected": {}, "task": task(fields=fields)})
        flow.caller_texts = ["Yeah, can you get someone here ASAP?"]
        intake = ServiceRequestTask(flow, task(fields=fields), None)
        reply = await intake.record_details(Context(), urgent=True)
        self.assertTrue(reply.startswith(intake_module.URGENT_REPLY), reply)
        self.assertIn("never say whether or when anyone can come", reply)
        self.assertNotIn("Marked urgent", await intake.record_details(Context(), name="Priya"))

    def test_a_yes_to_passing_a_concern_along_is_not_forced_into_a_service_request(self):
        flow, _, _ = call_flow()
        flow.recent_replies = ["Sorry to hear that. Want me to pass that concern to the manager?"]
        flow.caller_texts = ["Yes, please take down my complaint."]
        self.assertNotEqual(flow.turn_hint(SimpleNamespace(text_content="Yes, please take down my complaint.")), conversation.YES_START)
        flow.recent_replies = ["Turning off the valve stops the water. Want me to pass this issue to the manager?"]
        flow.caller_texts = ["Yes, please."]
        self.assertEqual(flow.turn_hint(SimpleNamespace(text_content="Yes, please.")), conversation.YES_START)

    async def test_a_phone_sent_as_words_is_recorded_as_digits(self):
        fields = {"serviceNeed": "plaza cleaning", "callerName": "Tom Lam"}
        flow = FakeFlow({"accepted": {"contactPhone": "(408) 555-2147"}, "rejected": {},
                         "task": task(fields={**fields, "contactPhone": "(408) 555-2147"})})
        flow.caller_texts = ["Uh, my name is Tom Lam. Phone number is four oh eight five five five two one four seven."]
        intake = ServiceRequestTask(flow, task(fields=fields), None)
        await intake.record_details(Context(), phone="four oh eight five five five two one four seven")
        self.assertEqual(flow.records[0]["contactPhone"], "4085552147")

    async def test_two_short_attempts_are_combined_and_read_back(self):
        # Tom's 2026-10-04 call: each attempt lost a different digit of 408 555 2147.
        fields = {"serviceNeed": "tune-up"}
        short = {"accepted": {}, "rejected": {"contactPhone": "That isn't a complete US phone number."}, "task": task(fields=fields)}
        stored = {**fields, "contactPhone": "(408) 555-2147"}
        flow = FakeFlow(short, {"accepted": {"contactPhone": "(408) 555-2147"}, "rejected": {}, "task": task(fields=stored)})
        intake = ServiceRequestTask(flow, task(fields=fields), None)
        flow.caller_texts = ["My name is Tom Lam. Four eight five five five two one four seven."]
        first = await intake.record_details(Context(), phone="485552147")
        self.assertIn("ask them to say the whole number again", first)
        flow.caller_texts.append("Or Zero eight five five five two one four seven.")
        second = await intake.record_details(Context(), phone="085552147")
        self.assertEqual(flow.records[1]["contactPhone"], "4085552147")
        self.assertIn("four oh eight, five five five, two one four seven", second)

    async def test_the_second_miss_wording_needs_a_short_number_and_resets_when_one_is_recorded(self):
        fields = {"serviceNeed": "tune-up"}
        short = {"accepted": {}, "rejected": {"contactPhone": "That isn't a complete US phone number."}, "task": task(fields=fields)}
        ok = {"accepted": {"contactPhone": "(408) 555-2147"}, "rejected": {}, "task": task(fields={**fields, "contactPhone": "(408) 555-2147"})}
        flow = FakeFlow(short, ok, short)
        intake = ServiceRequestTask(flow, task(fields=fields), None)
        flow.caller_texts = ["It's four eight five five five two one four seven."]
        await intake.record_details(Context(), phone="485552147")
        self.assertTrue(intake.phone_reasked)
        flow.caller_texts.append("Four zero eight five five five two one four seven.")
        await intake.record_details(Context(), phone="4085552147")
        self.assertFalse(intake.phone_reasked)
        flow.caller_texts.append("Sorry, five five five two one four seven zero.")
        self.assertIn("only caught", await intake.record_details(Context(), phone="55521470"))

    async def test_urgent_is_said_once(self):
        # Tom's 2026-10-04 call: "I'll mark it urgent", then "I marked your request as urgent", then "your urgent request".
        fields = {"serviceNeed": "AC blowing warm air"}
        flow = FakeFlow({"accepted": {}, "rejected": {}, "task": task(fields=fields)})
        flow.replies = ["I'll mark it urgent so the manager can prioritize it. Would you like me to pass this along?"]
        intake = ServiceRequestTask(flow, task(fields=fields), None)
        reply = await intake.record_details(Context(), urgent=True)
        self.assertTrue(reply.startswith(intake_module.URGENT_ALREADY_SAID), reply)
        self.assertIn("never say whether or when anyone can come", reply)

    def test_made_up_process_claims_are_caught(self):
        sentence = "They handle everything from diagnosing the problem to fixing it, and they keep you informed through the process."
        self.assertTrue(conversation.unsourced_method(sentence, "Schedule Service. $85 Diagnostic Fee."))
        self.assertFalse(conversation.unsourced_method(sentence, "We handle everything and keep you informed at every step."))

    async def test_a_tip_bob_already_gave_is_not_given_again(self):
        # Live call, 2026-10-04: Blake gave the valve tip, then gave it again when the request was marked urgent.
        fields = {"serviceNeed": "leak under the sink"}
        flow = FakeFlow({"accepted": {}, "rejected": {}, "task": task(fields=fields)})
        flow.bundle = {**flow.bundle, "businessType": "plumbing contractor"}
        flow.replies = ["If you can safely reach it, turning off the small valve under the sink will stop the water until "
                        "someone gets there. Would you like me to pass this to the manager?"]
        intake = ServiceRequestTask(flow, task(fields=fields), None)
        self.assertNotIn("valve", await intake.record_details(Context(), urgent=True))

    def test_each_trade_recognises_its_own_tip(self):
        from trade_guides import TRADE_GUIDES, tip_given
        guides = {guide["trade"]: guide for guide in TRADE_GUIDES}
        said = {"plumbing": "Turning off the water at the main shutoff will help.",
                "heating and air conditioning": "Switching the system off can prevent more damage.",
                "auto repair": "It's safest not to drive the car until it's checked."}
        for trade, reply in said.items():
            self.assertTrue(tip_given(guides[trade], [reply]), trade)
            self.assertFalse(tip_given(guides[trade], ["Can I get your name and number?"]), trade)
        self.assertFalse(tip_given(guides["exterior cleaning"], ["Turn it off."]))

    async def test_a_kind_of_place_is_not_the_property_so_the_street_is_asked(self):
        # Tom's 2026-10-04 call: "this is at my office" made Blake ask only for the city.
        for place in ("office", "my office", "the rental", "our commercial plaza", "My mom's house."):
            self.assertTrue(intake_module.is_a_kind_of_place(place), place)
        for place in ("Westpark Plaza", "12 Oak St", "Da Vien coffee shop", "Irvine Spectrum office"):
            self.assertFalse(intake_module.is_a_kind_of_place(place), place)
        fields = {"serviceNeed": "AC blowing warm air", "callerName": "Tom", "contactPhone": "4085552147", "phoneConfirmed": True}
        saved = {**fields, "notes": f"Available: {intake_module.EARLIEST}. {intake_module.WANTS_IT_SOON}"}
        flow = FakeFlow({"accepted": {"notes": saved["notes"]}, "rejected": {}, "task": task(fields=saved)})
        flow.caller_texts = ["My AC is blowing warm air, this is at my office. I need it fixed ASAP."]
        intake = ServiceRequestTask(flow, task(fields=fields), None)
        reply = await intake.record_details(Context(), property_name="office", urgent=True)
        self.assertNotIn("Property:", flow.records[0]["notes"])
        self.assertIn(intake_module.ADDRESS_STEP, reply)

    async def test_an_urgent_flag_alone_marks_the_request_urgent(self):
        fields = {"serviceNeed": "leak under the sink"}
        flow = FakeFlow({"accepted": {}, "rejected": {}, "task": task(fields=fields)})
        intake = ServiceRequestTask(flow, task(fields=fields), None)
        await intake.record_details(Context(), urgent=True)
        self.assertEqual(flow.records, [{"notes": "Wants it done as soon as possible."}])

    async def test_without_a_service_area_state_the_city_is_taken_as_given(self):
        flow = FakeFlow({"accepted": {"propertyCity": "Tustin"}, "rejected": {}, "task": task(fields={"propertyCity": "Tustin", "cityConfirmed": True})})
        flow.caller_texts = ["It's in Tustin."]
        intake = ServiceRequestTask(flow, task(), None)
        await intake.record_details(Context(), city="Tustin")
        self.assertEqual(flow.records, [{"propertyCity": "Tustin", "cityConfirmed": True}])

    async def test_a_city_the_caller_never_said_is_not_saved(self):
        # Live call, 2026-10-06: on a cut-off "It all" the model saved a city, which saved the request without the street.
        flow = FakeFlow({"accepted": {}, "rejected": {}, "task": task()})
        flow.caller_texts = ["I think Friday two p.m.", "It all."]
        intake = ServiceRequestTask(flow, task(), None)
        await intake.record_details(Context(), city="Long Beach")
        self.assertNotIn("propertyCity", (flow.records or [{}])[-1])
        # Harness, 2026-10-06: "It'll" was said, but it is the start of a cut-off turn, not a city.
        flow.caller_texts.append("It'll")
        await intake.record_details(Context(), city="It'll")
        self.assertNotIn("propertyCity", (flow.records or [{}])[-1])

    def test_a_cut_off_start_is_not_a_property(self):
        for text in ("It'll", "It’ll.", "it's the", "Uh, so"):
            self.assertTrue(intake_module.is_a_cut_off(text), text)
        for text in ("Westpark Plaza", "222 South Long Beach Boulevard", "The Oaks", "Its Corner Cafe"):
            self.assertFalse(intake_module.is_a_cut_off(text), text)

    async def test_a_new_phone_is_read_back_and_a_yes_confirms_it(self):
        fields = {"serviceNeed": "patio", "callerName": "Maria", "contactPhone": "(408) 555-2147"}
        flow = FakeFlow({"accepted": {"contactPhone": "(408) 555-2147"}, "rejected": {}, "task": task(fields=fields)})
        flow.caller_texts = ["It's four oh eight, five five five, two one four seven."]
        intake = ServiceRequestTask(flow, task(fields={"serviceNeed": "patio", "callerName": "Maria"}), None)
        reply = await intake.record_details(Context(), phone="408 555 2147")
        self.assertIn('"four oh eight, five five five, two one four seven"', reply)
        self.assertTrue(intake.readback_asked)

    async def test_a_yes_confirms_the_number_only_after_it_was_read_back(self):
        fields = {"contactPhone": "(408) 555-2147"}
        flow = FakeFlow({"accepted": {}, "rejected": {}, "task": task(fields=fields)})
        intake = ServiceRequestTask(flow, task(fields=fields), None)
        self.assertIn("Nothing new to record", await intake.record_details(Context(), phone_confirmed=True))
        intake.readback_asked = True
        flow.caller_texts = ["Yes, 408-555-2147."]
        await intake.record_details(Context(), phone="4085552147", phone_confirmed=True)
        self.assertEqual(flow.records, [{"contactPhone": "4085552147", "phoneConfirmed": True}])

    async def test_a_question_instead_of_a_yes_does_not_confirm_the_number(self):
        flow = FakeFlow({"accepted": {}, "rejected": {}, "task": task(fields={"contactPhone": "(949) 555-0147"})})
        intake = ServiceRequestTask(flow, task(fields={"contactPhone": "(949) 555-0147"}), None)
        intake.readback_asked = True
        for words in ("It's in Irvine, do you guys go there?", "No, that's not right."):
            flow.caller_texts = [words]
            self.assertIn("Nothing new to record", await intake.record_details(Context(), phone_confirmed=True))
        for words in ("Yep.", "949-555-0147.", "nine four nine, five five five, oh one four seven", "Correct."):
            flow.caller_texts = [words]
            self.assertTrue(confirms_number(words, "(949) 555-0147"), words)

    async def test_a_number_the_caller_never_said_is_dropped(self):
        flow = FakeFlow()
        flow.caller_texts = ["I'm Ana.", "Did you get all that saved already?"]
        intake = ServiceRequestTask(flow, task(fields={"callerName": "Ana", "serviceNeed": "patio"}), None)
        self.assertIn("Nothing new to record", await intake.record_details(Context(), phone="7205551212"))
        self.assertEqual(flow.records, [])

    def test_numbers_are_heard_the_ways_people_say_them(self):
        for words in ("408-555-2147", "four oh eight, five five five, two one four seven",
                      "four zero eight, five fifty-five, twenty-one forty-seven", "four oh eight five five five two one four seven"):
            self.assertEqual(said_digits(words), "4085552147", words)
        self.assertEqual(said_digits("eight hundred, double five, five, twelve twelve"), "8005551212")
        self.assertEqual(said_digits("seventy oh one"), "7001")

    def test_a_correction_of_the_last_four_digits_counts_as_said(self):
        texts = ["Sure, I'm Lee, 714-555-0183.", "No, the last part is zero one eight four."]
        self.assertTrue(number_was_said("7145550184", texts, "(714) 555-0183"))
        self.assertFalse(number_was_said("7145550184", ["Did you get that?"], "(714) 555-0183"))
        self.assertFalse(number_was_said("2125550184", texts, "(714) 555-0183"))

    async def test_a_corrected_number_is_not_confirmed_in_the_same_turn(self):
        flow = FakeFlow({"accepted": {}, "rejected": {}, "task": task(fields={"contactPhone": "(408) 555-2148"})})
        intake = ServiceRequestTask(flow, task(fields={"contactPhone": "(408) 555-2147"}), None)
        intake.readback_asked = True
        flow.caller_texts = ["No, it's 408 555 2148."]
        await intake.record_details(Context(), phone="408 555 2148", phone_confirmed=True)
        self.assertEqual(flow.records, [{"contactPhone": "408 555 2148"}])

    async def test_the_record_that_completes_the_request_completes_the_task_with_the_saved_result(self):
        saved = task(status="succeeded", receipt={"operationId": uid(20), "outcome": "saved"})
        flow = FakeFlow({"accepted": {"phoneConfirmed": True}, "rejected": {}, "task": saved})
        intake = ServiceRequestTask(flow, task(fields={"contactPhone": "(408) 555-2147"}), None)
        intake.readback_asked = True
        flow.caller_texts = ["Yes."]
        self.assertIsNone(await intake.record_details(Context(), phone_confirmed=True))
        self.assertTrue(intake.done())
        self.assertEqual(await asyncio.wait_for(asyncio.shield(intake._AgentTask__fut), 1), saved)

    async def test_an_empty_or_late_record_did_not_run(self):
        flow = FakeFlow()
        intake = ServiceRequestTask(flow, task(fields={"serviceNeed": "patio"}), None)
        reply = await intake.record_details(Context())
        self.assertTrue(reply.startswith("Nothing new to record. Next:"))
        self.assertIn("ask for their name and phone number together", reply)
        intake.complete({"status": "stopped"})
        self.assertIn("already finished", await intake.record_details(Context(), name="Maria"))
        self.assertEqual(flow.records, [])

    async def test_a_failed_write_says_nothing_was_recorded(self):
        flow = FakeFlow(RuntimeHttpError(503))
        intake = ServiceRequestTask(flow, task(), None)
        reply = await intake.record_details(Context(), name="Maria")
        self.assertTrue(reply.startswith("That did not go through, so nothing new was recorded."))
        self.assertFalse(intake.done())

    async def test_a_complaint_saves_once_the_caller_declines_contact(self):
        saved = task("complaint", "succeeded", {"summary": "crew was late", "noContact": True}, receipt={"operationId": uid(21)})
        flow = FakeFlow({"accepted": {"noContact": True}, "rejected": {},
                         "task": task("complaint", fields={"summary": "crew was late", "noContact": True})},
                        finish={"task": saved})
        intake = ComplaintTask(flow, task("complaint", fields={"summary": "crew was late"}), None)
        self.assertIsNone(await intake.record_details(Context(), no_contact=True))
        self.assertEqual(flow.finished, 1)
        self.assertTrue(intake.done())

    async def test_a_complaint_without_contact_or_decline_keeps_asking(self):
        flow = FakeFlow({"accepted": {"summary": "crew was late"}, "rejected": {},
                         "task": task("complaint", fields={"summary": "crew was late"})})
        intake = ComplaintTask(flow, task("complaint"), None)
        self.assertIn("ask once for their name", await intake.record_details(Context(), complaint="crew was late"))
        self.assertEqual(flow.finished, 0)

    async def test_a_complaint_with_an_unconfirmed_phone_is_read_back_before_it_saves(self):
        fields = {"summary": "crew was late", "contactPhone": "(408) 555-2147"}
        flow = FakeFlow({"accepted": {"contactPhone": "(408) 555-2147"}, "rejected": {}, "task": task("complaint", fields=fields)})
        flow.caller_texts = ["Sure, 408 555 2147."]
        intake = ComplaintTask(flow, task("complaint", fields={"summary": "crew was late"}), None)
        self.assertIn("read the number back", await intake.record_details(Context(), phone="408 555 2147"))
        self.assertEqual(flow.finished, 0)

    async def test_an_appointment_lookup_runs_once_name_and_change_are_in(self):
        looked_up = task("appointment_lookup", "succeeded", {"callerName": "Maria", "appointmentAction": "cancel"},
                         lookup={"kind": "not_found"})
        flow = FakeFlow({"accepted": {"callerName": "Maria", "appointmentAction": "cancel"}, "rejected": {},
                         "task": task("appointment_lookup", fields={"callerName": "Maria", "appointmentAction": "cancel"})},
                        finish={"task": looked_up})
        intake = AppointmentTask(flow, task("appointment_lookup"), None)
        self.assertIsNone(await intake.record_details(Context(), name="Maria", change="cancel"))
        self.assertTrue(intake.done())

    async def test_a_state_the_caller_never_said_is_replaced_by_the_service_area_state(self):
        flow = FakeFlow({"accepted": {"propertyCity": "Reno"}, "rejected": {}, "task": task(fields={"propertyCity": "Reno"})},
                        state="California")
        flow.caller_texts = ["It's in Reno."]
        intake = ServiceRequestTask(flow, task(), None)
        await intake.record_details(Context(), city="Reno", state="NV")
        self.assertEqual(flow.records, [{"propertyCity": "Reno", "propertyState": "California"}])

    async def test_a_question_that_came_with_the_yes_is_answered_first(self):
        # 2026-10-01 call: "Uh, yes. So what's the next step? Like what does the process look like?"
        flow = FakeFlow({"accepted": {"serviceNeed": "plaza cleaning"}, "rejected": {}, "task": task(fields={"serviceNeed": "plaza cleaning"})})
        flow.caller_texts = ["Uh, yes. Um, so I guess like what's the next step? Like what does the process look like?"]
        flow.spoken_this_turn = ""
        intake = ServiceRequestTask(flow, task(), None)
        self.assertIn("They also asked", await intake.record_details(Context(), service="plaza cleaning"))
        flow.asked_how_it_works = lambda: True
        flow.responses.append({"accepted": {}, "rejected": {}, "task": task(fields={"serviceNeed": "plaza cleaning"})})
        self.assertIn(intake_module.ANSWER_HOW, await intake.record_details(Context(), service="plaza cleaning"))

    async def test_a_question_asked_before_the_request_started_is_not_answered_again(self):
        stored = {"serviceNeed": "plaza cleaning"}
        flow = FakeFlow(*[{"accepted": {"serviceNeed": "plaza cleaning"}, "rejected": {}, "task": task(fields=stored)}] * 2)
        flow.caller_texts = ["Can you help me with that?"]
        flow.spoken_this_turn = "Yes, we clean plazas."
        intake = ServiceRequestTask(flow, task(), None)
        self.assertNotIn("They also asked", await intake.record_details(Context(), service="plaza cleaning"))
        flow.caller_texts.append("Do you go to Irvine?")
        self.assertIn("They also asked", await intake.record_details(Context(), service="plaza cleaning"))

    async def test_a_yes_is_never_recorded_as_the_city(self):
        flow = FakeFlow(state="California")
        intake = ServiceRequestTask(flow, task(fields={"contactPhone": "4085550100", "phoneConfirmed": True}), None)
        self.assertIn("Nothing new to record", await intake.record_details(Context(), city="Yes"))
        self.assertEqual(flow.records, [])

    async def test_a_state_the_caller_said_is_kept(self):
        flow = FakeFlow({"accepted": {}, "rejected": {}, "task": task(fields={"propertyCity": "Reno", "propertyState": "NV"})},
                        state="California")
        flow.caller_texts = ["Reno, Nevada."]
        intake = ServiceRequestTask(flow, task(), None)
        await intake.record_details(Context(), city="Reno", state="NV")
        self.assertEqual(flow.records, [{"propertyCity": "Reno", "propertyState": "NV"}])

    def test_state_was_said_matches_names_and_abbreviations_only(self):
        self.assertTrue(state_was_said("CA", ["Yes, Tustin, California."]))
        self.assertTrue(state_was_said("California", ["Tustin, CA"]))
        self.assertFalse(state_was_said("CA", ["Newport Beach."]))
        self.assertFalse(state_was_said("CA", ["I can do it."]))

    async def test_a_yes_never_stops_the_request(self):
        flow = FakeFlow()
        flow.caller_texts = ["Yeah, sounds good."]
        intake = ServiceRequestTask(flow, task(fields={"serviceNeed": "plaza cleaning"}), None)
        self.assertIn("did not run", await intake.stop_request(Context()))
        self.assertEqual(flow.cancelled, 0)
        self.assertFalse(intake.done())

    async def test_stop_request_cancels_and_completes_as_stopped(self):
        flow = FakeFlow()
        flow.caller_texts = ["Actually, never mind."]
        intake = ServiceRequestTask(flow, task(), None)
        await intake.stop_request(Context())
        self.assertEqual(flow.cancelled, 1)
        self.assertEqual(intake._AgentTask__fut.result(), {"status": "stopped"})


class CallingForSomeoneElse(unittest.IsolatedAsyncioTestCase):
    """VCF fix 4: a caller asking for a friend is asked once for that person's name and the property, kept in notes."""

    FRIEND = ["Hey Bob. I I'm going for a friend who is managing commercial plaza",
              "And um, he needs some cleaning in front of each of the store within that plaza as well as around the trash area. "
              "Can you help me with that?", "Uh, sure, um"]

    def test_calling_for_someone_else_is_heard(self):
        self.assertTrue(calling_for_someone(self.FRIEND))
        self.assertTrue(calling_for_someone(["I have a friend who runs a commercial plaza."]))
        self.assertTrue(calling_for_someone(["I'm calling on behalf of my boss."]))
        self.assertFalse(calling_for_someone(["I need my driveway washed.", "My friend recommended you."]))

    CONTACT = {"serviceNeed": "plaza cleaning", "callerName": "Tom Lam", "contactPhone": "(408) 555-0153", "phoneConfirmed": True}

    async def test_the_caller_contact_comes_first_then_the_person_and_property_once(self):
        flow = FakeFlow({"accepted": {"serviceNeed": "plaza cleaning"}, "rejected": {}, "task": task(fields={"serviceNeed": "plaza cleaning"})},
                        {"accepted": {"phoneConfirmed": True}, "rejected": {}, "task": task(fields=self.CONTACT)},
                        {"accepted": {"propertyCity": "Irvine"}, "rejected": {}, "task": task(fields={**self.CONTACT, "propertyCity": "Irvine"})})
        flow.caller_texts = list(self.FRIEND)
        intake = ServiceRequestTask(flow, task(), None)
        reply = await intake.record_details(Context(), service="plaza cleaning")
        # Tom (2026-10-01): one contact name and number, and the caller decides whose it is.
        self.assertIn(f"then {intake_module.CONTACT_FOR_SOMEONE}.", reply)
        self.assertIn("Don't say or ask whose it should be", reply)
        self.assertNotIn("whether that should be", reply)
        self.assertIn("In terms of next steps", reply)
        intake.fields = {**self.CONTACT, "phoneConfirmed": False}
        intake.readback_asked = True
        flow.caller_texts.append("Yes.")
        reply = await intake.record_details(Context(), phone_confirmed=True)
        # Only the property: the other person's name in the same question confused a caller.
        self.assertIn("Next: ask once for the property's name or street address, in plain words, without suggesting one.", reply)
        self.assertNotIn("person they are calling for", reply)
        flow.caller_texts.append("Irvine.")
        reply = await intake.record_details(Context(), city="Irvine")
        self.assertNotIn("calling for", reply or "")

    async def test_the_caller_own_name_is_never_kept_as_the_person_they_call_for(self):
        flow = FakeFlow({"accepted": {"callerName": "Tom Lam"}, "rejected": {},
                         "task": task(fields={"serviceNeed": "plaza cleaning", "callerName": "Tom Lam"})})
        flow.caller_texts = [*self.FRIEND, "Uh, my name is Tom Lam."]
        intake = ServiceRequestTask(flow, task(fields={"serviceNeed": "plaza cleaning"}), None)
        await intake.record_details(Context(), name="Tom Lam", calling_for="Tom Lam")
        self.assertEqual(flow.records, [{"callerName": "Tom Lam"}])

    async def test_the_person_given_with_a_number_is_the_contact(self):
        # Tom (2026-10-01): "Can you contact my friend? His name is Magnus, and his number is..." makes Magnus the contact.
        stored = {"serviceNeed": "plaza cleaning", "callerName": "Magnus", "contactPhone": "(408) 555-2147", "notes": "Calling for Magnus."}
        flow = FakeFlow({"accepted": {"callerName": "Magnus", "contactPhone": "(408) 555-2147", "notes": "Calling for Magnus."},
                         "rejected": {}, "task": task(fields=stored)})
        flow.caller_texts = [*self.FRIEND, "Can you contact my friend? His name is Magnus, and his number is 408 555 2147."]
        intake = ServiceRequestTask(flow, task(fields={"serviceNeed": "plaza cleaning"}), None)
        await intake.record_details(Context(), phone="4085552147", calling_for="Magnus")
        self.assertEqual(flow.records[0]["callerName"], "Magnus")
        self.assertEqual(flow.records[0]["notes"], "Calling for Magnus.")

    async def test_a_yes_is_never_kept_as_a_name(self):
        flow = FakeFlow()
        flow.caller_texts = ["Yeah, sounds good."]
        intake = ServiceRequestTask(flow, task(fields={"serviceNeed": "plaza cleaning"}), None)
        reply = await intake.record_details(Context(), name="Yeah")
        self.assertEqual(flow.records, [])
        self.assertIn("ask for their name and phone number together", reply)

    async def test_a_name_or_place_the_caller_never_said_is_dropped(self):
        flow = FakeFlow({"accepted": {"notes": "Property: Westpark Plaza."}, "rejected": {},
                         "task": task(fields={**self.CONTACT, "notes": "Property: Westpark Plaza."})})
        flow.caller_texts = [*self.FRIEND, "The place is Westpark Plaza."]
        intake = ServiceRequestTask(flow, task(fields=dict(self.CONTACT)), None)
        await intake.record_details(Context(), calling_for="Mike", property_name="Westpark Plaza")
        self.assertEqual(flow.records, [{"notes": "Property: Westpark Plaza."}])
        self.assertTrue(was_said("123 Main Street", ["It's one two three Main Street."]))
        self.assertFalse(was_said("Mike", ["I don't know his name."]))

    async def test_the_person_and_property_go_into_notes_across_turns(self):
        fields = dict(self.CONTACT)
        flow = FakeFlow({"accepted": {"notes": "Calling for Mike."}, "rejected": {},
                         "task": task(fields={**fields, "notes": "Calling for Mike."})},
                        {"accepted": {"notes": "Calling for Mike. Property: Westpark Plaza."}, "rejected": {},
                         "task": task(fields={**fields, "notes": "Calling for Mike. Property: Westpark Plaza."})})
        flow.caller_texts = [*self.FRIEND, "His name is Mike."]
        intake = ServiceRequestTask(flow, task(fields=fields), None)
        intake.told_next_step = True  # The next-step line is covered in OpeningLine.
        reply = await intake.record_details(Context(), calling_for="Mike")
        flow.caller_texts.append("It's Westpark Plaza.")
        self.assertIn("Recorded who it is for and the property.", reply)
        self.assertIn("Next: ask once for the property's name or street address, in plain words, without suggesting one.", reply)
        reply = await intake.record_details(Context(), property_name="Westpark Plaza")
        self.assertEqual(flow.records, [{"notes": "Calling for Mike."}, {"notes": "Calling for Mike. Property: Westpark Plaza."}])
        self.assertIn(AVAILABILITY_STEP, reply)
        self.assertEqual(note_parts("Calling for Mike. Property: Westpark Plaza."), {"person": "Mike", "property": "Westpark Plaza"})
        self.assertEqual(note_parts("Calling for Mike. Property: 12 St. Mark Plaza."), {"person": "Mike", "property": "12 St. Mark Plaza"})
        self.assertEqual(note_parts("Property: Westpark Plaza."), {"property": "Westpark Plaza"})
        self.assertEqual(note_parts("Property: 12 Oak St. Available: weekday mornings."), {"property": "12 Oak St", "available": "weekday mornings"})

    async def test_a_house_number_said_in_words_is_saved_as_digits(self):
        # Tom's 2026-10-05 test call saved "Property: one two three Buckingham Drive."
        fields = {"serviceNeed": "AC blowing warm air"}
        flow = FakeFlow({"accepted": {"notes": "x"}, "rejected": {}, "task": task(fields=fields)})
        flow.caller_texts = ["It's one two three Buckingham Drive in Fremont."]
        intake = ServiceRequestTask(flow, task(fields=fields), None)
        intake.told_next_step = True
        await intake.record_details(Context(), property_name="one two three Buckingham Drive")
        self.assertEqual(flow.records[0]["notes"], "Property: 123 Buckingham Drive.")

    def test_house_number_as_digits(self):
        self.assertEqual(house_number_as_digits("one two three Buckingham Drive"), "123 Buckingham Drive")
        self.assertEqual(house_number_as_digits("thirty-nine four thirty-nine Paseo Padre Parkway"), "39439 Paseo Padre Parkway")
        self.assertEqual(house_number_as_digits("twelve fifty Mowry Avenue"), "1250 Mowry Avenue")
        self.assertEqual(house_number_as_digits("forty-one oh thirty-nine Boscell Road"), "41039 Boscell Road")
        # Already digits, a name without a street type, and "thousand" (which said_digits can't place) stay as they are.
        for place in ("123 Main Street", "Westpark Plaza", "Twelve Oaks", "the plaza on Main Street",
                      "four thousand one hundred Stevens Creek Boulevard"):
            self.assertEqual(house_number_as_digits(place), place)

    async def test_the_question_waits_while_the_caller_contact_is_incomplete(self):
        fields = {"serviceNeed": "plaza cleaning"}
        flow = FakeFlow({"accepted": {}, "rejected": {"contactPhone": "That isn't a complete US phone number."}, "task": task(fields=fields)},
                        {"accepted": {"callerName": "Tom"}, "rejected": {}, "task": task(fields={**fields, "callerName": "Tom"})})
        flow.caller_texts = [*self.FRIEND[:2], "It's two one two five five five oh one five"]
        intake = ServiceRequestTask(flow, task(fields=fields), None)
        self.assertIn("say the whole number again", await intake.record_details(Context(), phone="212555015"))
        flow.caller_texts.append("Tom.")
        reply = await intake.record_details(Context(), name="Tom")
        self.assertIn("ask for the best number to reach them", reply)
        self.assertFalse(intake.someone_asked)

    def test_a_caller_on_their_own_behalf_is_never_asked(self):
        self.assertEqual(next_step("service_request", {"serviceNeed": "patio"}), "ask for their name and phone number together")


class SegmentRepeat(unittest.TestCase):
    """Live call, 2026-10-03: the transcriber heard the digit at a break twice and the number came out as 11 digits."""

    SAID = "My name is Tom, and And my number is four zero eight One two three four Four five six seven."

    def test_a_digit_heard_twice_at_a_break_is_dropped(self):
        self.assertEqual(without_segment_repeat("40812344567", [self.SAID]), "4081234567")

    def test_anything_else_is_left_alone(self):
        self.assertEqual(without_segment_repeat("4081234567", ["four zero eight one two three four five six seven"]),
                         "4081234567")
        # Lowercase repeats are real repeated digits, not a break.
        said = "four zero eight one two three four four five six seven"
        self.assertEqual(without_segment_repeat("40812344567", [said]), "40812344567")
        # Two capitalized repeats leave the position unclear.
        said = "four zero eight One two two Two three four Four five"
        self.assertEqual(without_segment_repeat("40812223445", [said]), "40812223445")
        # The model's digits must match what the caller said.
        self.assertEqual(without_segment_repeat("40812344568", [self.SAID]), "40812344568")


class SplitPhoneNumber(unittest.IsolatedAsyncioTestCase):
    """VCF fix 5: "four oh eight" then "five five five oh one five three" in the next turn is one number."""

    FIRST, REST = "My name is Tom Lam. My phone number is four oh eight", "Five five five oh one five three."

    def test_a_leading_group_joins_the_digits_in_the_next_turn(self):
        self.assertEqual(joined_phone("5550153", [self.FIRST, self.REST]), "4085550153")
        self.assertEqual(joined_phone("555-0153", ["It's four oh eight five five five", "oh one five three"]), "555-0153")
        self.assertEqual(joined_phone("0153", ["four oh eight five five five", "oh one five three"]), "4085550153")
        self.assertEqual(joined_phone("5550153", ["I'm in Irvine.", self.REST]), "5550153")
        self.assertEqual(joined_phone("5550153", ["It's at one two three Main.", self.REST]), "5550153")
        self.assertEqual(joined_phone("4085550153", [self.FIRST, self.REST]), "4085550153")

    async def test_the_split_number_is_held_then_joined_and_read_back_in_three_three_four(self):
        named = task(fields={"serviceNeed": "plaza cleaning", "callerName": "Tom Lam"})
        phoned = task(fields={"serviceNeed": "plaza cleaning", "callerName": "Tom Lam", "contactPhone": "(408) 555-0153"})
        flow = FakeFlow({"accepted": {"callerName": "Tom Lam"}, "rejected": {}, "task": named},
                        {"accepted": {"contactPhone": "(408) 555-0153"}, "rejected": {}, "task": phoned})
        flow.caller_texts = [self.FIRST]
        intake = ServiceRequestTask(flow, task(fields={"serviceNeed": "plaza cleaning"}), None)
        reply = await intake.record_details(Context(), name="Tom Lam", phone="408")
        self.assertEqual(flow.records, [{"callerName": "Tom Lam"}])
        self.assertIn("Heard the start of the phone number, four oh eight. Next: ask for the rest of the number", reply)
        flow.caller_texts.append(self.REST)
        reply = await intake.record_details(Context(), phone="555 0153")
        self.assertEqual(flow.records[-1], {"contactPhone": "4085550153"})
        self.assertIn('read the number back as "four oh eight, five five five, oh one five three"', reply)
        self.assertTrue(intake.readback_asked)

    async def test_a_number_still_short_is_said_back_in_groups(self):
        flow = FakeFlow({"accepted": {}, "rejected": {"contactPhone": "That isn't a complete US phone number."},
                         "task": task(fields={"serviceNeed": "plaza cleaning"})})
        flow.caller_texts = ["Five five five oh one five three."]
        intake = ServiceRequestTask(flow, task(fields={"serviceNeed": "plaza cleaning"}), None)
        reply = await intake.record_details(Context(), phone="5550153")
        self.assertIn('say back the digits you heard as "five five five, oh one five three", say you only caught 7 digits', reply)


    PATTERN = "That doesn't look like a working US number, because an area code or the next three digits never start with 0 or 1."

    async def test_a_refused_number_the_caller_stands_by_is_kept_as_given(self):
        # Tom's call, 2026-10-03: 408 123 4567 was refused three times and the request was never saved.
        for answer in ("No, that is correct.", "Yes, that's my number.", "I just told you the phone number."):
            refused = {"accepted": {}, "rejected": {"contactPhone": self.PATTERN}, "task": task(fields={"callerName": "Tom"})}
            kept = {"accepted": {"contactPhone": "(408) 123-4567"}, "rejected": {},
                    "task": task(fields={"callerName": "Tom", "contactPhone": "(408) 123-4567", "phoneConfirmed": True})}
            flow = FakeFlow(refused, kept)
            flow.caller_texts = ["Phone number is four oh eight one two three four five six seven."]
            intake = ServiceRequestTask(flow, task(fields={"callerName": "Tom"}), None)
            reply = await intake.record_details(Context(), phone="408 123 4567")
            self.assertIn("say only that it doesn't look quite right, with no reason", reply)
            self.assertNotIn("area code", reply)
            flow.caller_texts.append(answer)
            await intake.record_details(Context())
            self.assertEqual(flow.records[-1]["contactPhone"], "4081234567", answer)
            self.assertTrue(flow.records[-1]["phoneAsGiven"] and flow.records[-1]["phoneConfirmed"])
            self.assertIn(intake_module.PHONE_AS_GIVEN, flow.records[-1]["notes"])

    async def test_a_refused_number_said_again_is_kept_but_a_new_one_is_checked(self):
        refused = {"accepted": {}, "rejected": {"contactPhone": self.PATTERN}, "task": task(fields={"callerName": "Tom"})}
        flow = FakeFlow(refused, dict(refused), dict(refused))
        flow.caller_texts = ["It's four oh eight one two three four five six seven."]
        intake = ServiceRequestTask(flow, task(fields={"callerName": "Tom"}), None)
        await intake.record_details(Context(), phone="408 123 4567")
        flow.caller_texts.append("Four oh eight, one two three, four five six seven.")
        await intake.record_details(Context(), phone="408 123 4567")
        self.assertTrue(flow.records[-1]["phoneAsGiven"])
        intake.refused_phone = "4081234567"; intake.someone.pop("phone_as_given", None)
        flow.caller_texts.append("Sorry, it's four oh eight five five five one two three four.")
        await intake.record_details(Context(), phone="408 555 1234")
        self.assertNotIn("phoneAsGiven", flow.records[-1])
        # A "no, it's wrong" never keeps the refused number.
        flow.caller_texts.append("No, that's wrong.")
        await intake.record_details(Context())
        self.assertNotIn("phoneAsGiven", flow.records[-1] if flow.records[-1] else {})

    async def test_a_digit_doubled_at_a_break_is_dropped_then_kept_when_confirmed(self):
        # Live call, 2026-10-03: "four zero eight One two three four Four five six seven" was refused as incomplete.
        refused = {"accepted": {}, "rejected": {"contactPhone": self.PATTERN}, "task": task(fields={"callerName": "Tom"})}
        kept = {"accepted": {"contactPhone": "(408) 123-4567"}, "rejected": {},
                "task": task(fields={"callerName": "Tom", "contactPhone": "(408) 123-4567", "phoneConfirmed": True})}
        flow = FakeFlow(refused, kept)
        flow.caller_texts = [SegmentRepeat.SAID]
        intake = ServiceRequestTask(flow, task(fields={"callerName": "Tom"}), None)
        reply = await intake.record_details(Context(), phone="408 123 44567")
        self.assertEqual(flow.records[0]["contactPhone"], "4081234567")
        self.assertIn('"four oh eight, one two three, four five six seven"', reply)
        flow.caller_texts.append("Yes, that's right.")
        await intake.record_details(Context())
        self.assertTrue(flow.records[-1]["phoneAsGiven"])

    async def test_the_doubled_digit_is_dropped_again_when_the_model_resends_it_on_the_confirm(self):
        # Live call, 2026-10-04: after "No, that is correct." the model sent the eleven digits again.
        refused = {"accepted": {}, "rejected": {"contactPhone": self.PATTERN}, "task": task(fields={"callerName": "Tom"})}
        kept = {"accepted": {"contactPhone": "(408) 123-4567"}, "rejected": {},
                "task": task(fields={"callerName": "Tom", "contactPhone": "(408) 123-4567", "phoneConfirmed": True})}
        flow = FakeFlow(refused, kept)
        flow.caller_texts = ["My name is Tom, and my number is four zero eight one two three four. Four five six seven."]
        intake = ServiceRequestTask(flow, task(fields={"callerName": "Tom"}), None)
        await intake.record_details(Context(), phone="408 123 44567")
        flow.caller_texts.append("No, that is correct.")
        await intake.record_details(Context(), phone="408 123 44567")
        self.assertEqual(flow.records[-1]["contactPhone"], "4081234567")
        self.assertTrue(flow.records[-1]["phoneAsGiven"] and flow.records[-1]["phoneConfirmed"])

    def test_the_note_for_a_number_kept_as_given_reads_back(self):
        notes = intake_module.notes_text({"property": "12 Oak St", "soon": "yes", "phone_as_given": "yes"})
        self.assertEqual(intake_module.note_parts(notes), {"property": "12 Oak St", "soon": intake_module.WANTS_IT_SOON, "phone_as_given": intake_module.PHONE_AS_GIVEN})


class SaveGuard(unittest.TestCase):
    def test_unconfirmed_save_claims_are_dropped_and_the_rest_of_the_reply_is_kept(self):
        reply = "I've passed your request along. What's the best number to reach you?"
        self.assertEqual(guarded_reply(reply), "What's the best number to reach you?")
        self.assertEqual(guarded_reply("I've saved your request."), "Let me get the rest of your details first.")

    def test_a_receipt_allows_the_save_claim_but_never_a_booking(self):
        self.assertEqual(guarded_reply("I've passed it along to the owner.", has_receipt=True), "I've passed it along to the owner.")
        self.assertNotIn("booked", guarded_reply("I've booked you for Tuesday. Anything else?", has_receipt=True))

    def test_saving_part_of_the_details_is_still_a_save_claim(self):
        reply = "I saved your name and that you need your patio cleaned, Ana. Can you share your phone number?"
        self.assertEqual(guarded_reply(reply), "Can you share your phone number?")

    def test_a_follow_up_is_promised_only_after_a_save_or_with_the_pass_along(self):
        reply = "Your number is confirmed then. The manager will follow up with you soon about the leak. Anything else?"
        self.assertEqual(guarded_reply(reply, request_open=True), "Your number is confirmed then. Anything else?")
        self.assertEqual(guarded_reply(reply, has_receipt=True, request_open=True), reply)
        self.assertEqual(guarded_reply(reply), reply)
        kept = "I'll pass your request along to the manager, and they'll follow up about the details."
        self.assertEqual(guarded_reply(kept, request_open=True), kept)

    def test_a_passive_passed_along_is_a_save_claim(self):
        for reply in ("It's been passed along to the owner. Anything else?", "That's passed along. Anything else?"):
            self.assertEqual(guarded_reply(reply), "Anything else?")
        self.assertEqual(guarded_reply("It's been passed along.", has_receipt=True), "It's been passed along.")

    def test_ordinary_noting_of_a_detail_is_not_a_save_claim(self):
        for reply in ("Got it, Irvine. And what's your name?", "I've noted that you're in Irvine. What's your name?"):
            self.assertEqual(guarded_reply(reply), reply)


class ResultLines(unittest.TestCase):
    def saved(self, policy):
        return result_line("service_request", task(status="succeeded", fields={"contactPhone": "4085550100"},
                                                   receipt={"operationId": uid(20)}), policy, "Riverside Dental")

    def test_owner_and_shared_link_calls_get_the_real_call_fact(self):
        self.assertIn("follow up", self.saved("signup_pitch"))
        for policy in (None, "test_summary", "guest_feedback"):
            self.assertIn("passed along for the manager to review", self.saved(policy))
            self.assertIn("unless they already said they're done", self.saved(policy))
            self.assertNotIn("test", self.saved(policy))

    def test_an_urgent_request_says_when_they_will_hear_back(self):
        # Tom, 2026-10-03: an urgent caller hears it is marked urgent and a soft window, not only "passed along".
        urgent = task(status="succeeded", fields={"contactPhone": "4085550100", "notes": "Wants it done as soon as possible."},
                      receipt={"operationId": uid(20)})
        for policy in (None, "signup_pitch"):
            line = result_line("service_request", urgent, policy, "Knockout Plumbing")
            self.assertIn("within the next 30 minutes to an hour or so", line)
            self.assertIn("marked it urgent", line)
            # Tom (2026-10-04): no thanks for patience when the caller was not kept waiting.
            self.assertNotIn("patience", line)
            # Once Blake said it is urgent, the save does not say it again.
            again = result_line("service_request", urgent, policy, "Knockout Plumbing", urgent_said=True)
            self.assertNotIn("marked it urgent", again)
            self.assertIn("don't say urgent again", again)
            self.assertIn("within the next 30 minutes to an hour or so", again)
        self.assertNotIn("30 minutes", self.saved(None))
        self.assertIn("usually get back to you within one business day", self.saved(None))

    def test_the_appointment_lookup_needs_the_caller_to_ask_for_it(self):
        from conversation import asks_about_an_appointment
        for text in ("I need to cancel my appointment.", "Can I move my visit to Friday?", "I want to reschedule."):
            self.assertTrue(asks_about_an_appointment([text]), text)
        for text in ("Yes, that's right.", "Newport Beach.", "When works best? Tomorrow morning."):
            self.assertFalse(asks_about_an_appointment([text]), text)

    def test_stopped_not_found_unavailable_and_failed(self):
        self.assertIn("nothing was passed along", result_line("service_request", {"status": "stopped"}, None, "X"))
        # Tom's 2026-10-06 call, replayed: Blake said the manager would get the address later, though it was saved.
        saved = task(status="succeeded", receipt={"operationId": "x" * 20},
                     fields={"notes": "Property: 222 South Long Beach Boulevard.", "propertyCity": "Long Beach"})
        self.assertIn("The address they gave, 222 South Long Beach Boulevard, Long Beach, is saved with it.",
                      result_line("service_request", saved, None, "X"))
        self.assertIn("No appointment was found", result_line("appointment_lookup", task(lookup={"kind": "not_found"}), None, "X"))
        self.assertIn("can't be checked", result_line("appointment_lookup", task(lookup={"kind": "unavailable"}), None, "X"))
        self.assertIn("nothing was passed along", result_line("service_request", {}, None, "X"))


def call_flow(mode="business_demo", **bundle):
    runtime = AsyncMock(); runtime.dispatch.demo_id = uid(1)
    full = {**BUNDLE, "mode": mode, **bundle}
    front_desk = FrontDesk(runtime, full)
    flow = CallFlow(FakeSession(), front_desk, runtime, AsyncMock(), full)
    return flow, runtime, front_desk


class CallFlowWrites(unittest.IsolatedAsyncioTestCase):
    async def test_caller_turns_are_recorded_before_the_reply_with_a_stable_id(self):
        flow, runtime, front_desk = call_flow()
        runtime.caller_turn.return_value = {"callerTurnId": uid(2), "workflowRevision": 4}
        message = SimpleNamespace(id="item_7", text_content="I need my patio cleaned")
        await front_desk.on_user_turn_completed(None, message)
        await front_desk.on_user_turn_completed(None, message)
        first, second = runtime.caller_turn.await_args_list
        self.assertEqual(first.args, second.args)
        self.assertEqual(front_desk.caller_turn_id, uid(2))
        self.assertEqual(flow.workflow_revision, 4)

    async def test_words_heard_while_bob_could_not_be_interrupted_join_the_next_turn(self):
        # Live call, 2026-10-03: "five five five zero one nine nine" arrived during a save and LiveKit dropped it.
        flow, runtime, _ = call_flow()
        heard = lambda text: flow.on_final_transcript(SimpleNamespace(is_final=True, transcript=text))
        heard("My name is Priya, and my number is six five zero")
        await flow.record_caller_turn(SimpleNamespace(id="item_1", text_content="My name is Priya, and my number is six five zero"))
        heard("Five five five zero one nine nine.")
        heard("Yes, that's right.")
        message = SimpleNamespace(id="item_2", text_content="Yes, that's right.", content=["Yes, that's right."])
        await flow.record_caller_turn(message)
        self.assertEqual(message.content, ["Five five five zero one nine nine. Yes, that's right."])
        self.assertEqual(flow.caller_texts[-1], "Five five five zero one nine nine. Yes, that's right.")
        # A turn that holds everything heard is left as it is, and words that arrive after it wait for their own turn.
        heard("It's in Palo Alto,"); heard("I'm home all afternoon.")
        heard("No, that's all.")
        message = SimpleNamespace(id="item_3", text_content="It's in Palo Alto, I'm home all afternoon.", content=["x"])
        await flow.record_caller_turn(message)
        self.assertEqual(message.content, ["x"])
        self.assertEqual(flow.finals, ["No, that's all."])

    async def test_a_failed_caller_turn_never_breaks_the_call(self):
        flow, runtime, front_desk = call_flow()
        runtime.caller_turn.side_effect = RuntimeHttpError(503)
        await flow.record_caller_turn(SimpleNamespace(id="item_8", text_content="hello"))
        self.assertEqual(runtime.caller_turn.await_count, 2)
        self.assertEqual(front_desk.caller_turn_id, "")

    async def test_the_same_record_in_the_same_turn_reuses_its_operation_id(self):
        flow, runtime, front_desk = call_flow()
        front_desk.caller_turn_id = uid(2); flow.current_task = task()
        runtime.task.return_value = {"workflowRevision": 2, "task": task(), "accepted": {}, "rejected": {}}
        await flow.record({"callerName": "Maria"}); await flow.record({"callerName": "Maria"}); await flow.record({"callerName": "Mara"})
        ids = [call.args[0]["operationId"] for call in runtime.task.await_args_list]
        self.assertEqual(ids[0], ids[1])
        self.assertNotEqual(ids[0], ids[2])
        command = runtime.task.await_args.args[0]
        self.assertEqual((command["action"], command["taskId"], command["callerTurnId"]), ("record", uid(10), uid(2)))
        self.assertNotIn("expectedWorkflowRevision", command)

    async def test_an_unknown_outcome_is_retried_once_with_the_same_command_but_a_rejection_is_not(self):
        flow, runtime, front_desk = call_flow()
        front_desk.caller_turn_id = uid(2); flow.current_task = task()
        ok = {"workflowRevision": 2, "task": task(status="succeeded", receipt={"operationId": uid(20)})}
        runtime.task.side_effect = [RuntimeContractError("timeout"), ok]
        await flow.record({"propertyCity": "Tustin"})
        first, second = runtime.task.await_args_list
        self.assertEqual(first.args, second.args)
        self.assertTrue(flow.has_receipt)
        runtime.task.reset_mock(); runtime.task.side_effect = RuntimeHttpError(409)
        with self.assertRaises(RuntimeHttpError):
            await flow.record({"propertyCity": "Irvine"})
        self.assertEqual(runtime.task.await_count, 1)

    async def test_a_task_needs_a_recorded_caller_turn_and_a_failed_start_is_truthful(self):
        flow, runtime, front_desk = call_flow()
        self.assertIn("did not run", await flow.run_task(front_desk, "service_request", "patio"))
        front_desk.caller_turn_id = uid(2)
        runtime.task.side_effect = RuntimeHttpError(400)
        self.assertIn("nothing was passed along", await flow.run_task(front_desk, "service_request", "patio"))

    async def test_end_call_hands_the_goodbye_to_the_application_once(self):
        flow, runtime, front_desk = call_flow()
        flow.end_for_turn = AsyncMock()
        flow.caller_texts = ["No, that's all, thanks."]
        result = flow.end_call("caller_ended")
        flow.end_call("caller_ended")
        await asyncio.sleep(0)
        self.assertIsInstance(result, ToolResult)
        self.assertFalse(result.reply_required)
        flow.end_for_turn.assert_awaited_once_with("caller_ended")


class EndingGuard(unittest.IsolatedAsyncioTestCase):
    """VCF fix 1: a concern about past work never ends the call; only the caller's own goodbye does."""

    CONCERN = ["Well, kind of, yes, um Also like I lost, like I heard from a friend that you guys Uh, last time when you cleaned "
               "there probably, you didn't clean Like some parts and it wasn't well received. So like, how can you ensure that like",
               "My probably, my friend probably not gonna have the same issue."]

    async def test_a_concern_about_past_work_never_ends_the_call(self):
        flow, _, front_desk = call_flow()
        flow.end_for_turn = AsyncMock()
        flow.caller_texts = list(self.CONCERN)
        reply = await front_desk.end_call(Context(), "caller_ended")
        await asyncio.sleep(0)
        self.assertIsInstance(reply, str)
        self.assertIn("did not run", reply)
        self.assertIn("acknowledge it in one sentence and offer to pass it to the manager", reply)
        self.assertFalse(flow.ending_requested)
        flow.end_for_turn.assert_not_awaited()

    async def test_the_intake_end_call_takes_the_same_guard(self):
        flow, _, _ = call_flow()
        flow.end_for_turn = AsyncMock()
        flow.caller_texts = list(self.CONCERN)
        intake = ServiceRequestTask(flow, task(), None)
        self.assertIn("did not run", await intake.end_call(Context(), "caller_ended"))
        self.assertFalse(flow.ending_requested)

    def test_only_clear_goodbyes_count_as_done(self):
        for words in ("No, that's all, thanks.", "No, I'm good. Thank you.", "No, that's it.", "Okay, bye!", "No thanks.", "Nope.",
                      "That’s all I needed.", "no that's okay", "No, I don't think so.", "I'm all good, bye."):
            self.assertTrue(conversation.caller_is_done(words), words)
        for words in (*self.CONCERN, "No, I guess like what is the next step?", "Oh, yes. But you didn't answer my question.",
                      "Why were you pass the information? Just give me to the owner.", "Is that it?", "No. So, four oh eight.", "",
                      "Can you take care of the trash area", "No thanks, but how do you clean", "Okay.", "Thank you.",
                      "That's it for the plaza, but I also have a house", "I'm good with Tuesday but the price is high"):
            self.assertFalse(conversation.caller_is_done(words), words)

    def test_contact_details_belong_to_the_request_step(self):
        # Tom's 2026-10-06 call: Blake took the name and number itself, with no request started.
        for text in ("My name is Sarah Blakely.", "And phone number is one five six two eight six seven zero nine nine zero."):
            self.assertTrue(conversation.gives_contact(text), text)
        for text in ("Yeah, that sounds good.", "It's 2201 Senter Road.", "I have a commercial retail property."):
            self.assertFalse(conversation.gives_contact(text), text)
        self.assertTrue(conversation.asks_contact("I’ll get a service request started. Can I have your name and phone number?"))
        for reply in ("What kind of property is it?", "Would that work for you?", "We do pressure washing. Want me to pass that along?"):
            self.assertFalse(conversation.asks_contact(reply), reply)
        self.assertTrue(conversation.is_unconfirmed_claim("Got it. I'm passing your request to the manager now."))
        self.assertFalse(conversation.is_unconfirmed_claim("I'll pass your request along to the manager."))

    async def test_a_cut_off_turn_never_ends_the_call_as_blocking(self):
        # Magnus's call, 2026-10-06: "It'll" ended the call as blocking_unknown before he could give the address.
        flow, _, _ = call_flow()
        flow.end_for_turn = AsyncMock()
        flow.caller_texts = ["It'll"]
        self.assertEqual(flow.end_call("blocking_unknown"), conversation.KEEP_GOING)
        await asyncio.sleep(0)
        flow.end_for_turn.assert_not_awaited()
        flow.caller_texts = ["Then forget it, I need to know the price first."]
        self.assertNotEqual(flow.end_call("blocking_unknown"), conversation.KEEP_GOING)

    async def test_a_person_request_never_ends_the_call(self):
        flow, _, _ = call_flow()
        flow.end_for_turn = AsyncMock()
        flow.caller_texts = ["Can I talk to a real person?"]
        self.assertEqual(flow.end_call("human_preference"), conversation.PERSON_KEEPS_CALL)
        await asyncio.sleep(0)
        flow.end_for_turn.assert_not_awaited()
        self.assertFalse(flow.ending_requested)


class OfferFirst(unittest.TestCase):
    """Asking whether the business can help is answered with an offer, not a request started in the same turn."""

    def test_a_can_you_help_question_is_not_a_yes(self):
        self.assertTrue(conversation.only_asks_if_we_help(
            "And um, he needs some cleaning in front of each of the store within that plaza as well as around the trash area. "
            "Can you help me with that?"))
        self.assertTrue(conversation.only_asks_if_we_help("Do you guys clean dumpster pads?"))
        self.assertFalse(conversation.only_asks_if_we_help("Yeah, can you pass that along?"))
        self.assertFalse(conversation.only_asks_if_we_help("Can you help? My name is Tom and my number is 408 555 0153."))
        self.assertFalse(conversation.only_asks_if_we_help("Uh, sure, um"))
        self.assertFalse(conversation.only_asks_if_we_help("I need my gutters cleaned."))


class OpeningLine(unittest.IsolatedAsyncioTestCase):
    """A new service request opens by telling the caller what happens next, before it asks for anything."""

    async def opening(self, intake):
        session = MagicMock()
        with patch.object(type(intake), "session", new=property(lambda _: session)):
            await intake.on_enter()
        return session.generate_reply.call_args.kwargs["instructions"]

    async def test_a_new_service_request_says_the_owner_will_take_it_from_there(self):
        line = await self.opening(ServiceRequestTask(FakeFlow(), task(), None))
        self.assertIn(intake_module.NEXT_STEPS, line)
        self.assertIn("In terms of next steps, I'll pass your request along to the manager", line)
        self.assertIn("can I get a contact name and number?", line)

    async def test_the_first_ask_of_a_new_request_says_the_next_step_once(self):
        flow = FakeFlow({"accepted": {"serviceNeed": "patio"}, "rejected": {}, "task": task(fields={"serviceNeed": "patio"})},
                        {"accepted": {"callerName": "Ana"}, "rejected": {}, "task": task(fields={"serviceNeed": "patio", "callerName": "Ana"})})
        intake = ServiceRequestTask(flow, task(), None)
        first = await intake.record_details(Context(), service="patio")
        self.assertIn("Next: first tell them the next step", first)
        self.assertIn("then ask for their name and phone number together.", first)
        second = await intake.record_details(Context(), name="Ana")
        self.assertNotIn("next step", second)
        self.assertTrue(ServiceRequestTask(FakeFlow(), task(), None, editing=True).told_next_step)

    async def test_a_change_or_a_complaint_does_not(self):
        for intake in (ServiceRequestTask(FakeFlow(), task(), None, editing=True), ComplaintTask(FakeFlow(), task("complaint"), None)):
            self.assertNotIn(intake_module.NEXT_STEPS, await self.opening(intake))


class LookupForTheModel(unittest.TestCase):
    """The model reads only the start of a lookup, so every fact fits before any long website passage."""

    def test_an_owner_answer_after_many_long_website_facts_is_still_read(self):
        website = [{"factId": f"site-{n}", "group": "services", "value": f"Commercial cleaning service {n}", "passageIds": [f"p{n}"],
                    "eligibilityReason": "Quoted from the website." * 5, "confidenceEvidence": {"explanation": "x" * 300}}
                   for n in range(12)]
        owner = {"factId": "owner-1", "group": "faq", "value": "How our process works: a worker checks the area first.",
                 "passageIds": ["p-owner"]}
        result = {"status": "supported", "facts": website + [owner],
                  "passages": [{"passageId": f"p{n}", "text": "Commercial cleaning " * 200} for n in range(12)]}
        self.assertNotIn("a worker checks the area", json.dumps(result)[:6000])
        text = conversation.for_the_model(result)
        self.assertLessEqual(len(text), conversation.LOOKUP_CHARS)
        self.assertIn("a worker checks the area first", text)
        self.assertIn('"factId": "owner-1"', text)
        self.assertIn("Commercial cleaning", text.split('"passages"')[1])

    def test_a_result_without_facts_is_left_as_it_is(self):
        self.assertEqual(conversation.for_the_model({"services": []}), '{"services": []}')


class HowItWorks(unittest.IsolatedAsyncioTestCase):
    """A question about how the work is done is answered from the business's knowledge, looked up first (2026-10-01 call)."""

    async def settings_for(self, text, mode="business_demo", tool_names=("lookup_business_fact", "list_services")):
        flow, _, front_desk = call_flow(mode=mode)
        seen = []
        async def fake_llm(agent, chat_ctx, tools, model_settings):
            seen.append(model_settings)
            yield "Sure. "
        tools = [SimpleNamespace(info=SimpleNamespace(name=name)) for name in tool_names]
        last = SimpleNamespace(type="message", role="user", text_content=text)
        original = Agent.default.llm_node
        Agent.default.llm_node = fake_llm
        try:
            [out async for out in flow.guarded_llm_node(front_desk, SimpleNamespace(items=[last]), tools, None)]
        finally:
            Agent.default.llm_node = original
        return seen[0]

    async def test_a_process_question_looks_the_business_up_first(self):
        for text in ("Can you tell me more about how the process looked like?", "How are you guys gonna clean this property?",
                     "Okay. And how do you guys usually clean it?", "How do you normally handle a dumpster pad?"):
            self.assertIs(await self.settings_for(text), conversation.LOOKUP_FIRST, text)
        self.assertEqual(conversation.LOOKUP_FIRST.tool_choice["function"]["name"], "lookup_business_fact")

    async def test_other_turns_are_left_to_the_model(self):
        self.assertIsNone(await self.settings_for("How are you?"))
        self.assertIsNone(await self.settings_for("What are your hours?"))
        self.assertIsNone(await self.settings_for("How does the process work?", tool_names=("end_call",)))


class ClosingWords(unittest.TestCase):
    """The way Tom ends a call counts as done; a bare "sounds good" does not."""

    def test_goodbyes_from_the_test_calls(self):
        for text in ("Okay, sounds good. I guess like that's all I need. Thank you.", "Very cool. Uh, I think that's about it.",
                     "I guess that's all I need to know.", "Very cool. I guess that's all I wanted to ask."):
            self.assertTrue(conversation.caller_is_done(text), text)
        for text in ("Sounds good.", "Okay, thanks.", "I think so", "Sounds good, but how do you clean it?"):
            self.assertFalse(conversation.caller_is_done(text), text)


class ServiceOffer(unittest.IsolatedAsyncioTestCase):
    """Before any request, the service list tells Bob to name what fits and ask if they're interested (Tom, 2026-10-01)."""

    async def test_the_service_list_carries_the_offer_only_before_a_request(self):
        flow, runtime, front_desk = call_flow()
        runtime.list_services.return_value = {"services": [{"serviceId": "svc-1", "name": "Dumpster pad cleaning"}]}
        listed = await front_desk.list_services(Context())
        self.assertIn("Dumpster pad cleaning", listed)
        self.assertTrue(listed.endswith(conversation.OFFER_SERVICES))
        self.assertIn("ask if that would work for them", listed)
        flow.saved_request = OneRequestPerNeed.SAVED
        self.assertNotIn(conversation.OFFER_SERVICES, await front_desk.list_services(Context()))


class OneRequestPerNeed(unittest.IsolatedAsyncioTestCase):
    """VCF fix 2: once a request is saved, "give me to the owner" adds no second request and no repeat offer."""

    SAVED = task(status="succeeded", goal="Cleaning storefront walkways and the dumpster area at a commercial plaza",
                 fields={"callerName": "Tom Lam", "contactPhone": "(408) 555-0153", "phoneConfirmed": True,
                         "serviceNeed": "storefront walkway and dumpster pad cleaning at a commercial plaza",
                         "propertyCity": "Irvine", "propertyState": "California"},
                 receipt={"operationId": uid(20), "outcome": "saved"})

    def saved_flow(self):
        flow, runtime, front_desk = call_flow(mode="owner_test")
        front_desk.caller_turn_id = uid(2)
        flow.saved_request, flow.current_task = self.SAVED, self.SAVED
        return flow, runtime, front_desk

    async def with_tasks(self, coro, **fakes):
        original = conversation.TASKS
        conversation.TASKS = {**original, **fakes}
        try:
            return await coro
        finally:
            conversation.TASKS = original

    async def test_the_same_need_again_reopens_the_saved_request_instead_of_a_duplicate(self):
        flow, runtime, front_desk = self.saved_flow()
        flow.caller_texts = ["Actually the plaza is in Tustin, not Irvine."]
        opened = []
        async def fake_task(flow_, task_, chat_ctx, editing=False):
            opened.append((task_, editing))
            return {**task_, "fields": {**task_["fields"], "propertyCity": "Tustin"}}
        reply = await self.with_tasks(front_desk.start_service_request(Context(), "Commercial plaza cleaning in Tustin"),
                                      service_request=fake_task)
        self.assertEqual(reply, conversation.CHANGED)
        self.assertEqual(opened, [(self.SAVED, True)])
        runtime.task.assert_not_awaited()
        self.assertEqual(flow.saved_request["fields"]["propertyCity"], "Tustin")

    async def test_a_yes_to_a_spelling_after_the_save_is_never_a_second_request(self):
        # Harness, third plaza call: "Yes, that's right." to "Is that D-A, V-I-E-N?" started a second request named by the
        # property, which shared no job words with the saved one.
        flow, runtime, front_desk = self.saved_flow()
        flow.caller_texts = ["Yeah, so the property is called Dog bin, uh, D-A V I E N. It's like a coffee shop, in Los Angeles.",
                             "Yes, that's right."]
        opened = []
        async def fake_task(flow_, task_, chat_ctx, editing=False):
            opened.append(editing)
            return {"status": "unchanged"}
        goal = "Follow up details for cleaning service at Dog Bin coffee shop, spelled D-A, V-I-E-N, in Los Angeles."
        flow.replies = ["Just to make sure, is that D-A, V-I-E-N?"]
        await self.with_tasks(front_desk.start_service_request(Context(), goal), service_request=fake_task)
        self.assertEqual(opened, [True])
        runtime.task.assert_not_awaited()

    async def test_a_yes_to_an_offer_to_pass_another_job_along_is_a_new_request(self):
        flow, runtime, front_desk = self.saved_flow()
        flow.caller_texts = ["Oh, my house gutters are clogged too.", "Yes."]
        flow.replies = ["Want me to pass the gutter cleaning along to the manager as well?"]
        runtime.task.side_effect = RuntimeHttpError(400)
        self.assertIn("nothing was passed along", await front_desk.start_service_request(Context(), "Gutter cleaning at a house"))
        self.assertEqual(runtime.task.await_args.args[0]["action"], "start")

    def test_a_bare_answer_is_only_a_yes_or_no(self):
        for text in ("Yes, that's right.", "Yes.", "Yeah, correct.", "No.", "Yep, that is it!"):
            self.assertTrue(conversation.is_bare_answer(text), text)
        for text in ("Yes, and I need my gutters cleaned too.", "Yeah, my other plaza in Tustin.", "No, it's in Irvine.", ""):
            self.assertFalse(conversation.is_bare_answer(text), text)

    async def test_change_request_reopens_the_saved_request_and_backing_out_changes_nothing(self):
        flow, runtime, front_desk = self.saved_flow()
        async def backs_out(flow_, task_, chat_ctx, editing=False):
            return {"status": "unchanged"}
        reply = await self.with_tasks(front_desk.change_request(Context(), "Add the street address"), service_request=backs_out)
        self.assertEqual(reply, conversation.UNCHANGED)
        self.assertIs(flow.saved_request, self.SAVED)
        flow.saved_request = None
        self.assertEqual(await front_desk.change_request(Context(), "Change the city"), conversation.NO_SAVED_REQUEST)

    async def test_change_request_is_offered_only_after_a_save_from_a_later_turn(self):
        flow, runtime, front_desk = call_flow(mode="owner_test")
        names = lambda: {tool.info.name for tool in front_desk.tools}
        await front_desk.configure_tools()
        self.assertNotIn("change_request", names())
        flow.saved_request, flow.saved_turn_id, front_desk.caller_turn_id = self.SAVED, uid(2), uid(2)
        await front_desk.configure_tools()
        self.assertNotIn("change_request", names())
        front_desk.caller_turn_id = uid(3)
        await front_desk.configure_tools()
        self.assertIn("change_request", names())

    async def test_no_change_runs_in_the_turn_that_saved_the_request(self):
        flow, runtime, front_desk = self.saved_flow()
        flow.saved_turn_id = front_desk.caller_turn_id
        self.assertEqual(await front_desk.change_request(Context(), "The driveway is in Newport Beach"), conversation.SAVED_THIS_TURN)
        runtime.task.assert_not_awaited()

    async def test_another_property_is_its_own_request_and_starts_with_the_confirmed_contact(self):
        flow, runtime, front_desk = self.saved_flow()
        flow.caller_texts = ["Yes please, and I need my other plaza in Tustin done too."]
        started = task()
        carried = task(fields={"callerName": "Tom Lam", "contactPhone": "(408) 555-0153", "phoneConfirmed": True})
        runtime.task.side_effect = [{"workflowRevision": 3, "task": started},
                                    {"workflowRevision": 4, "task": carried, "accepted": {}, "rejected": {}}]
        async def fake_task(flow_, task_, chat_ctx, editing=False):
            self.assertFalse(editing)
            return task(status="succeeded", fields=task_["fields"], receipt={"operationId": uid(22)})
        reply = await self.with_tasks(front_desk.start_service_request(Context(), "Plaza cleaning at a second plaza in Tustin"),
                                      service_request=fake_task)
        self.assertEqual(runtime.task.await_args_list[0].args[0]["action"], "start")
        self.assertEqual(runtime.task.await_args_list[1].args[0]["fields"],
                         {"callerName": "Tom Lam", "contactPhone": "(408) 555-0153", "phoneConfirmed": True})
        self.assertIn("The request is saved", reply)
        self.assertTrue(conversation.names_another_property(["my other plaza"]))
        self.assertFalse(conversation.names_another_property(["the plaza is in Tustin"]))

    async def test_a_new_need_is_still_a_new_request(self):
        flow, runtime, front_desk = self.saved_flow()
        flow.caller_texts = ["Oh, and I also need my gutters cleaned at my house."]
        runtime.task.side_effect = RuntimeHttpError(400)
        self.assertIn("nothing was passed along", await front_desk.start_service_request(Context(), "Gutter cleaning at a house"))
        self.assertEqual(runtime.task.await_args.args[0]["action"], "start")
        self.assertTrue(conversation.is_same_need(self.SAVED, "Another plaza cleaning"))
        self.assertTrue(conversation.is_same_need(self.SAVED, "Pass the caller's details to the owner"))
        self.assertFalse(conversation.is_same_need(self.SAVED, "House window washing"))

    async def test_a_complaint_after_the_save_starts_with_the_confirmed_contact(self):
        flow, runtime, front_desk = self.saved_flow()
        flow.caller_texts = ["Yes, please pass that concern along."]
        started = task("complaint")
        carried = task("complaint", fields={"callerName": "Tom Lam", "contactPhone": "(408) 555-0153", "phoneConfirmed": True})
        runtime.task.side_effect = [{"workflowRevision": 3, "task": started},
                                    {"workflowRevision": 4, "task": carried, "accepted": {}, "rejected": {}}]
        opened = []
        async def fake_task(flow_, task_, chat_ctx):
            opened.append(task_)
            return task("complaint", "succeeded", receipt={"operationId": uid(21)})
        original = conversation.TASKS
        conversation.TASKS = {**original, "complaint": fake_task}
        try:
            reply = await front_desk.report_complaint(Context(), "Worried parts of the plaza were missed last time")
        finally:
            conversation.TASKS = original
        record = runtime.task.await_args_list[1].args[0]
        self.assertEqual(record["action"], "record")
        self.assertEqual(record["fields"], {"callerName": "Tom Lam", "contactPhone": "(408) 555-0153", "phoneConfirmed": True})
        self.assertEqual(opened[0]["fields"]["callerName"], "Tom Lam")
        self.assertIn("complaint is recorded", reply)

    def test_no_offer_to_pass_along_what_is_already_with_the_owner(self):
        flow, _, _ = self.saved_flow()
        flow.caller_texts = ["Can you tell me how you are going to clean this property?"]
        self.assertTrue(flow.offers_to_pass_again("Want me to pass that info to the owner, or is there something else you want to know?"))
        self.assertFalse(flow.offers_to_pass_again("Want me to pass that concern to the owner?"))
        flow.caller_texts = ["Last time you didn't clean some parts. How can you ensure that?"]
        self.assertFalse(flow.offers_to_pass_again("Want me to pass that along to the owner?"))
        flow.caller_texts = ["Oh, and my house needs its windows washed too."]
        self.assertFalse(flow.offers_to_pass_again("Want me to pass the window washing along to the owner?"))
        flow.saved_request = None
        self.assertFalse(flow.offers_to_pass_again("Want me to pass your details along to the owner?"))

    def test_the_saved_result_says_not_to_offer_again(self):
        self.assertIn("Don't offer to pass it along again", result_line("service_request", self.SAVED, "test_summary", "X"))


class WantsItSoon(unittest.IsolatedAsyncioTestCase):
    """A caller who needs the work soon gets that noted on their request, so "I'll make sure the owner knows" is true."""

    SAVED = OneRequestPerNeed.SAVED

    def test_what_counts_as_soon(self):
        for text in ("I need to get this done as soon as possible?", "It's urgent.", "Can someone come out ASAP?",
                     "I need it done today."):
            self.assertTrue(intake_module.wants_it_soon([text]), text)
        for text in ("I'm calling today about my driveway.", "It's not urgent at all.", "It isn't urgent.", "When will I hear back?"):
            self.assertFalse(intake_module.wants_it_soon([text]), text)

    def test_the_note_reads_back_with_the_other_parts(self):
        parts = {"person": "Mike", "property": "Westpark Plaza", "soon": "yes", "owner": "yes"}
        notes = notes_text(parts)
        self.assertEqual(notes, "Calling for Mike. Property: Westpark Plaza. Wants it done as soon as possible. "
                                "Asked to talk to the owner.")
        self.assertEqual(note_parts(notes).keys(), parts.keys())
        self.assertEqual(note_parts(notes)["property"], "Westpark Plaza")

    async def test_after_a_save_the_note_goes_on_the_saved_request_once(self):
        flow, runtime, front_desk = call_flow(mode="owner_test")
        front_desk.caller_turn_id = uid(2)
        flow.saved_request = self.SAVED
        flow.caller_texts = ["Do you have an estimate, because I need to get this done as soon as possible?"]
        noted = {**self.SAVED, "fields": {**self.SAVED["fields"], "notes": intake_module.WANTS_IT_SOON}}
        runtime.task.return_value = {"workflowRevision": 5, "task": noted, "accepted": {}, "rejected": {}}
        await flow.note_wants_it_soon()
        command = runtime.task.await_args.args[0]
        self.assertEqual((command["action"], command["taskId"], command["fields"]),
                         ("record", self.SAVED["taskId"], {"notes": "Wants it done as soon as possible."}))
        self.assertEqual(flow.saved_request["fields"]["notes"], intake_module.WANTS_IT_SOON)
        runtime.task.reset_mock()
        await flow.note_wants_it_soon()
        runtime.task.assert_not_awaited()

    async def test_nothing_is_written_without_a_saved_request_or_an_ask(self):
        flow, runtime, _ = call_flow(mode="owner_test")
        flow.caller_texts = ["I need it as soon as possible."]
        await flow.note_wants_it_soon()
        flow.saved_request = self.SAVED
        flow.caller_texts = ["When will I hear back?"]
        await flow.note_wants_it_soon()
        runtime.task.assert_not_awaited()

    async def test_the_caller_turn_itself_writes_the_note_but_not_over_another_open_request(self):
        flow, runtime, _ = call_flow(mode="owner_test")
        runtime.caller_turn.return_value = {"callerTurnId": uid(2), "workflowRevision": 4}
        noted = {**self.SAVED, "fields": {**self.SAVED["fields"], "notes": intake_module.WANTS_IT_SOON}}
        runtime.task.return_value = {"workflowRevision": 5, "task": noted, "accepted": {}, "rejected": {}}
        flow.saved_request = self.SAVED
        flow.current_task = task(fields={"serviceNeed": "gutters"})
        await flow.record_caller_turn(SimpleNamespace(id="item_1", text_content="I need it as soon as possible."))
        runtime.task.assert_not_awaited()
        flow.current_task = self.SAVED
        await flow.record_caller_turn(SimpleNamespace(id="item_2", text_content="I need it as soon as possible."))
        self.assertEqual(runtime.task.await_args.args[0]["fields"], {"notes": "Wants it done as soon as possible."})

    async def test_a_request_being_taken_carries_the_note(self):
        intake_flow = FakeFlow({"accepted": {}, "rejected": {}, "task": task(fields={"callerName": "Lee"})})
        intake_flow.caller_texts = ["I need my windows washed, it's urgent."]
        intake = ServiceRequestTask(intake_flow, task(), None)
        await intake.record_details(Context(), name="Lee")
        self.assertEqual(intake_flow.records, [{"callerName": "Lee", "notes": "Available: the earliest time someone can come. "
                                                                          "Wants it done as soon as possible."}])

    async def test_asking_for_someone_right_now_means_the_earliest_time(self):
        # Tom, 2026-10-03: "can you get someone here right now" or "ASAP" means the earliest time anyone can come.
        for words in ("Yeah, like can you get someone here like ASAP?", "Can you send someone out right now?",
                      "I need a plumber here today.", "Can you come out immediately?"):
            self.assertTrue(intake_module.wants_it_soon([words]), words)
            fields = {"serviceNeed": "leak", "notes": "Available: the earliest time someone can come."}
            self.assertNotIn("when works best", intake_module.next_step("service_request", fields).lower())
        for words in ("It's leaking right now.", "Is someone there now?", "I'm home now."):
            self.assertFalse(intake_module.wants_it_soon([words]), words)


class OwnerRequest(unittest.IsolatedAsyncioTestCase):
    """Asking for a person keeps the call open, and the owner gets a note to call back."""

    SAVED = OneRequestPerNeed.SAVED

    async def test_after_a_save_the_note_goes_on_the_saved_request(self):
        flow, runtime, front_desk = call_flow(mode="owner_test")
        front_desk.caller_turn_id = uid(2)
        flow.saved_request = flow.current_task = self.SAVED
        flow.caller_texts = ["Why were you pass the information? Just give me to the owner."]
        noted = {**self.SAVED, "fields": {**self.SAVED["fields"], "notes": "Asked to talk to the owner."}}
        runtime.task.return_value = {"workflowRevision": 5, "task": noted, "accepted": {}, "rejected": {}}
        reply = await front_desk.ask_for_owner(Context())
        command = runtime.task.await_args.args[0]
        self.assertEqual((command["action"], command["taskId"], command["fields"]),
                         ("record", self.SAVED["taskId"], {"notes": "Asked to talk to the owner."}))
        self.assertEqual(reply, conversation.OWNER_NOTED)
        self.assertIn("nobody can come to the phone right now", reply)
        self.assertIn("sorry for the inconvenience", reply)
        self.assertEqual(flow.saved_request["fields"]["notes"], "Asked to talk to the owner.")
        self.assertFalse(flow.ending_requested)
        # A second ask writes nothing new.
        runtime.task.reset_mock()
        await front_desk.ask_for_owner(Context())
        runtime.task.assert_not_awaited()

    async def test_without_a_request_bob_offers_to_take_their_details_and_the_request_carries_the_note(self):
        flow, runtime, front_desk = call_flow(mode="owner_test")
        flow.caller_texts = ["Can I talk to a person?"]
        self.assertEqual(await front_desk.ask_for_owner(Context()), conversation.OWNER_NEEDS_CONTACT)
        runtime.task.assert_not_awaited()
        self.assertTrue(flow.asked_for_owner)
        intake_flow = FakeFlow({"accepted": {}, "rejected": {}, "task": task(fields={"callerName": "Lee"})})
        intake_flow.asked_for_owner = True
        intake = ServiceRequestTask(intake_flow, task(), None)
        await intake.record_details(Context(), name="Lee")
        self.assertEqual(intake_flow.records, [{"callerName": "Lee", "notes": "Asked to talk to the owner."}])

    async def test_during_a_request_the_note_is_added_and_intake_goes_on(self):
        flow, runtime, front_desk = call_flow(mode="owner_test")
        front_desk.caller_turn_id = uid(2)
        open_task = task(fields={"serviceNeed": "window washing", "notes": "Property: Westpark Plaza."})
        flow.current_task = open_task
        flow.caller_texts = ["Actually, can I just talk to a real person?"]
        noted = task(fields={**open_task["fields"], "notes": "Property: Westpark Plaza. Asked to talk to the owner."})
        runtime.task.return_value = {"workflowRevision": 5, "task": noted, "accepted": {}, "rejected": {}}
        intake = ServiceRequestTask(flow, open_task, None)
        reply = await intake.ask_for_owner(Context())
        self.assertEqual(runtime.task.await_args.args[0]["fields"], {"notes": "Property: Westpark Plaza. Asked to talk to the owner."})
        self.assertIn("nobody can come to the phone right now", reply)
        self.assertIn("Then: ask for their name and phone number together.", reply)
        self.assertEqual(intake.someone.get("owner"), "yes")

    async def test_a_question_the_owner_could_answer_is_not_a_request_for_the_owner(self):
        flow, runtime, front_desk = call_flow(mode="owner_test")
        flow.caller_texts = ["How are you guys gonna clean this property?"]
        self.assertEqual(await front_desk.ask_for_owner(Context()), conversation.NO_PERSON_ASKED)
        self.assertFalse(flow.asked_for_owner)
        runtime.task.assert_not_awaited()

    def test_notes_keep_the_person_property_and_owner_request(self):
        notes = "Calling for Mike. Property: 12 St. Mark Plaza. Asked to talk to the owner."
        self.assertEqual(note_parts(notes), {"person": "Mike", "property": "12 St. Mark Plaza", "owner": "Asked to talk to the owner."})
        self.assertEqual(notes_text(note_parts(notes)), notes)
        self.assertEqual(note_parts("Property: 12 St. Mark Plaza."), {"property": "12 St. Mark Plaza"})

    def test_the_prompts_and_tools_agree_that_a_person_request_keeps_the_call(self):
        self.assertNotIn("person or reports danger, call end_call", prompts.persona(BUNDLE))
        self.assertIn("call ask_for_owner", prompts.persona(BUNDLE))
        import intake as intake_module
        for module in (conversation, intake_module):
            reasons = re.findall(r"async def end_call\(self, context: RunContext,\s*reason: Literal\[([^\]]*)\]", inspect.getsource(module))
            self.assertTrue(reasons)
            for literal in reasons:
                self.assertNotIn("human_preference", literal)


class ChangingASavedRequest(unittest.IsolatedAsyncioTestCase):
    """A saved request stays open to changes until the call ends."""

    SAVED_FIELDS = {"callerName": "Maria", "serviceNeed": "driveway washing", "contactPhone": "(408) 555-2147",
                    "phoneConfirmed": True, "propertyCity": "Irvine", "propertyState": "California"}

    def saved(self, **fields):
        return task(status="succeeded", fields={**self.SAVED_FIELDS, **fields}, receipt={"operationId": uid(20)})

    async def test_a_change_is_recorded_and_completes_the_edit(self):
        changed = self.saved(notes="Property: 12 Main Street.")
        flow = FakeFlow({"accepted": {"notes": "Property: 12 Main Street."}, "rejected": {}, "task": changed})
        flow.caller_texts = ["Oh, the exact address is twelve Main Street."]
        intake = ServiceRequestTask(flow, self.saved(), None, editing=True)
        self.assertIsNone(await intake.record_details(Context(), property_name="12 Main Street"))
        self.assertEqual(flow.records, [{"notes": "Property: 12 Main Street."}])
        self.assertTrue(intake.done())

    async def test_a_change_sends_only_what_differs_from_the_saved_request(self):
        changed = self.saved(propertyCity="Tustin")
        flow = FakeFlow({"accepted": {"propertyCity": "Tustin"}, "rejected": {}, "task": changed}, state="California")
        flow.caller_texts = ["Maria again, 408 555 2147, and it's in Tustin, California, not Irvine."]
        intake = ServiceRequestTask(flow, self.saved(), None, editing=True)
        await intake.record_details(Context(), name="maria", phone="4085552147", service="driveway washing", city="Tustin",
                                    state="California", phone_confirmed=True)
        self.assertEqual(flow.records, [{"propertyCity": "Tustin", "propertyState": "California"}])

    async def test_a_new_city_keeps_its_state_even_when_the_state_is_unchanged(self):
        changed = self.saved(propertyCity="Tustin")
        flow = FakeFlow({"accepted": {"propertyCity": "Tustin", "propertyState": "California"}, "rejected": {}, "task": changed})
        flow.caller_texts = ["It's in Irvine, California.", "Sorry, it's actually Tustin, not Irvine."]
        intake = ServiceRequestTask(flow, self.saved(), None, editing=True)
        await intake.record_details(Context(), city="Tustin", state="California")
        self.assertEqual(flow.records, [{"propertyCity": "Tustin", "propertyState": "California"}])

    async def test_a_new_number_is_read_back_before_the_edit_completes(self):
        unconfirmed = {**self.saved(contactPhone="(714) 555-2368"), "missingFields": ["phoneConfirmed"]}
        unconfirmed["fields"].pop("phoneConfirmed")
        flow = FakeFlow({"accepted": {"contactPhone": "(714) 555-2368"}, "rejected": {}, "task": unconfirmed})
        flow.caller_texts = ["Use my cell instead, seven one four, five five five, two three six eight."]
        intake = ServiceRequestTask(flow, self.saved(), None, editing=True)
        reply = await intake.record_details(Context(), phone="714 555 2368")
        self.assertIn('read the number back as "seven one four, five five five, two three six eight"', reply)
        self.assertFalse(intake.done())

    async def test_nothing_to_change_asks_what_to_change_and_backing_out_cancels_nothing(self):
        flow = FakeFlow()
        flow.caller_texts = ["Hmm, actually never mind."]
        intake = ServiceRequestTask(flow, self.saved(), None, editing=True)
        self.assertIn("ask what they would like to change", await intake.record_details(Context()))
        await intake.stop_request(Context())
        self.assertEqual(flow.cancelled, 0)
        self.assertTrue(intake.done())


class FactsOnly(unittest.IsolatedAsyncioTestCase):
    """VCF fix 3: how the work is done comes only from business sources, and every lookup leaves a checkable log line."""

    HOT = "We use high-temperature pressure washing that cleans hot to break down grease, gum, and stains without spreading them."
    STEAM = "Bayside Power Washing uses steam cleaning and pressure washing for commercial plazas."

    def test_a_method_no_source_names_is_unsourced(self):
        sourced = '{"facts": [{"value": "Storefront walkway cleaning"}, {"value": "Dumpster pad cleaning"}]}'
        self.assertTrue(conversation.unsourced_method(self.HOT, sourced))
        self.assertTrue(conversation.unsourced_method(self.STEAM, sourced))
        self.assertFalse(conversation.unsourced_method("We clean storefront walkways and dumpster pads.", sourced))
        self.assertFalse(conversation.unsourced_method("We can clean the recycling area and any hot spots by the bins.", sourced))
        self.assertFalse(conversation.unsourced_method(self.HOT, sourced + ' "We use hot water to lift grease"'))
        for sentence in ("Is it a central AC or a heat pump?", "Sorry you're dealing with this heat."):
            self.assertFalse(conversation.unsourced_method(sentence, sourced), sentence)
        self.assertTrue(conversation.unsourced_method("We use heated water on the walkways.", sourced))

    async def test_an_unsourced_method_is_replaced_by_the_owner_explaining(self):
        replies = await StreamedReplies.spoken(self, self.HOT + " ", "Anything else?")
        self.assertEqual(replies, [conversation.OWNER_EXPLAINS + " ", "Anything else?"])
        replies = await StreamedReplies.spoken(self, self.STEAM + " ", self.HOT)
        self.assertEqual(replies, [conversation.OWNER_EXPLAINS + " "])

    async def test_a_method_from_a_lookup_on_this_call_is_kept(self):
        flow, runtime, _ = call_flow()
        runtime.lookup_business_fact.return_value = {"status": "supported", "facts": [{"value": "Hot water pressure washing"}]}
        await flow.lookup_business_fact("how do you clean")
        self.assertFalse(conversation.unsourced_method(self.HOT, flow.sourced_text))

    async def test_every_business_lookup_logs_its_query_and_whether_facts_were_found(self):
        flow, runtime, _ = call_flow()
        runtime.lookup_business_fact.side_effect = [
            {"knowledgeRevisionId": uid(3), "status": "supported", "facts": [{"value": "Dumpster pad cleaning"}], "passages": []},
            {"knowledgeRevisionId": uid(3), "status": "insufficient_information", "facts": [], "passages": []},
            RuntimeHttpError(503)]
        with self.assertLogs("frontline.voice", "INFO") as logs:
            await flow.lookup_business_fact("dumpster pads")
            await flow.lookup_business_fact("cleaning method for Tom at 408-555-0153")
            self.assertIn("do not know", await flow.lookup_business_fact("hours"))
        lines = [line for line in logs.output if "business_lookup" in line]
        self.assertEqual(len(lines), 3)
        self.assertIn('tool=lookup_business_fact query="dumpster pads" found=true status=supported', lines[0])
        self.assertIn("found=false status=insufficient_information", lines[1])
        self.assertNotIn("555", lines[1])
        self.assertIn("found=false status=failed", lines[2])


class StreamedReplies(unittest.IsolatedAsyncioTestCase):
    """The reply is spoken a sentence at a time, with unconfirmed claims and filler openers still removed."""

    async def spoken(self, *parts, receipt=False, after_tool=True, tool_call=False, saved=False, caller=None, thanks_heard=0):
        flow, _, front_desk = call_flow()
        flow.thanks_heard = thanks_heard
        last = SimpleNamespace(type='function_call_output' if after_tool else 'message')
        chat_ctx = SimpleNamespace(items=[last])
        if receipt:
            flow.receipts["op"] = {"operationId": "op"}
        if saved:
            flow.saved_request = flow.current_task = OneRequestPerNeed.SAVED
        flow.caller_texts = list(caller or [])
        async def fake_llm(agent, chat_ctx, tools, model_settings):
            for part in parts:
                yield part
            if tool_call:
                yield SimpleNamespace(delta=SimpleNamespace(content=None, tool_calls=[object()],
                                                            model_copy=lambda update: SimpleNamespace(**update)),
                                      model_copy=lambda update: 'tool-call-chunk')
        original = Agent.default.llm_node
        Agent.default.llm_node = fake_llm
        try:
            return [out async for out in flow.guarded_llm_node(front_desk, chat_ctx, [], None)]
        finally:
            Agent.default.llm_node = original

    async def test_only_the_first_thank_you_opener_in_a_call_is_spoken(self):
        # Tom, 2026-10-03: thanks on every turn sounds odd.
        self.assertEqual(await self.spoken("Thanks, Priya. ", "What's the address?"), ["Thanks, Priya. ", "What's the address?"])
        self.assertEqual(await self.spoken("Thanks, Priya. ", "What's the address?", thanks_heard=1), ["What's the address?"])
        self.assertEqual(await self.spoken("Thanks for that. When works best?", thanks_heard=1), ["When works best?"])
        self.assertEqual(await self.spoken("I've marked it urgent. Thanks for your patience.", thanks_heard=2),
                         ["I've marked it urgent. ", "Thanks for your patience."])
        # Tom's call, 2026-10-03: a thank-you for each detail. A detail gets none, and after the first thanks none at all.
        self.assertEqual(await self.spoken("Thanks for that address. ", "Could you tell me the city?"), ["Could you tell me the city?"])
        for opener in ("Thanks for confirming your number. ", "Thanks for the city, Sounds. ", "Thanks for explaining. ", "Thank you! "):
            self.assertEqual(await self.spoken(opener, "When works best?", thanks_heard=1), ["When works best?"], opener)
        # Live call, 2026-10-03: "Thanks for calling, Priya." came out as "For calling, Priya."
        self.assertEqual(await self.spoken("Thanks for calling, Priya. ", "Bye!", thanks_heard=1),
                         ["Thanks for calling, Priya. ", "Bye!"])
        self.assertEqual(await self.spoken("Thanks for your patience. ", "Anything else?", thanks_heard=1),
                         ["Thanks for your patience. ", "Anything else?"])

    async def test_each_finished_sentence_is_released_on_its_own(self):
        self.assertEqual(await self.spoken("Yeah, we can ", "help with that. Want me ", "to pass it along?"),
                         ["Yeah, we can help with that. ", "Want me to pass it along?"])

    async def test_an_unconfirmed_claim_is_dropped_and_the_rest_is_spoken(self):
        self.assertEqual(await self.spoken("I've passed it along. ", "What's your name?"), ["What's your name?"])
        self.assertEqual(await self.spoken("I've saved your request."), ["Let me get the rest of your details first."])
        self.assertEqual(await self.spoken("It's been passed along. ", "Anything else?", receipt=True),
                         ["It's been passed along. ", "Anything else?"])

    async def test_a_reply_to_the_caller_is_held_and_never_spoken_next_to_a_tool_call(self):
        self.assertEqual(await self.spoken("Sure, we do patios. ", "Want me to pass it along?", after_tool=False),
                         ["Sure, we do patios. ", "Want me to pass it along?"])
        self.assertEqual(await self.spoken("We can help with that. ", after_tool=False, tool_call=True), ["tool-call-chunk"])

    async def test_a_goodbye_to_a_caller_who_is_done_ends_the_call_instead_of_being_spoken(self):
        flow, _, front_desk = call_flow()
        flow.end_call = lambda reason: flow.__dict__.setdefault("ended", []).append(reason)
        flow.caller_texts = ["No, I'm good. Thank you."]
        last = SimpleNamespace(type='message')
        async def fake_llm(agent, chat_ctx, tools, model_settings):
            yield "Thanks for calling, Tom. Have a great day!"
        original = Agent.default.llm_node
        Agent.default.llm_node = fake_llm
        try:
            out = [chunk async for chunk in flow.guarded_llm_node(front_desk, SimpleNamespace(items=[last]), [], None)]
        finally:
            Agent.default.llm_node = original
        self.assertEqual((out, flow.ended), ([], ["caller_ended"]))
        # 2026-10-01 call: the application's own closing goodbye went through this same check and was dropped, so the
        # call ended in silence. Once the call is ending, the goodbye is spoken.
        flow.ending_requested = True
        Agent.default.llm_node = fake_llm
        try:
            out = [chunk async for chunk in flow.guarded_llm_node(front_desk, SimpleNamespace(items=[last]), [], None)]
        finally:
            Agent.default.llm_node = original
        self.assertEqual((''.join(out), flow.ended), ("Thanks for calling, Tom. Have a great day!", ["caller_ended"]))
        # Not when the caller is still asking something, or when the reply asks something.
        self.assertTrue(await self.spoken("Have a great day!", after_tool=False, caller=["Thanks, what are your hours?"]))
        self.assertTrue(await self.spoken("Bye! Anything else first?", after_tool=False, caller=["No, that's all."]))

    def test_an_early_start_refusal_quotes_what_bob_already_said(self):
        self.assertEqual(conversation.offer_first(""), conversation.OFFER_FIRST)
        self.assertIn('You already said: "Yes, we can help."', conversation.offer_first("Yes, we can help. "))
        self.assertIn("only ask if that would work for them", conversation.offer_first("Yes, we can help. "))

    async def test_a_reply_ends_at_its_first_question(self):
        self.assertEqual(await self.spoken("We can help. Want me to pass it along? ", "If your friend wants, I can take their number."),
                         ["We can help. ", "Want me to pass it along? "])

    async def test_a_repeat_offer_after_the_save_is_dropped(self):
        replies = await self.spoken("We use pressure washing for plazas. ", "Want me to pass that info to the owner?",
                                    receipt=True, saved=True)
        self.assertEqual(replies, ["We use pressure washing for plazas. "])
        self.assertEqual(await self.spoken("Want me to pass that along to the owner?", receipt=True, saved=True),
                         ["It's already with the manager."])

    async def test_a_filler_opener_is_dropped_unless_it_is_the_whole_reply(self):
        self.assertEqual(await self.spoken("Absolutely! ", "We clean patios."), ["We clean patios."])
        self.assertEqual(await self.spoken("Absolutely!"), ["Absolutely!"])


class VariedClosing(unittest.IsolatedAsyncioTestCase):
    """VCF fix 6, revised by Tom on 2026-10-02: an answer to the caller's question keeps its check-in; no "Anything else"
    when the caller trailed off, or twice within three replies otherwise."""

    async def asyncSetUp(self):
        self.flow, _, self.front_desk = call_flow()

    async def reply(self, *parts, caller="Okay, got it.", heard=True):
        self.flow.caller_texts.append(caller)
        chat_ctx = SimpleNamespace(items=[SimpleNamespace(type='function_call_output')])
        async def fake_llm(agent, chat_ctx, tools, model_settings):
            for part in parts:
                yield part
        original = Agent.default.llm_node
        Agent.default.llm_node = fake_llm
        try:
            out = ''.join([out async for out in self.flow.guarded_llm_node(self.front_desk, chat_ctx, [], None)])
        finally:
            Agent.default.llm_node = original
        if heard:
            # The session adds the reply to the conversation once it has played.
            self.flow.on_item_added(SimpleNamespace(item=SimpleNamespace(role='assistant', text_content=out)))
        return out

    async def test_a_closing_question_the_caller_talked_over_still_counts_as_not_asked(self):
        # 2026-10-01 call: the caller kept talking, the reply with "Anything else?" never played, and the next reply
        # dropped its closing question, leaving the line silent until "Still there?".
        await self.reply("No worries, Tom. ", "Anything else I can help with?", heard=False)
        self.assertEqual(await self.reply("The manager will follow up soon. ", "Anything else I can help with?"),
                         "The manager will follow up soon. Anything else I can help with?")
        self.flow.on_item_added(SimpleNamespace(item=SimpleNamespace(role='user', text_content='Anything else?')))
        self.assertEqual(len(self.flow.recent_replies), 1)

    async def test_the_closing_question_is_not_repeated_within_three_replies(self):
        self.assertEqual(await self.reply("The manager will reach out to you. ", "Anything else I can answer?"),
                         "The manager will reach out to you. Anything else I can answer?")
        self.assertEqual(await self.reply("Sure, we cover Irvine. ", "Anything else?"), "Sure, we cover Irvine. ")
        self.assertEqual(await self.reply("We're open weekdays. ", "Is there anything else I can help with?"), "We're open weekdays. ")
        self.assertEqual(await self.reply("Got it. ", "Anything else?"), "Got it. ")
        # Three replies after the last one, it may be asked again.
        self.assertEqual(await self.reply("Okay. ", "Anything else?"), "Okay. Anything else?")

    async def test_an_answer_to_the_callers_question_keeps_its_check_in(self):
        # Tom's 2026-10-02 call: Blake explained the process, the check-in was dropped, and the line went quiet.
        await self.reply("The manager will reach out to you. ", "Anything else I can answer?")
        self.assertEqual(await self.reply("The manager follows up, a worker checks the site, then they clean. ",
                                          "Anything else I can help with?",
                                          caller="Sounds good, um, can you tell me what's like the process look like?"),
                         "The manager follows up, a worker checks the site, then they clean. Anything else I can help with?")

    async def test_a_closing_question_after_the_caller_adds_something_is_kept(self):
        # Tom's 2026-10-04 call: "...ideally before eight AM" got "I've updated that." and nothing more.
        await self.reply("The manager will reach out to you. ", "Anything else I can help with?")
        self.assertEqual(await self.reply("Got it, before eight AM. ", "Anything else?", caller="AM"),
                         "Got it, before eight AM. Anything else?")

    def test_what_counts_as_adding_something(self):
        for text in ("AM", "Ideally before eight.", "It's at my office in Fremont."):
            self.assertTrue(conversation.adds_something(text), text)
        for text in ("Okay, got it.", "I see, thank you.", "Yes.", "Sounds good.", "Okay.", "Right, makes sense."):
            self.assertFalse(conversation.adds_something(text), text)

    async def test_an_answer_that_stops_short_gets_a_check_in(self):
        # Tom's 2026-10-04 call: asked what to do meanwhile, Blake gave the tip and stopped.
        self.assertEqual(await self.reply("Turning the system off can prevent more damage.",
                                          caller="During the meantime, what can I do to help?"),
                         "Turning the system off can prevent more damage. Let me know if you have any other questions.")
        self.assertEqual(await self.reply("We're open weekdays.", caller="When are you open?"),
                         "We're open weekdays. Is there anything else I can help with?")
        # Not after a statement, nor when the reply already invites more.
        self.assertEqual(await self.reply("Got it."), "Got it.")
        self.assertEqual(await self.reply("Sure. Let me know if anything comes up.", caller="Can you note that?"),
                         "Sure. Let me know if anything comes up.")

    async def test_no_services_are_named_right_after_marking_it_urgent(self):
        # Tom's 2026-10-04 call, live check of #41.
        self.assertEqual(await self.reply("I'll mark this as urgent so the manager knows to prioritize it. ",
                                          "We offer repair and maintenance for air conditioning units. ",
                                          "Would you like me to pass your request to the manager?", caller="I need it fixed ASAP."),
                         "I'll mark this as urgent so the manager knows to prioritize it. Would you like me to pass your request "
                         "to the manager?")
        self.assertEqual(await self.reply("We offer AC repair. ", "Would that work for you?", caller="My AC is broken."),
                         "We offer AC repair. Would that work for you?")

    async def test_no_closing_question_when_the_caller_trailed_off(self):
        self.assertEqual(await self.reply("Sorry to hear that. ", "Anything else?",
                                          caller="So like, how can you ensure that like"), "Sorry to hear that. ")

    async def test_a_closing_question_that_is_the_whole_reply_is_kept(self):
        await self.reply("The owner will reach out. ", "Anything else?")
        self.assertEqual(await self.reply("Anything else I can help with?"), "Anything else I can help with?")

    def test_mid_topic_words(self):
        for words in ("So like, how can you ensure that like", "And um,"):
            self.assertTrue(conversation.caller_mid_topic(words), words)
        for words in ("Okay, thanks.", "Yes.", "Got it, that makes sense.", "What's the next step?",
                      "Sounds good, um, can you tell me what's like the process look like?"):
            self.assertFalse(conversation.caller_mid_topic(words), words)
        for words in ("Can you tell me more", "What's the next step?", "Isn't Irvine, California?"):
            self.assertTrue(conversation.caller_asked(words), words)


class FrontDeskTools(unittest.IsolatedAsyncioTestCase):
    async def names(self, mode="business_demo", **bundle):
        _, _, front_desk = call_flow(mode, **bundle)
        await front_desk.configure_tools()
        return {tool.info.name for tool in front_desk.tools}

    async def test_business_calls_get_the_front_desk_tools(self):
        self.assertEqual(await self.names(), {"lookup_business_fact", "list_services", "get_service_details",
                                              "start_service_request", "report_complaint", "check_appointment", "end_call",
                                              "ask_for_owner"})

    async def test_product_qa_gets_only_product_facts_and_end_call(self):
        self.assertEqual(await self.names("frontline_qa"), {"lookup_frontline_fact", "end_call"})

    async def test_turned_off_request_kinds_are_hidden(self):
        names = await self.names(enabledWorkflows=["WF-01", "WF-03", "WF-06"])
        self.assertIn("start_service_request", names)
        self.assertFalse({"report_complaint", "check_appointment"} & names)
        self.assertFalse({"start_service_request", "change_request", "report_complaint", "check_appointment"}
                         & await self.names(enabledWorkflows=["WF-01", "WF-06"]))


if __name__ == "__main__":
    unittest.main()


class SpelledNames(unittest.TestCase):
    """Tom's 2026-10-01 call: "D-A V I E N, those two are separate words" was saved as "Dog bin"."""

    def test_spelled_letters_become_words_and_ordinary_words_do_not(self):
        self.assertEqual(intake_module.spelled_words("the Property is called Dog bin, uh, D-A V I E N Those, those two"), ["DA", "VIEN"])
        self.assertEqual(intake_module.spelled_words("It's called Dabbin. Uh, is DA And then B I E N. V I E N."), ["BIEN", "VIEN"])
        self.assertEqual(intake_module.spelled_words("It's S.M.I.T.H."), ["SMITH"])
        for text in ("I need a patio cleaned", "My number is four oh eight", "Is it A or B?", "Plan B, I guess"):
            self.assertEqual(intake_module.spelled_words(text), [], text)

    def test_the_read_back_names_the_letters_and_asks_to_confirm(self):
        line = intake_module.spelling_line("It's D-A V I E N, two words")
        self.assertIn('"Da Vien"', line)
        self.assertIn("D-A, V-I-E-N", line)
        self.assertIn('"Just to make sure, is that D-A, V-I-E-N?"', line)
        self.assertEqual(intake_module.spelling_line("It's in Irvine"), "")

    def test_a_spelled_name_replaces_the_one_it_was_misheard_as(self):
        said = "Yeah, so the property is called Dog bin, uh, D-A V I E N. Those two are separate words."
        fields = intake_module.with_spelling({"notes": {"person": "", "property": "Dog bin"}}, said)
        self.assertEqual(fields["notes"]["property"], "Da Vien")
        self.assertEqual(intake_module.with_spelling({"notes": {"property": "Dog bin"}}, "It's D-A-V-I-E-N.")["notes"]["property"], "Davien")
        # The misheard words before the spelling are not kept next to it.
        self.assertEqual(intake_module.with_spelling({"notes": {"property": "Dog Bin Davien"}}, said)["notes"]["property"], "Da Vien")
        self.assertEqual(intake_module.with_spelling({"notes": {"property": "Dog bin Da Vien"}}, said)["notes"]["property"], "Da Vien")
        # The caller's own name: only the part they spelled changes, and only when it sounded like it.
        for name, text, expected in (("Tom Lamb", "Last name is Lam, L-A-M.", "Tom Lam"),
                                     ("Tom Lamb", "It's T-O-M, L-A-M.", "Tom Lam"),
                                     ("Tom Lam", "Last name is Lam, L-A-M.", "Tom Lam"),
                                     ("Magnus", "M A G N U S.", "Magnus"),
                                     ("Tom Lamb", "It's spelled D-A-V-I-E-N.", "Tom Lamb")):
            self.assertEqual(intake_module.with_spelling({"callerName": name}, text), {"callerName": expected}, text)
        # Already spelled right, two names in one turn, or nothing spelled: left alone.
        for fields, text in (({"notes": {"property": "Da Vien Coffee"}}, said),
                             ({"callerName": "Tom", "notes": {"property": "Dog bin"}}, said),
                             ({"notes": {"property": "Westpark Plaza"}}, "It's Westpark Plaza.")):
            self.assertEqual(intake_module.with_spelling(fields, text), fields)

    def test_a_spelled_name_counts_as_said(self):
        texts = ["The property is called Dog bin, D-A V I E N, two words."]
        self.assertTrue(was_said("Da Vien", texts))
        self.assertTrue(was_said("Davien", texts))
        self.assertFalse(was_said("Da Vinci", texts))


class SpellingWithANumber(unittest.IsolatedAsyncioTestCase):
    async def test_a_spelling_and_a_new_number_are_read_back_in_one_question(self):
        fields = {"serviceNeed": "plaza cleaning", "callerName": "Tom Lam", "contactPhone": "4085552147"}
        flow = FakeFlow({"accepted": {"callerName": "Tom Lam", "contactPhone": "4085552147"}, "rejected": {}, "task": task(fields=fields)})
        flow.caller_texts = ["Four oh eight five five five two one four seven. Last name is Lam, L-A-M."]
        flow.spelling = intake_module.spelling_line(flow.caller_texts[-1])
        intake = ServiceRequestTask(flow, task(fields={"serviceNeed": "plaza cleaning"}), None)
        intake.told_next_step = True
        reply = await intake.record_details(Context(), name="Tom Lam", phone="4085552147")
        self.assertIn("L-A-M", reply)
        self.assertIn('also read the number back as "four oh eight, five five five, two one four seven"', reply)
        self.assertTrue(intake.readback_asked)


class SpellingAndWrapUpHints(unittest.IsolatedAsyncioTestCase):
    async def reply_to(self, flow, front_desk, caller):
        from livekit.agents.llm import ChatContext
        flow.caller_texts.append(caller)
        flow.spelling = intake_module.spelling_line(caller)
        chat_ctx = ChatContext()
        chat_ctx.add_message(role="user", content=caller)
        seen = []
        async def fake_llm(agent, chat_ctx, tools, model_settings):
            seen.append([item.text_content for item in chat_ctx.items])
            yield "You're welcome. Take care!"
        original = Agent.default.llm_node
        Agent.default.llm_node = fake_llm
        try:
            out = ''.join([out async for out in flow.guarded_llm_node(front_desk, chat_ctx, [], None)])
        finally:
            Agent.default.llm_node = original
        return out, seen[0] if seen else []

    async def test_thanks_after_the_save_gets_a_warm_wrap_up_and_the_next_thanks_ends_the_call(self):
        flow, _, front_desk = call_flow()
        flow.saved_request = {"receipt": {"id": "r"}, "status": "succeeded"}
        flow.end_for_turn = AsyncMock()
        out, seen = await self.reply_to(flow, front_desk, "Okay, sounds good. Thank you.")
        self.assertIn("let you know if they have any other questions", seen[-1])
        self.assertIn("the manager will be in touch soon", seen[-1])
        # Bob's own wrap-up is spoken, not replaced by the application's goodbye.
        self.assertEqual(out, "You're welcome. Take care!")
        self.assertFalse(flow.ending_requested)
        out, seen = await self.reply_to(flow, front_desk, "Okay, thanks.")
        self.assertNotIn("wrapping up", seen[-1])
        self.assertTrue(flow.ending_requested)

    async def test_no_wrap_up_before_anything_was_passed_along_or_for_a_question(self):
        flow, _, front_desk = call_flow()
        _, seen = await self.reply_to(flow, front_desk, "Okay, thanks.")
        self.assertEqual(seen, ["Okay, thanks."])
        flow.saved_request = {"receipt": {"id": "r"}, "status": "succeeded"}
        _, seen = await self.reply_to(flow, front_desk, "Okay, so what happens next?")
        self.assertEqual(seen, ["Okay, so what happens next?"])

    async def test_a_spelling_at_the_front_desk_is_read_back_once(self):
        flow, _, front_desk = call_flow()
        _, seen = await self.reply_to(flow, front_desk, "No, it's not dog bin, it's D-A V I E N.")
        self.assertIn("D-A, V-I-E-N", seen[-1])
        self.assertEqual(flow.spelling, "")


class PhoneInWords(unittest.TestCase):
    def test_a_full_number_the_caller_gave_is_found(self):
        said = ["Yeah, so my name is Tom Lam. My phone number is four oh eight five five five two one four seven."]
        self.assertEqual(intake_module.phone_in_words(said), "4085552147")
        for text in ("My name is Tom Lam.", "My number is four oh eight.", "It's at one two three Main Street, suite four five six seven."):
            self.assertEqual(intake_module.phone_in_words([text]), "", text)


class YesWithAQuestion(unittest.IsolatedAsyncioTestCase):
    async def test_a_yes_with_a_process_question_answers_then_starts_the_request(self):
        flow, _, front_desk = call_flow()
        flow.runtime.lookup_business_fact.return_value = {"facts": []}
        flow._read = AsyncMock(return_value='{"facts": []}')
        flow.recent_replies = ["We do cleaning in front of the stores. Would that work for you?"]
        flow.caller_texts = ["Uh, yes. Um, so what does the process look like?"]
        self.assertIn(conversation.YES_THEN_START, await front_desk.lookup_business_fact(None, "process"))
        for caller, reply in (("What does the process look like?", "Would that work for you?"),
                              ("Yes, what are your hours?", "We're open weekdays.")):
            flow.caller_texts, flow.recent_replies = [caller], [reply]
            self.assertNotIn(conversation.YES_THEN_START, await front_desk.lookup_business_fact(None, "process"))
        flow.caller_texts, flow.recent_replies = ["Yes, what's the process?"], ["Would that work for you?"]
        flow.saved_request = {"receipt": {"id": "r"}}
        self.assertNotIn(conversation.YES_THEN_START, await front_desk.lookup_business_fact(None, "process"))

    def test_a_yes_to_the_offer_starts_the_request_instead_of_offering_again(self):
        # Tom's sixth 2026-10-01 call: "Yeah, that'd be great. What's the next step?" got "Want me to start a request?".
        flow, _, front_desk = call_flow()
        flow.recent_replies = ["We can clean in front of the stores and around the trash area. Would that work for your friend?"]
        flow.caller_texts = ["Yeah, that'd be great. Um, I guess like what's the next step?"]
        self.assertEqual(flow.turn_hint(None), conversation.YES_START)
        flow.recent_replies = ["We clean storefront sidewalks. Would that cover what your friend needs?"]
        self.assertEqual(flow.turn_hint(None), conversation.YES_START)
        for reply, caller in (("What kind of help does your friend need?", "Yeah, the plaza out front."),
                              ("Would that work for your friend?", "What does it cost?"),
                              ("We clean storefronts.", "Yes, and the trash area?")):
            flow.recent_replies, flow.caller_texts = [reply], [caller]
            self.assertEqual(flow.turn_hint(None), '', (reply, caller))
        flow.recent_replies, flow.caller_texts = ["Would that work for you?"], ["Yes."]
        flow.saved_request = {"receipt": {"id": "r"}}
        self.assertEqual(flow.turn_hint(None), '')


class YesStartsTheRequest(unittest.IsolatedAsyncioTestCase):
    async def test_a_yes_with_asap_to_the_offer_forces_the_request_to_start(self):
        # Tom's call, 2026-10-03: "Yeah, like can you get someone here like ASAP?" got "Can I start a request?" again.
        from livekit.agents.llm import ChatContext
        flow, _, front_desk = call_flow()
        flow.recent_replies = ["Shutting off the valve under the sink stops the water. Would you like me to pass this to the manager?"]
        flow.caller_texts = ["Yeah, like can you get someone here like ASAP?"]
        chat_ctx = ChatContext.empty(); chat_ctx.add_message(role="user", content=flow.caller_texts[-1])
        seen = []
        async def fake_llm(agent, ctx, tools, model_settings):
            seen.append(model_settings)
            yield "Sure. "
        tools = [SimpleNamespace(info=SimpleNamespace(name=name)) for name in ("start_service_request", "list_services")]
        original = Agent.default.llm_node
        Agent.default.llm_node = fake_llm
        try:
            [out async for out in flow.guarded_llm_node(front_desk, chat_ctx, tools, None)]
            self.assertIs(seen[-1], conversation.START_REQUEST)
            flow.caller_texts = ["What does it cost?"]
            [out async for out in flow.guarded_llm_node(front_desk, chat_ctx, tools, None)]
            self.assertIsNot(seen[-1], conversation.START_REQUEST)
        finally:
            Agent.default.llm_node = original


class InterruptedTaskStart(unittest.IsolatedAsyncioTestCase):
    async def test_a_task_cut_off_by_the_caller_is_started_again_without_an_apology(self):
        # Tom's 2026-10-01 call: "Yes, I" then "If you provide as a service, yes." interrupted the opening request step,
        # and LiveKit's error made Bob say "Sorry, there was a little hiccup on my end."
        flow, _, front_desk = call_flow()
        front_desk.caller_turn_id = uid(2)
        flow.caller_texts = ["If you provide it as a service, yes."]
        flow.start_task = AsyncMock(return_value={"task": {"taskId": uid(3), "kind": "service_request", "status": "running"}})
        async def interrupted(*args, **kwargs):
            raise RuntimeError("the speech that awaited the inline task is interrupted")
        with patch.dict(conversation.TASKS, {"service_request": interrupted}):
            line = await flow.run_task(front_desk, "service_request", "plaza cleaning")
        self.assertIn("don't apologize", line)
        self.assertIn("call start_service_request again", line)


class PlainServiceNames(unittest.TestCase):
    def test_the_offer_asks_for_plain_words_not_catalog_names(self):
        for line in (conversation.OFFER_SERVICES, conversation.OFFER_FIRST):
            self.assertIn("plain everyday words", line)
        self.assertIn("plain everyday words", prompts.FRONT_DESK)


class RecoveredPhone(unittest.IsolatedAsyncioTestCase):
    async def test_a_number_the_model_left_out_is_recorded_from_the_caller_words(self):
        # 2026-10-01 harness run: "My phone number is four oh eight..." was recorded as the name only.
        fields = {"serviceNeed": "plaza cleaning", "callerName": "Tom Lam", "contactPhone": "4085552147"}
        flow = FakeFlow({"accepted": {"callerName": "Tom Lam", "contactPhone": "4085552147"}, "rejected": {}, "task": task(fields=fields)})
        flow.caller_texts = ["Yeah, so my name is Tom Lam. My phone number is four oh eight five five five two one four seven."]
        intake = ServiceRequestTask(flow, task(fields={"serviceNeed": "plaza cleaning"}), None)
        reply = await intake.record_details(Context(), name="Tom Lam")
        self.assertEqual(flow.records[0]["contactPhone"], "4085552147")
        self.assertIn("read the number back", reply)


class FifthCallFixes(unittest.IsolatedAsyncioTestCase):
    """Tom's fifth 2026-10-01 call: "the owner will follow up" came from the business's process note, and "thank you,
    Bob" plus "have a good rest of your day" did not count as a goodbye."""

    def test_a_goodbye_that_names_bob_or_wishes_a_good_day_ends_the_call(self):
        self.assertTrue(conversation.caller_is_done("No, sounds good. Okay, well thank you, Bob.", "Bob"))
        self.assertFalse(conversation.caller_is_done("No, sounds good. Okay, well thank you, Bob."))
        for text in ("Hopefully you have a good rest of your day.", "You too, have a great day.", "I hope you have a nice evening."):
            self.assertTrue(conversation.caller_is_done(text), text)
        self.assertFalse(conversation.caller_is_done("Thanks Bob, what are your hours?", "Bob"))

    def test_a_request_to_wait_is_recognized(self):
        for text in ("Uh, For the address Um, Give me a second.", "Yeah, no, that's what I'm saying. Give me a second.",
                     "Hold on.", "One sec, let me find it.", "Hang on a minute", "Can you hold on a second?",
                     # Tom's 2026-10-06 call, which Blake answered with another question.
                     "Can you give me a second? I'm gonna Go find the address real quick.", "Let me go grab that."):
            self.assertTrue(conversation.asks_to_wait(text), text)
        for text in ("Give me a second, it's 5150 East Pacific Coast Highway.", "My name is Sarah.",
                     "It's one five six two eight six seven, give me a sec", "Hold on, how much does it cost?",
                     "I need to check the gutters."):
            self.assertFalse(conversation.asks_to_wait(text), text)
        self.assertEqual(conversation.hold_kind("Sarah Blakely. Give me a second to find the address."), 'mixed')
        self.assertEqual(conversation.hold_kind("I'm gonna be home all day."), '')
        self.assertEqual(conversation.hold_kind("Let me check, I think Friday works."), 'mixed')

    async def test_a_caller_who_asks_to_wait_gets_one_short_reply_and_no_question(self):
        # Tom's 2026-10-06 call: "Give me a second" twice, and Blake asked for the address after each.
        flow, _, front_desk = call_flow()
        async def fake_llm(agent, chat_ctx, tools, model_settings):
            yield "No worries. Could you share the street address when you're ready?"
        original = Agent.default.llm_node
        Agent.default.llm_node = fake_llm
        try:
            replies = []
            for text in ("Uh, for the address, give me a second.", "Yeah, no. Give me a second."):
                last = SimpleNamespace(type='message', role='user', text_content=text)
                replies.append(''.join([chunk async for chunk in flow.guarded_llm_node(front_desk, SimpleNamespace(items=[last]), [], None)]))
        finally:
            Agent.default.llm_node = original
        self.assertEqual(replies, [conversation.HOLD_REPLY, conversation.HOLD_AGAIN])
        self.assertGreater(flow.hold_until, 0)

    async def test_a_detail_just_given_is_not_left_for_the_manager_to_get(self):
        flow, _, front_desk = call_flow()
        flow.caller_texts = ["Okay, it's two two two South Long Beach Boulevard, Long Beach."]
        async def fake_llm(agent, chat_ctx, tools, model_settings):
            yield ("No worries, the manager can get the exact address when they follow up. "
                   "I've passed your request along to them. Anything else I can help with?")
        original = Agent.default.llm_node
        Agent.default.llm_node = fake_llm
        try:
            last = SimpleNamespace(type='function_call_output')
            reply = ''.join([chunk async for chunk in flow.guarded_llm_node(front_desk, SimpleNamespace(items=[last]), [], None)])
        finally:
            Agent.default.llm_node = original
        self.assertNotIn('manager can get', reply)
        flow.caller_texts = ["I don't have the address on me."]
        self.assertIsNotNone(conversation._DEFERS.search(flow.caller_texts[-1]))

    async def test_a_wait_with_other_details_still_asks_nothing(self):
        flow, _, front_desk = call_flow()
        async def fake_llm(agent, chat_ctx, tools, model_settings):
            yield "Thanks, Sarah. Take your time. Meanwhile, could you tell me the street address?"
        original = Agent.default.llm_node
        Agent.default.llm_node = fake_llm
        try:
            last = SimpleNamespace(type='message', role='user', text_content="Sarah Blakely. Give me a second to find the address.")
            reply = ''.join([chunk async for chunk in flow.guarded_llm_node(front_desk, SimpleNamespace(items=[last]), [], None)])
        finally:
            Agent.default.llm_node = original
        self.assertNotIn('?', reply)
        self.assertIn('Take your time', reply)

    async def test_owner_in_a_spoken_sentence_becomes_manager(self):
        flow, _, front_desk = call_flow()
        async def fake_llm(agent, chat_ctx, tools, model_settings):
            yield "First, the owner will follow up with you. The owner's crew then checks the site."
        original = Agent.default.llm_node
        Agent.default.llm_node = fake_llm
        try:
            chat_ctx = SimpleNamespace(items=[SimpleNamespace(type='function_call_output')])
            out = ''.join([chunk async for chunk in flow.guarded_llm_node(front_desk, chat_ctx, [], None)])
        finally:
            Agent.default.llm_node = original
        self.assertEqual(out, "First, the manager will follow up with you. The manager's crew then checks the site.")
