"""Spoken wording tests (BN-T1 to BN-T4); no provider, browser, or network calls."""
from __future__ import annotations

import os
import sys
import unittest
from unittest.mock import AsyncMock

sys.path.insert(0, os.path.dirname(__file__))

from agent import TTS_INSTRUCTIONS, VoiceOrchestrator, Bob, log_transcript_item
from prompts import REPLY_WORDS, front_desk_instructions, task_instructions
from speech import (CONFIRM_QUESTION, follow_up_line, readback_chunks, spoken_email, spoken_phone,
                    closing_question, strip_filler_opener, style_findings)
from test_voice import FakeSession

FULL = {"callerName": "Alex Rivera", "contactPhone": "415-555-0132", "contactEmail": "alex.rivera@example.com",
        "serviceNeed": "storefront cleaning", "propertyCity": "Example City", "preferredDay": "Friday"}


class SpokenForms(unittest.TestCase):
    """BN-T1: phone and email are spoken in listener-friendly groups; stored values never change."""

    def test_phone_is_spoken_in_three_groups(self):
        self.assertEqual(spoken_phone("415-555-0132"), "4 1 5, 5 5 5, zero 1 3 2")
        self.assertEqual(spoken_phone("(415) 555 0132"), "4 1 5, 5 5 5, zero 1 3 2")
        self.assertEqual(spoken_phone("+1 415 555 0132"), "4 1 5, 5 5 5, zero 1 3 2")

    def test_unrecognized_phone_is_left_as_given(self):
        self.assertEqual(spoken_phone("555-0132"), "555-0132")
        self.assertEqual(spoken_phone(""), "")

    def test_email_is_spoken_with_at_and_dot(self):
        self.assertEqual(spoken_email("alex.rivera@example.com"), "alex dot rivera at example dot com")
        self.assertEqual(spoken_email("a_b-c+d@x.io"), "a underscore b dash c plus d at x dot io")
        self.assertEqual(spoken_email("not an email"), "not an email")

    def test_readback_never_changes_the_stored_fields(self):
        before = dict(FULL)
        chunks = readback_chunks(FULL)
        self.assertEqual(FULL, before)
        self.assertIn("4 1 5, 5 5 5, zero 1 3 2", chunks[0])
        self.assertNotIn("415-555-0132", " ".join(chunks))


class ReadbackChunks(unittest.TestCase):
    """BN-T2: one pass in short parts, contact details first, question last, every value present."""

    def test_contact_details_come_first_then_the_rest_then_the_question(self):
        chunks = readback_chunks(FULL)
        self.assertEqual(len(chunks), 3)
        self.assertIn("Alex Rivera", chunks[0])
        self.assertIn("alex dot rivera at example dot com", chunks[0])
        self.assertIn("storefront cleaning", chunks[1])
        self.assertIn("Example City", chunks[1])
        self.assertIn("Friday", chunks[1])
        self.assertTrue(chunks[2].endswith(CONFIRM_QUESTION))
        self.assertEqual(chunks[2], CONFIRM_QUESTION)

    def test_every_free_text_value_is_spoken_verbatim(self):
        text = " ".join(readback_chunks(FULL))
        for key in ("callerName", "serviceNeed", "propertyCity", "preferredDay"):
            self.assertIn(FULL[key], text)

    def test_only_contact_fields_gives_two_parts(self):
        self.assertEqual(len(readback_chunks({"callerName": "Alex"})), 2)

    def test_no_contact_fields_still_reads_everything(self):
        chunks = readback_chunks({"serviceNeed": "gutter cleaning", "propertyCity": "Anaheim"})
        self.assertEqual(len(chunks), 2)
        self.assertIn("gutter cleaning", chunks[0])
        self.assertIn("Anaheim", chunks[0])

    def test_after_a_correction_only_the_changed_value_is_read(self):
        updated = {**FULL, "preferredDay": "Monday"}
        chunks = readback_chunks(updated, heard=FULL)
        self.assertEqual(len(chunks), 1)
        self.assertTrue(chunks[0].startswith("Got it."))
        self.assertIn("Monday", chunks[0])
        for unchanged in ("Alex Rivera", "storefront cleaning", "Example City", "alex dot rivera"):
            self.assertNotIn(unchanged, chunks[0])
        self.assertTrue(chunks[0].endswith("Is that right?"))
        self.assertEqual(closing_question(chunks[0]), "Is that right?")
        self.assertEqual(closing_question(readback_chunks(FULL)[-1]), "Did I get that right?")

    def test_nothing_changed_since_everything_was_heard_only_rechecks(self):
        self.assertEqual(readback_chunks(FULL, heard=FULL), ["Should I save it as is?"])

    def test_values_never_heard_are_still_read(self):
        heard = {"callerName": "Alex Rivera"}
        text = " ".join(readback_chunks(FULL, heard=heard))
        self.assertNotIn("Alex Rivera", text)
        for value in ("storefront cleaning", "Example City", "Friday"):
            self.assertIn(value, text)

    def test_unknown_or_empty_fields_are_rejected(self):
        with self.assertRaises(ValueError): readback_chunks({})
        with self.assertRaises(ValueError): readback_chunks({"favoriteColor": "blue"})


