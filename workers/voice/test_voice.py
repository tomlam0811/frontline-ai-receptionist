"""Focused contract/orchestration tests; no provider, browser, or network calls."""

from __future__ import annotations

import asyncio
import os
import sys
import unittest
from unittest.mock import AsyncMock
from types import SimpleNamespace
import uuid
import json
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(__file__))

from agent import VoiceOrchestrator, Bob, ToolResult, exact_readback, obtain_ready
from speech import readback_chunks
from runtime import Dispatch, FrontlineRuntime, RuntimeContractError, RuntimeHttpError, _validated_origin, request_fields_hash


class FakeHandle:
    interrupted = False
    async def wait_for_playout(self): pass
    def exception(self): return None


class FakeSession:
    def __init__(self): self.closed = False; self.prompts = []
    async def interrupt(self, force=False): pass
    def generate_reply(self, **kwargs): self.prompts.append(kwargs); return FakeHandle()
    def say(self, text, **kwargs): self.prompts.append({"text": text, **kwargs}); return FakeHandle()
    async def aclose(self): self.closed = True


class FakeBob:
    mode = "business_demo"
    caller_turn_id = "turn_1"
    revision = 1
    latest_validation = None
    latest_readback = None
    pending_readback_epoch = None
    def authorize(self, decision):
        self.revision = decision["workflow"]["revision"]
        self.caller_turn_id = decision["callerTurn"]["callerTurnId"]


class VoiceTests(unittest.IsolatedAsyncioTestCase):
    def test_dispatch_rejects_extra_or_unsafe_ids(self):
        self.assertEqual(Dispatch.from_metadata('{"demoId":"demo_1","agentVersionId":"agent-1","generation":1}').generation, 1)
        with self.assertRaises(RuntimeContractError):
            Dispatch.from_metadata('{"demoId":"../demo","agentVersionId":"agent","generation":1}')

    def test_private_http_is_railway_or_loopback_only(self):
        self.assertEqual(_validated_origin("http://api.railway.internal:8080"), "http://api.railway.internal:8080")
        self.assertEqual(_validated_origin("http://127.0.0.1:3000"), "http://127.0.0.1:3000")
        with self.assertRaises(RuntimeContractError): _validated_origin("http://example.com")
        with self.assertRaises(RuntimeContractError): _validated_origin("https://example.com/path")

    async def test_final_turn_uses_server_prompt_and_revision(self):
        runtime = AsyncMock()
        runtime.dispatch.demo_id = "demo_1"
        runtime.turn.return_value = {"callerTurn": {"callerTurnId": "server_turn"},
            "classification": {"escalationReason": None}, "workflow": {"revision": 4},
            "nextAction": "answer", "promptContext": "Answer only from supported facts."}
        session, bob = FakeSession(), FakeBob()
        flow = VoiceOrchestrator(session, bob, runtime, AsyncMock(), {"workflowRevision": 3, "stateRevision": 2})
        await flow.handle_turn("stable-client-turn", "What are the office hours?")
        runtime.turn.assert_awaited_once_with("stable-client-turn", "What are the office hours?", 3)
        self.assertEqual(flow.workflow_revision, 4)
        self.assertIn("server-authorized", session.prompts[0]["instructions"])

    async def test_readback_is_recorded_only_after_playout(self):
        runtime = AsyncMock(); runtime.dispatch.demo_id = "demo_1"
        runtime.turn.return_value = {"callerTurn": {"callerTurnId": "server_turn"}, "classification": {},
            "workflow": {"revision": 4}, "nextAction": "readback", "promptContext": "Read the fields back."}
        runtime.record_readback.return_value = {"workflowRevision": 5, "fieldRevision": 2,
            "readbackRevision": 1, "payloadHash": "a" * 64}
        bob = FakeBob(); bob.latest_validation = {"fieldRevision": 2, "payloadHash": "a" * 64, "fields": FIELDS, "missingFields": []}
        flow = VoiceOrchestrator(FakeSession(), bob, runtime, AsyncMock(), {"workflowRevision": 3, "stateRevision": 1})
        await flow.handle_turn("client", "details")
        runtime.record_readback.assert_awaited_once_with(4, 2, "a" * 64)
        self.assertEqual(flow.workflow_revision, 5)

    async def test_escalation_closes_room_when_persistence_and_tts_fail(self):
        runtime = AsyncMock(); runtime.dispatch.demo_id = "demo_1"
        runtime.begin_ending.side_effect = RuntimeContractError("storage")
        session, room, bob = FakeSession(), AsyncMock(), FakeBob()
        flow = VoiceOrchestrator(session, bob, runtime, room, {"workflowRevision": 1, "stateRevision": 1})
        flow.speak = AsyncMock(side_effect=RuntimeError("tts"))
        await flow.escalate("human_preference", "human please")
        self.assertTrue(flow.terminal); self.assertTrue(session.closed)
        room.disconnect.assert_awaited_once()
        runtime.terminal.assert_awaited_once_with(1, "human_preference")

    async def test_safety_close_uses_immediate_danger_wording(self):
        runtime = AsyncMock(); runtime.dispatch.demo_id = "demo_1"
        runtime.begin_ending.return_value = {"stateRevision": 2, "workflowRevision": 2}
        runtime.record_escalation.return_value = {"outcome": "saved"}
        flow = VoiceOrchestrator(FakeSession(), FakeBob(), runtime, AsyncMock(),
                                 {"workflowRevision": 1, "stateRevision": 1})
        flow.speak = AsyncMock(return_value=True)
        await flow.escalate("safety_emergency", "fire")
        self.assertIn("immediate danger", flow.speak.await_args.args[0])