class FillerAndStyle(unittest.TestCase):
    """BN-T3: filler is removed when the model uses it anyway, and the prompt forbids it."""

    def test_stacked_filler_openers_are_removed(self):
        self.assertEqual(strip_filler_opener("Great question! Absolutely. We're open until five."), "We're open until five.")
        self.assertEqual(strip_filler_opener("I'd be happy to help with that. What's your name?"), "What's your name?")
        self.assertEqual(strip_filler_opener("Of course, we clean patios."), "We clean patios.")

    def test_normal_replies_are_untouched(self):
        for text in ("Sure, we clean patios.", "Yeah, I can hear you.", "Got it."):
            self.assertEqual(strip_filler_opener(text), text)

    def test_a_reply_that_is_only_filler_is_kept(self):
        self.assertEqual(strip_filler_opener("Absolutely!"), "Absolutely!")

    def test_style_findings_count_filler_and_contractions(self):
        bad = style_findings("Great question! I'd be happy to help.")
        self.assertEqual(bad["filler"], 2)
        good = style_findings("Sure, we're open until five.")
        self.assertEqual(good["filler"], 0)
        self.assertTrue(good["contraction"])

    def test_persona_forbids_filler_and_repeats_and_states_the_reply_length_once(self):
        prompt = front_desk_instructions({"mode": "business_demo", "businessName": "Example Valley Cleaning"})
        for phrase in ("great question", "happy to help", "absolutely", "contractions", "repeat a sentence",
                       "first name once or twice", "different, simpler words"):
            self.assertIn(phrase, prompt)
        self.assertEqual(prompt.count(f"under {REPLY_WORDS} words"), 1)
        self.assertNotIn("35 words", prompt)

    def test_questions_are_answered_first_from_sourced_facts(self):
        prompt = front_desk_instructions({"mode": "business_demo", "businessName": "Example Valley Cleaning"})
        self.assertIn("When the caller asks something, your first sentence answers it.", prompt)
        self.assertIn("When they ask how the process works, give the steps the tools describe", prompt)
        self.assertIn("say you're not sure and don't have that information right now", prompt)

    def test_front_desk_leads_toward_a_follow_up(self):
        prompt = front_desk_instructions({"mode": "business_demo", "businessName": "Example Valley Cleaning"})
        for phrase in ("don't repeat their need back to them", "Would that work for you?", "Anything else I can help with?",
                       "not something we offer", "mark it urgent", "Say them in your own words and vary them"):
            self.assertIn(phrase, prompt)

    def test_tool_rules_live_in_tool_descriptions_not_the_prompt(self):
        # VA-D6: when to call a tool is written once, in its description.
        for kind in ("service_request", "complaint", "appointment_lookup"):
            prompt = task_instructions({"mode": "business_demo", "businessName": "Example Valley Cleaning"}, kind)
            self.assertNotIn("start_task", prompt)
            self.assertNotIn("provide_task_input", prompt)
            self.assertIn("record_details", prompt)

    def test_every_agent_shares_one_persona(self):
        bundle = {"mode": "business_demo", "businessName": "Example Valley Cleaning"}
        persona = front_desk_instructions(bundle).split("## Your job")[0]
        for kind in ("service_request", "complaint", "appointment_lookup"):
            self.assertTrue(task_instructions(bundle, kind).startswith(persona))

    def test_slow_down_clause_is_gone_from_voice_instructions(self):
        self.assertNotIn("Slow down only", TTS_INSTRUCTIONS)
        self.assertIn("natural pace", TTS_INSTRUCTIONS)
        self.assertIn("friendly", TTS_INSTRUCTIONS)
        self.assertNotIn("no smiling", TTS_INSTRUCTIONS)


class FollowUp(unittest.TestCase):
    def test_follow_up_names_the_business_channel_and_window(self):
        line = follow_up_line("Bayside Power Washing", {"contactPhone": "415-555-0132"})
        self.assertEqual(line, "Someone from Bayside Power Washing will follow up by phone within one business day.")

    def test_email_channel_and_unknown_business(self):
        self.assertEqual(follow_up_line("this business", {"contactEmail": "a@b.co"}),
                         "Someone from the team will follow up by email within one business day.")

    def test_urgent_window_is_soft(self):
        self.assertEqual(follow_up_line("Knockout Plumbing", {"contactPhone": "415-555-0132"}, urgent=True),
                         "Someone from Knockout Plumbing will follow up by phone within the next 30 minutes to an hour or so.")

    def test_can_be_switched_off(self):
        os.environ["FRONTLINE_DEMO_FOLLOW_UP"] = "off"
        try:
            self.assertEqual(follow_up_line("X", {}), "")
        finally:
            del os.environ["FRONTLINE_DEMO_FOLLOW_UP"]