def uid(number): return f"00000000-0000-4000-8000-{number:012d}"
STAMP = "2026-09-24T00:00:00Z"
FIELDS = {"callerName":"Taylor", "contactEmail":"taylor@example.org", "serviceNeed":"Pressure washing", "propertyCity":"Anaheim"}


def decision(revision, action="answer", workflow="WF-01", turn=10):
    reason = "human_preference" if action == "escalate" else None
    tools = {"WF-01":["retrieve_facts"], "WF-03":["validate_request","save_request"],
             "WF-04":["lookup_appointment"], "WF-05":["save_case"], "WF-06":["record_escalation","end_session"]}[workflow]
    return {"callerTurn":{"callerTurnId":uid(turn),"clientTurnId":uid(turn+100),"demoId":uid(1),
            "sequence":turn,"text":"caller words","finalized":True,"recordedAt":STAMP,"workflowRevision":revision},
        "workflow":{"workflowInstanceId":uid(2),"workflowId":workflow,"phase":"ending" if reason else "collecting",
            "revision":revision,"allowedToolIds":tools},
        "classification":{"status":"classified","workflowId":workflow,"dialogueAct":"affirm" if action=="confirm" else "other",
            "confidence":.9,"escalationReason":reason,"model":"jev-1.13.0"},
        "nextAction":action,"promptContext":"Use sourced facts or the authorized action."}


def receipt(revision, operation=None, kind="request"):
    return {"receiptId":uid(30),"operationId":operation or uid(31),"operationKind":kind,"payloadHash":"a"*64,
        "workflowInstanceId":uid(2),"workflowRevision":revision,"recordedAt":STAMP,"sequence":1,
        "outcome":"saved","recordId":uid(32)}


class BlockingHandle(FakeHandle):
    def __init__(self): self.release = asyncio.Event(); self.interrupted = False
    async def wait_for_playout(self): await self.release.wait()


class BlockingSession(FakeSession):
    def __init__(self):
        super().__init__(); self.first = BlockingHandle(); self.started = asyncio.Event()
    def generate_reply(self, **kwargs):
        self.prompts.append(kwargs)
        if len(self.prompts)==1:
            self.started.set(); return self.first
        return FakeHandle()
    def say(self, text, **kwargs):
        self.prompts.append({"text": text, **kwargs})
        if len(self.prompts)==1:
            self.started.set(); return self.first
        return FakeHandle()
    async def interrupt(self, force=False):
        if self.started.is_set(): self.first.interrupted = True


class RegressionTests(unittest.IsolatedAsyncioTestCase):
    async def test_product_qa_rejects_business_grants_and_never_saves_escalation(self):
        flow, runtime, bob = self.flow()
        bob.mode = "frontline_qa"
        bob.authorize(decision(2, "collect", "WF-03"))
        self.assertEqual(bob.allowed, set())
        handle = FakeHandle(); flow.speech_epochs[id(handle)] = flow.epoch
        context = SimpleNamespace(speech_handle=handle)
        with self.assertRaises(RuntimeContractError):
            await bob.validate_request(context, callerName="Taylor")
        runtime.validate_request.assert_not_awaited()
        runtime.turn.return_value = decision(3, "confirm", "WF-03")
        with self.assertRaises(RuntimeContractError):
            await flow.handle_turn(uid(91), "yes")
        runtime.confirm.assert_not_awaited()
        runtime.save_request.assert_not_awaited()
        flow.speak = AsyncMock(return_value=True)
        await flow.escalate("human_preference", "A human please")
        runtime.record_escalation.assert_not_awaited()

    def flow(self, session=None):
        runtime=AsyncMock(); runtime.dispatch.demo_id=uid(1)
        runtime.begin_ending.return_value={"stateRevision":2,"workflowRevision":8}
        runtime.record_escalation.return_value=receipt(9,kind="escalation")
        runtime.terminal.return_value={"stateRevision":3,"workflowRevision":10}
        bob=Bob(runtime,{"mode":"business_demo","workflowRevision":1})
        flow=VoiceOrchestrator(session or FakeSession(),bob,runtime,AsyncMock(),{"workflowRevision":1,"stateRevision":1})
        return flow,runtime,bob

    async def test_real_tools_share_revision_with_next_turn(self):
        for tool, workflow in [("validate_request","WF-03"),("lookup_appointment","WF-04"),("save_case","WF-05")]:
            with self.subTest(tool=tool):
                flow,runtime,bob=self.flow()
                bob.authorize(decision(2,"collect",workflow))
                handle=FakeHandle();flow.speech_epochs[id(handle)]=flow.epoch
                context=SimpleNamespace(speech_handle=handle)
                if tool=="validate_request":
                    runtime.validate_request.return_value={"workflowRevision":3,"fieldRevision":1,"payloadHash":"a"*64,"fields":FIELDS,"missingFields":[]}
                    await bob.validate_request(context,**FIELDS)
                elif tool=="lookup_appointment":
                    runtime.lookup_appointment.return_value={"workflowRevision":3,"kind":"not_found","lookupId":uid(9)}
                    await bob.lookup_appointment(context,"Taylor","cancel")
                else:
                    runtime.save_case.return_value=receipt(3,kind="case")
                    await bob.save_case(context,"The work was unsatisfactory")
                self.assertEqual(flow.workflow_revision,3)
                runtime.turn.return_value=decision(4)
                await flow.handle_turn(uid(90),"Next question")
                self.assertEqual(runtime.turn.await_args.args[2],3)

    async def test_real_validation_during_readback_uses_result_revision(self):
        flow,runtime,bob=self.flow()
        runtime.turn.return_value=decision(2,"collect","WF-03")
        runtime.validate_request.return_value={"workflowRevision":3,"fieldRevision":1,"payloadHash":"a"*64,"fields":FIELDS,"missingFields":[]}
        runtime.record_readback.return_value={"workflowRevision":4,"fieldRevision":1,"readbackRevision":1,"payloadHash":"a"*64}
        class ToolHandle(FakeHandle):
            async def wait_for_playout(handle):
                await bob.validate_request(SimpleNamespace(speech_handle=handle),**FIELDS)
        flow.session.generate_reply=lambda **kwargs: ToolHandle()
        await flow.handle_turn(uid(90),"My details")
        runtime.record_readback.assert_awaited_once_with(3,1,"a"*64)
        self.assertEqual(flow.workflow_revision,4)

    async def test_concurrent_final_turns_are_serialized_before_cas(self):
        flow,runtime,bob=self.flow(); first=asyncio.Event(); release=asyncio.Event(); revisions=[]
        async def turn(client,text,revision):
            revisions.append(revision)
            if len(revisions)==1: first.set(); await release.wait()
            return decision(revision+1)
        runtime.turn.side_effect=turn
        a=asyncio.create_task(flow.handle_turn(uid(80),"first"));await first.wait()
        b=asyncio.create_task(flow.handle_turn(uid(81),"second"));await asyncio.sleep(0)
        self.assertEqual(revisions,[1]);release.set();await asyncio.gather(a,b)
        self.assertEqual(revisions,[1,2]);self.assertEqual(flow.workflow_revision,3)
        self.assertEqual(len(flow.session.prompts),1)

    async def test_provider_item_id_is_demo_scoped_uuid_and_duplicate_final_is_ignored(self):
        flow,runtime,bob=self.flow(); flow.handle_turn=AsyncMock()
        flow.accept_final("hello","lk_item_123");flow.accept_final("hello","lk_item_123")
        await asyncio.gather(*flow.tasks)
        actual=flow.handle_turn.await_args.args[0]
        self.assertEqual(str(uuid.UUID(actual)),actual)
        other,_,_=self.flow();other.handle_turn=AsyncMock();other.accept_final("hello","lk_item_123")
        await asyncio.gather(*other.tasks)
        self.assertEqual(actual,other.handle_turn.await_args.args[0])
        flow.handle_turn.assert_awaited_once()

    async def test_human_preempts_readback_without_waiting_for_playout_or_recording_it(self):
        session=BlockingSession();flow,runtime,bob=self.flow(session)
        runtime.turn.side_effect=[decision(2,"readback","WF-03"),decision(3,"escalate","WF-06",11)]
        bob.latest_validation={"fieldRevision":1,"payloadHash":"a"*64,"fields":FIELDS,"missingFields":[]}
        old=asyncio.create_task(flow.handle_turn(uid(80),"details"));await session.started.wait()
        await asyncio.wait_for(flow.handle_turn(uid(81),"I want a human"),.5)
        self.assertTrue(flow.terminal);self.assertTrue(session.closed)
        runtime.record_readback.assert_not_awaited();session.first.release.set();await old
        runtime.record_readback.assert_not_awaited();self.assertEqual(bob.allowed,set())

    async def test_human_preempts_pending_save_and_late_receipt_cannot_restore_intake(self):
        flow,runtime,bob=self.flow();started=asyncio.Event();release=asyncio.Event();frozen=[]
        bob.latest_readback={"fieldRevision":1,"readbackRevision":1,"payloadHash":"a"*64}
        runtime.turn.side_effect=[decision(2,"confirm","WF-03"),decision(4,"escalate","WF-06",11)]
        runtime.confirm.return_value={"workflowRevision":3,"confirmationId":uid(20)}
        async def save(operation,revision,confirmation):
            frozen.append((operation,revision,confirmation));started.set();await release.wait()
            return receipt(4,operation)
        runtime.save_request.side_effect=save
        old=asyncio.create_task(flow.handle_turn(uid(80),"Yes correct"));await started.wait()
        await asyncio.wait_for(flow.handle_turn(uid(81),"A human please"),.5)
        self.assertTrue(flow.terminal);self.assertTrue(flow.session.closed)
        self.assertEqual(len(frozen),1);self.assertEqual(frozen[0][1:],(3,uid(20)))
        release.set();await old
        self.assertIn(frozen[0][0],flow.receipts)
        self.assertGreaterEqual(flow.workflow_revision,9);self.assertEqual(bob.allowed,set())
        self.assertEqual(len(flow.session.prompts),1)  # closing only, no late save narration

    async def test_cancelled_tool_waiter_retains_pending_operation_lock(self):
        flow,runtime,bob=self.flow();started=asyncio.Event();release=asyncio.Event();second=AsyncMock(return_value={"workflowRevision":3})
        async def first(revision): started.set();await release.wait();return {"workflowRevision":2}
        waiter=asyncio.create_task(flow.mutate(0,first));await started.wait();waiter.cancel()
        with self.assertRaises(asyncio.CancelledError): await waiter
        next_waiter=asyncio.create_task(flow.mutate(0,second));await asyncio.sleep(0)
        second.assert_not_awaited();release.set();await next_waiter
        second.assert_awaited_once_with(2)

    async def test_turn_retries_only_explicit_cas_conflict_with_identical_turn(self):
        flow,runtime,bob=self.flow()
        runtime.turn.side_effect=[RuntimeHttpError(409,code="stale_workflow",workflow_revision=4,state_revision=1),decision(5)]
        await flow.handle_turn(uid(80),"human words")
        self.assertEqual([call.args for call in runtime.turn.await_args_list],[(uid(80),"human words",1),(uid(80),"human words",4)])
        flow,runtime,bob=self.flow();runtime.turn.side_effect=RuntimeHttpError(409,code="stale_workflow")
        with self.assertRaises(RuntimeHttpError): await flow.handle_turn(uid(80),"same")
        self.assertEqual(runtime.turn.await_count,1)

    async def test_timed_close_does_not_claim_a_failed_save(self):
        flow,runtime,bob=self.flow();await flow.escalate("soft_close_elapsed","")
        runtime.record_escalation.assert_not_awaited()
        close=flow.session.prompts[-1]["text"]
        self.assertIn("out of time",close);self.assertNotIn("record",close)
        self.assertTrue(flow.session.closed)

    async def test_old_speech_handle_cannot_call_new_turn_tools(self):
        flow,runtime,bob=self.flow();bob.authorize(decision(2,"collect","WF-03"))
        handle=FakeHandle();flow.speech_epochs[id(handle)]=0;flow.epoch=1
        with self.assertRaises(RuntimeContractError): await bob.validate_request(SimpleNamespace(speech_handle=handle),**FIELDS)
        runtime.validate_request.assert_not_awaited()

    async def test_complete_real_tool_reads_exact_snapshot_then_next_affirm_saves(self):
        flow, runtime, bob = self.flow()
        fields = {**FIELDS, "preferredDay": "Friday", "preferredWindow": "9–11 AM", "timezone": "America/Los_Angeles", "notes": "Use the side gate"}
        runtime.turn.side_effect = [decision(2, "collect", "WF-03"), decision(5, "confirm", "WF-03", 11)]
        runtime.validate_request.return_value = {"workflowRevision": 3, "fieldRevision": 2, "fields": fields, "missingFields": [], "payloadHash": "b"*64}
        runtime.record_readback.return_value = {"workflowRevision": 4, "fieldRevision": 2, "readbackRevision": 1, "fields": fields, "payloadHash": "b"*64}
        runtime.confirm.return_value = {"workflowRevision": 6, "confirmationId": uid(20)}
        runtime.save_request.return_value = receipt(7)
        class ToolHandle(FakeHandle):
            async def wait_for_playout(handle):
                result = await bob.validate_request(SimpleNamespace(speech_handle=handle), **fields)
                self.assertIsInstance(result, ToolResult)
                self.assertFalse(result.reply_required)
        generated = []
        def generate(**kwargs):
            generated.append(kwargs)
            return ToolHandle() if len(generated) == 1 else FakeHandle()
        flow.session.generate_reply = generate
        await flow.handle_turn(uid(90), "Here are my complete details")
        self.assertEqual([item["text"] for item in flow.session.prompts], readback_chunks(fields))
        self.assertEqual(" ".join(item["text"] for item in flow.session.prompts), exact_readback(fields))
        self.assertTrue(all(item["allow_interruptions"] for item in flow.session.prompts))
        runtime.record_readback.assert_awaited_once_with(3, 2, "b"*64)
        runtime.confirm.assert_not_awaited()
        await flow.handle_turn(uid(91), "Yes, those details are correct")
        runtime.confirm.assert_awaited_once_with(5, uid(11), 2, 1, "b"*64)
        runtime.save_request.assert_awaited_once()
        self.assertEqual(len(generated), 2)

    async def test_correction_discards_old_fields_until_fresh_tool_validation(self):
        flow, runtime, bob = self.flow()
        old = {**FIELDS, "preferredDay": "Friday"}
        bob.latest_validation = {"workflowRevision": 1, "fieldRevision": 1, "fields": old, "missingFields": [], "payloadHash": "a"*64}
        bob.latest_readback = {"fieldRevision": 1, "readbackRevision": 1, "payloadHash": "a"*64}
        changed = decision(2, "readback", "WF-03")
        changed["classification"]["dialogueAct"] = "correct"
        runtime.turn.return_value = changed
        await flow.handle_turn(uid(90), "Actually Monday")
        self.assertIsNone(bob.latest_validation)
        self.assertIsNone(bob.latest_readback)
        runtime.record_readback.assert_not_awaited()
        self.assertFalse(any("text" in item for item in flow.session.prompts))
        fields = {**FIELDS, "preferredDay": "Monday"}
        runtime.turn.return_value = decision(3, "collect", "WF-03", 11)
        runtime.validate_request.return_value = {"workflowRevision": 4, "fieldRevision": 2, "fields": fields, "missingFields": [], "payloadHash": "b"*64}
        runtime.record_readback.return_value = {"workflowRevision": 5, "fieldRevision": 2, "readbackRevision": 2, "payloadHash": "b"*64}
        class ToolHandle(FakeHandle):
            async def wait_for_playout(handle): await bob.validate_request(SimpleNamespace(speech_handle=handle), **fields)
        flow.session.generate_reply = lambda **kwargs: ToolHandle()
        await flow.handle_turn(uid(91), "Monday please")
        spoken = [item["text"] for item in flow.session.prompts if "text" in item]
        self.assertEqual(spoken, readback_chunks(fields))
        self.assertNotIn("Friday", " ".join(spoken))
        runtime.record_readback.assert_awaited_once_with(4, 2, "b"*64)

    async def test_interrupted_exact_readback_after_real_tool_is_not_recorded(self):
        flow, runtime, bob = self.flow()
        runtime.turn.return_value = decision(2, "collect", "WF-03")
        runtime.validate_request.return_value = {"workflowRevision": 3, "fieldRevision": 1, "fields": FIELDS, "missingFields": [], "payloadHash": "a"*64}
        class ToolHandle(FakeHandle):
            async def wait_for_playout(handle): await bob.validate_request(SimpleNamespace(speech_handle=handle), **FIELDS)
        flow.session.generate_reply = lambda **kwargs: ToolHandle()
        interrupted = FakeHandle(); interrupted.interrupted = True
        flow.session.say = lambda text, **kwargs: interrupted
        await flow.handle_turn(uid(90), "Complete details")
        runtime.record_readback.assert_not_awaited()
        self.assertIsNone(bob.latest_readback)

    async def test_human_interrupts_exact_readback_started_by_real_validation_tool(self):
        session = BlockingSession(); flow, runtime, bob = self.flow(session)
        runtime.turn.side_effect = [decision(2,"collect","WF-03"), decision(4,"escalate","WF-06",11)]
        runtime.validate_request.return_value = {"workflowRevision":3,"fieldRevision":1,"fields":FIELDS,"missingFields":[],"payloadHash":"a"*64}
        class ToolHandle(FakeHandle):
            async def wait_for_playout(handle): await bob.validate_request(SimpleNamespace(speech_handle=handle), **FIELDS)
        session.generate_reply = lambda **kwargs: ToolHandle()
        pending = asyncio.create_task(flow.handle_turn(uid(90), "Complete details"))
        await session.started.wait()
        self.assertEqual(session.prompts[0]["text"], readback_chunks(FIELDS)[0])
        await asyncio.wait_for(flow.handle_turn(uid(91), "I want a human"), .5)
        runtime.record_readback.assert_not_awaited()
        self.assertTrue(flow.terminal)
        self.assertTrue(session.closed)
        session.first.release.set()
        await pending
        runtime.record_readback.assert_not_awaited()

    async def test_partial_real_tool_never_reads_or_records_incomplete_snapshot(self):
        flow, runtime, bob = self.flow()
        runtime.turn.return_value = decision(2, "collect", "WF-03")
        runtime.validate_request.return_value = {"workflowRevision": 3, "fieldRevision": 1, "fields": {"callerName":"Taylor"}, "missingFields":["serviceNeed","propertyCity","contactPhone","contactEmail"], "payloadHash":"a"*64}
        class ToolHandle(FakeHandle):
            async def wait_for_playout(handle):
                result = await bob.validate_request(SimpleNamespace(speech_handle=handle), callerName="Taylor")
                self.assertIsInstance(result, str)
        flow.session.generate_reply = lambda **kwargs: ToolHandle()
        await flow.handle_turn(uid(90), "Taylor")
        runtime.record_readback.assert_not_awaited()
        self.assertEqual(flow.session.prompts, [])

    async def test_explicit_readback_and_closing_never_generate_model_speech(self):
        flow, runtime, bob = self.flow()
        bob.latest_validation = {"workflowRevision":1,"fieldRevision":1,"fields":FIELDS,"missingFields":[],"payloadHash":"a"*64}
        runtime.turn.return_value = decision(2,"readback","WF-03")
        runtime.record_readback.return_value = {"workflowRevision":3,"fieldRevision":1,"readbackRevision":1,"payloadHash":"a"*64}
        flow.session.generate_reply = unittest.mock.Mock(side_effect=AssertionError("Must not paraphrase"))
        await flow.handle_turn(uid(90), "Please repeat the details")
        self.assertEqual([item["text"] for item in flow.session.prompts], readback_chunks(FIELDS))
        await flow.escalate("soft_close_elapsed", "")
        self.assertEqual(flow.session.prompts[-1]["text"], "We're out of time for this call. Thanks for talking with me. Bye.")
        self.assertFalse(flow.session.prompts[-1]["allow_interruptions"])
        flow.session.generate_reply.assert_not_called()

    async def test_recovered_exact_readback_confirms_without_an_extra_readback(self):
        flow, runtime, _ = self.flow()
        validation = {"workflowRevision":3,"fieldRevision":2,"fields":FIELDS,"missingFields":[],"payloadHash":"b"*64}
        readback = {"workflowRevision":4,"fieldRevision":2,"readbackRevision":1,"fields":FIELDS,"payloadHash":"b"*64}
        bob = Bob(runtime, {"mode":"business_demo","workflowRevision":4,"currentValidation":validation,"currentReadback":readback})
        flow = VoiceOrchestrator(FakeSession(), bob, runtime, AsyncMock(), {"workflowRevision":4,"stateRevision":1})
        runtime.turn.return_value = decision(5, "confirm", "WF-03", 11)
        runtime.confirm.return_value = {"workflowRevision":6,"confirmationId":uid(20)}
        runtime.save_request.return_value = receipt(7)
        await flow.handle_turn(uid(91), "Yes correct")
        runtime.confirm.assert_awaited_once_with(5, uid(11), 2, 1, "b"*64)
        runtime.record_readback.assert_not_awaited()
        runtime.save_request.assert_awaited_once()

    async def test_active_recovery_reuses_exact_deadlines_after_setup_expired(self):
        now = datetime.now(timezone.utc)
        ready = {"startedAt":(now-timedelta(seconds=30)).isoformat(), "softCloseAt":(now+timedelta(seconds=240)).isoformat(), "hardEndAt":(now+timedelta(seconds=270)).isoformat()}
        bundle = {**ready,"sessionState":"active","setupDeadlineAt":(now-timedelta(seconds=10)).isoformat()}
        runtime = AsyncMock(); runtime.ready.return_value = ready
        self.assertEqual(await obtain_ready(runtime, bundle), ready)
        runtime.ready.assert_awaited_once()
        runtime.ready.return_value = {**ready,"hardEndAt":(now+timedelta(seconds=300)).isoformat()}
        with self.assertRaises(RuntimeContractError): await obtain_ready(runtime, bundle)

    async def test_recovery_rejects_expiry_or_untrusted_timestamps(self):
        past = (datetime.now(timezone.utc)-timedelta(seconds=10)).isoformat()
        future = (datetime.now(timezone.utc)+timedelta(seconds=100)).isoformat()
        for state, hard in [("active",past),("waiting",future),("ended",future),(None,future)]:
            with self.subTest(state=state):
                runtime = AsyncMock()
                bundle = {"sessionState":state,"startedAt":past,"setupDeadlineAt":past,"hardEndAt":hard}
                with self.assertRaises(RuntimeContractError): await obtain_ready(runtime,bundle)
                runtime.ready.assert_not_awaited()