class InterruptedAfterFirstPart(unittest.IsolatedAsyncioTestCase):
    """BN-T4: a readback cut off partway is not recorded as delivered, and the next pass reads the whole snapshot."""

    def flow(self, session):
        runtime = AsyncMock(); runtime.dispatch.demo_id = "d" * 8
        bob = Bob(runtime, {"mode": "business_demo", "workflowRevision": 1})
        flow = VoiceOrchestrator(session, bob, runtime, AsyncMock(), {"workflowRevision": 1, "stateRevision": 1})
        bob.latest_validation = {"workflowRevision": 1, "fieldRevision": 1, "fields": FULL, "missingFields": [], "payloadHash": "a" * 64}
        runtime.record_readback.return_value = {"workflowRevision": 3, "fieldRevision": 1, "readbackRevision": 1, "payloadHash": "a" * 64}
        return flow, runtime, bob

    async def test_interruption_after_the_first_part_records_nothing_and_remembers_what_was_heard(self):
        class Session(FakeSession):
            def say(self, text, **kwargs):
                handle = super().say(text, **kwargs)
                if len(self.prompts) == 2: handle.interrupted = True
                return handle
        session = Session(); flow, runtime, _ = self.flow(session)
        await flow.readback(flow.epoch)
        self.assertEqual(len(session.prompts), 2)
        runtime.record_readback.assert_not_awaited()
        self.assertEqual(set(flow.heard_fields), {"callerName", "contactPhone", "contactEmail"})

    async def test_complete_delivery_records_once_and_remembers_every_value(self):
        session = FakeSession(); flow, runtime, _ = self.flow(session)
        await flow.readback(flow.epoch)
        self.assertEqual([item["text"] for item in session.prompts], readback_chunks(FULL))
        runtime.record_readback.assert_awaited_once()
        self.assertEqual(flow.heard_fields, FULL)

    async def test_correction_rereads_only_the_change_and_still_records(self):
        session = FakeSession(); flow, runtime, bob = self.flow(session)
        await flow.readback(flow.epoch)
        session.prompts.clear()
        corrected = {**FULL, "propertyCity": "Irvine"}
        bob.latest_validation = {"workflowRevision": 3, "fieldRevision": 2, "fields": corrected, "missingFields": [], "payloadHash": "b" * 64}
        await flow.readback(flow.epoch)
        self.assertEqual(len(session.prompts), 1)
        self.assertIn("Irvine", session.prompts[0]["text"])
        self.assertNotIn("Alex Rivera", session.prompts[0]["text"])
        self.assertEqual(runtime.record_readback.await_count, 2)
        self.assertEqual(runtime.record_readback.await_args.args[1:], (2, "b" * 64))

    async def test_cut_off_question_does_not_record_but_the_recheck_does(self):
        class Session(FakeSession):
            def say(self, text, **kwargs):
                handle = super().say(text, **kwargs)
                if len(self.prompts) == 3: handle.interrupted = True
                return handle
        session = Session(); flow, runtime, _ = self.flow(session)
        await flow.readback(flow.epoch)
        runtime.record_readback.assert_not_awaited()
        self.assertEqual(flow.heard_fields, FULL)
        session.prompts.clear()
        await flow.readback(flow.epoch)
        self.assertEqual([item["text"] for item in session.prompts], ["Should I save it as is?"])
        runtime.record_readback.assert_awaited_once()


class TranscriptLog(unittest.TestCase):
    """Both sides of a call can be read from the worker log when the flag is on."""

    def event(self, role, text, interrupted=False, kind="message"):
        from types import SimpleNamespace
        return SimpleNamespace(item=SimpleNamespace(type=kind, role=role, text_content=text, interrupted=interrupted))

    def test_logs_caller_and_bob_with_interruption_flag(self):
        with self.assertLogs("frontline.voice", level="INFO") as captured:
            log_transcript_item("demo-1", self.event("user", "Hi, I need my patio cleaned."))
            log_transcript_item("demo-1", self.event("assistant", "Sure, I can help.", interrupted=True))
        text = "\n".join(captured.output)
        self.assertIn('role=user interrupted=False text="Hi, I need my patio cleaned."', text)
        self.assertIn('role=assistant interrupted=True text="Sure, I can help."', text)

    def test_ignores_system_items_and_handoffs(self):
        with self.assertNoLogs("frontline.voice", level="INFO"):
            log_transcript_item("demo-1", self.event("system", "secret instructions"))
            log_transcript_item("demo-1", self.event("assistant", "x", kind="agent_handoff"))


if __name__ == "__main__":
    unittest.main()