class RuntimeValidationTests(unittest.TestCase):
    def runtime(self):
        runtime=FrontlineRuntime.__new__(FrontlineRuntime)
        runtime.dispatch=Dispatch(uid(1),uid(5),1);runtime.room="frontline-room";runtime.knowledge_revision_id=uid(6)
        return runtime
    def wire(self,data):return {**data,"requestId":uid(99),"version":"1.0"}

    def test_turn_response_exact_envelope_and_semantic_tools(self):
        runtime=self.runtime();value=decision(2);body={"clientTurnId":uid(110)}
        self.assertEqual(runtime._validate_response("turn",self.wire(value),body),value)
        for change in [{"debugAuthority":True},{"version":"0"},{"requestId":"not-uuid"}]:
            with self.assertRaises(RuntimeContractError):runtime._validate_response("turn",{**self.wire(value),**change},body)
        with self.assertRaises(RuntimeContractError):runtime._validate_response("turn",value,body)
        wrong=json.loads(json.dumps(value));wrong["workflow"]["allowedToolIds"]=["save_request"]
        with self.assertRaises(RuntimeContractError):runtime._validate_response("turn",self.wire(wrong),body)
        wrong=json.loads(json.dumps(value));wrong["callerTurn"]["demoId"]=uid(999)
        with self.assertRaises(RuntimeContractError):runtime._validate_response("turn",self.wire(wrong),body)

    def test_structural_response_validation_for_every_frozen_action(self):
        runtime=self.runtime()
        cases={
          "requests/validate":({"workflowInstanceId":uid(2),"workflowRevision":3,"fieldRevision":1,"fields":FIELDS,"missingFields":[],"payloadHash":request_fields_hash(FIELDS)},{}),
          "requests/readback":({"workflowInstanceId":uid(2),"workflowRevision":4,"fieldRevision":1,"readbackRevision":1,"payloadHash":request_fields_hash(FIELDS),"fields":FIELDS,"afterCallerTurnSequence":1,"serverRecordedAt":STAMP},{"fieldRevision":1,"payloadHash":request_fields_hash(FIELDS)}),
          "requests/confirmations":({"confirmationId":uid(20),"workflowInstanceId":uid(2),"callerTurnId":uid(10),"callerTurnSequence":2,"fieldRevision":1,"readbackRevision":1,"readbackPayloadHash":request_fields_hash(FIELDS),"serverRecordedAt":STAMP,"dialogueAct":"affirm","workflowRevision":5},{"callerTurnId":uid(10),"fieldRevision":1,"readbackRevision":1,"payloadHash":request_fields_hash(FIELDS)}),
          "appointments/lookup":({"kind":"not_found","lookupId":uid(20),"workflowRevision":3},{}),
          "requests":(receipt(6),{"operationId":uid(31)}),
          "cases":(receipt(6,kind="case"),{"operationId":uid(31)}),
          "escalations":(receipt(6,kind="escalation"),{"operationId":uid(31)}),
          "ending":({"sessionId":uid(1),"status":"ending","reason":"human_preference","stateRevision":2,"endingAt":STAMP,"reconnectAllowed":False,"closeDeadlineAt":STAMP,"workflowRevision":6},{"reason":"human_preference"}),
          "terminal":({"sessionId":uid(1),"status":"terminal","reason":"human_preference","stateRevision":3,"terminalAt":STAMP,"reconnectAllowed":False,"workflowRevision":7},{"reason":"human_preference"}),
        }
        for action,(value,body) in cases.items():
            with self.subTest(action=action):
                self.assertEqual(runtime._validate_response(action,self.wire(value),body),value)
                with self.assertRaises(RuntimeContractError):runtime._validate_response(action,self.wire({**value,"workflowRevision":0}),body)
                with self.assertRaises(RuntimeContractError):runtime._validate_response(action,self.wire({**value,"privateRecord":"leak"}),body)

    def test_runtime_recovery_snapshots_validate_schema_revision_mode_and_binding(self):
        runtime = self.runtime()
        validation = {"workflowInstanceId":uid(2),"workflowRevision":3,"fieldRevision":1,"fields":FIELDS,"missingFields":[],"payloadHash":request_fields_hash(FIELDS)}
        readback = {"workflowInstanceId":uid(2),"workflowRevision":4,"fieldRevision":1,"readbackRevision":1,"fields":FIELDS,"payloadHash":request_fields_hash(FIELDS),"afterCallerTurnSequence":1,"serverRecordedAt":STAMP}
        bundle = {"demoId":uid(1),"mode":"business_demo","representedEntity":"business","businessName":"Bayside","profile":{},"facts":[],"capabilityManifest":{},"agentVersionId":uid(5),"knowledgeRevisionId":uid(6),"generation":1,"roomName":"frontline-room","setupDeadlineAt":STAMP,"startedAt":STAMP,"softCloseAt":"2026-09-24T00:04:30Z","hardEndAt":"2026-09-24T00:05:00Z","expiresAt":"2026-09-25T00:00:00Z","workflowRevision":4,"stateRevision":2,"sessionState":"active","currentValidation":validation,"currentReadback":readback}
        self.assertEqual(runtime._validate_response("runtime",self.wire(bundle)),bundle)
        for change in ({"sessionState":"arbitrary"},{"mode":"frontline_qa"},{"workflowRevision":2},{"currentValidation":None},{"currentReadback":{**readback,"payloadHash":"b"*64}},{"currentValidation":{**validation,"fields":{**FIELDS,"timezone":"America/Los_Angeles"}}},{"currentReadback":{**readback,"workflowInstanceId":uid(999)}},{"roomName":"different-room"}):
            with self.subTest(change=change), self.assertRaises(RuntimeContractError):
                runtime._validate_response("runtime",self.wire({**bundle,**change}))

    def test_retrieval_rejects_unsupported_evidence_and_other_revision(self):
        runtime=self.runtime();value={"knowledgeRevisionId":uid(6),"status":"insufficient_information","facts":[],"passages":[]}
        for action in ("lookup-business-fact","services","services/details"):
            self.assertEqual(runtime._validate_response(action,self.wire(value),{}),value)
            with self.assertRaises(RuntimeContractError):runtime._validate_response(action,self.wire({**value,"status":"supported"}),{})
            with self.assertRaises(RuntimeContractError):runtime._validate_response(action,self.wire({**value,"knowledgeRevisionId":uid(999)}),{})


if __name__ == "__main__": unittest.main()
