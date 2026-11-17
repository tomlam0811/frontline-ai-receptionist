"""PO-C8 runtime bridge: claimed modes, call policy fields and the Bob turn post (PO-E17)."""
import asyncio
import io
import json
import os
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(__file__))
from runtime import (
    Dispatch, FrontlineRuntime, RuntimeContractError, RuntimeHttpError, disabled_task_kinds,
)
from test_voice import STAMP, uid

CLAIMED = {
    "owner_test": ("owner_test", "test_summary"),
    "shared_guest": ("shared_guest", "guest_feedback"),
}


def runtime_bundle(mode="owner_test", **extra):
    bundle = {"demoId": uid(1), "mode": mode, "representedEntity": "business", "businessName": "Riverside Dental",
              "profile": {}, "facts": [], "capabilityManifest": {}, "agentVersionId": uid(5), "knowledgeRevisionId": uid(6),
              "generation": 1, "roomName": "frontline-room", "setupDeadlineAt": STAMP, "startedAt": STAMP,
              "softCloseAt": "2026-09-24T00:04:30Z", "hardEndAt": "2026-09-24T00:05:00Z", "expiresAt": "2026-09-25T00:00:00Z",
              "workflowRevision": 1, "stateRevision": 1, "sessionState": "waiting", "callArchitectureVersion": "bob-task-v1"}
    if mode in CLAIMED:
        bundle.update({"callPurpose": CLAIMED[mode][0], "closingPolicy": CLAIMED[mode][1],
                       "enabledWorkflows": ["WF-01", "WF-02", "WF-03", "WF-04", "WF-05", "WF-06"]})
    return {**bundle, **extra}


def wire(data):
    return {**data, "requestId": uid(99), "version": "1.0"}


def make_runtime():
    runtime = FrontlineRuntime.__new__(FrontlineRuntime)
    runtime.dispatch = Dispatch(uid(1), uid(5), 1)
    runtime.room, runtime.knowledge_revision_id = "frontline-room", uid(6)
    runtime.base_url, runtime.token = "http://127.0.0.1:1", "service-token"
    return runtime


class RuntimeCallPolicyTests(unittest.TestCase):
    def check(self, bundle):
        return make_runtime()._validate_response("runtime", wire(bundle))

    def test_claimed_modes_are_accepted_with_their_call_policy(self):
        for mode in CLAIMED:
            with self.subTest(mode=mode):
                bundle = runtime_bundle(mode)
                self.assertEqual(self.check(bundle), bundle)

    def test_a_claimed_call_must_state_every_policy_field(self):
        for mode in CLAIMED:
            for key in ("callPurpose", "closingPolicy", "enabledWorkflows"):
                with self.subTest(mode=mode, missing=key), self.assertRaises(RuntimeContractError):
                    bundle = runtime_bundle(mode)
                    del bundle[key]
                    self.check(bundle)

    def test_call_policy_must_match_the_mode(self):
        cases = [
            ("shared_guest", {"closingPolicy": "test_summary"}),
            ("shared_guest", {"closingPolicy": "signup_pitch"}),
            ("owner_test", {"closingPolicy": "guest_feedback"}),
            ("owner_test", {"callPurpose": "anonymous_trial"}),
            ("business_demo", {"closingPolicy": "guest_feedback", "callPurpose": "anonymous_trial"}),
            ("business_demo", {"callPurpose": "owner_test"}),
            ("frontline_qa", {"closingPolicy": "test_summary"}),
        ]
        for mode, change in cases:
            with self.subTest(mode=mode, change=change), self.assertRaises(RuntimeContractError):
                self.check(runtime_bundle(mode, **change))

    def test_original_modes_keep_working_with_or_without_the_policy_fields(self):
        for mode, purpose in (("business_demo", "anonymous_trial"), ("frontline_qa", "frontline_qa")):
            with self.subTest(mode=mode):
                bare = runtime_bundle(mode)
                self.assertEqual(self.check(bare), bare)
                full = runtime_bundle(mode, callPurpose=purpose, closingPolicy="signup_pitch", enabledWorkflows=["WF-01", "WF-06"])
                self.assertEqual(self.check(full), full)

    def test_enabled_workflows_must_be_a_list_of_known_unique_workflow_ids(self):
        for value in ("WF-01", None, {"WF-01": True}, ["WF-01", "WF-01"], ["WF-07"], ["wf-01"], [1], ["WF-01", None]):
            with self.subTest(value=value), self.assertRaises(RuntimeContractError):
                self.check(runtime_bundle("owner_test", enabledWorkflows=value))
        self.assertEqual(self.check(runtime_bundle("owner_test", enabledWorkflows=[]))["enabledWorkflows"], [])

    def test_the_receptionist_name_is_accepted_when_sent_and_optional_when_absent(self):
        # MR-D4 and MR-T6: the API sends the owner's chosen name. An older API sends none and the call still starts.
        for mode in CLAIMED:
            with self.subTest(mode=mode):
                self.assertEqual(self.check(runtime_bundle(mode, receptionistName="Sam"))["receptionistName"], "Sam")
                self.assertNotIn("receptionistName", self.check(runtime_bundle(mode)))

    def test_unknown_keys_and_unknown_modes_are_still_rejected(self):
        for mode in ("owner_test", "shared_guest", "business_demo"):
            with self.subTest(mode=mode, key="unknown"), self.assertRaises(RuntimeContractError):
                self.check(runtime_bundle(mode, privateNotes="leak"))
            with self.subTest(mode=mode, key="hint"), self.assertRaises(RuntimeContractError):
                self.check(runtime_bundle(mode, closingPolicy_override="signup_pitch"))
        for mode in ("owner_retest", "guest", "demo", "", None, "Owner_Test"):
            with self.subTest(mode=mode), self.assertRaises(RuntimeContractError):
                self.check({**runtime_bundle("owner_test"), "mode": mode})

    def test_binding_checks_still_apply_to_claimed_calls(self):
        for change in ({"roomName": "other-room"}, {"generation": 2}, {"agentVersionId": uid(50)}, {"demoId": uid(51)}, {"sessionState": "arbitrary"}):
            with self.subTest(change=change), self.assertRaises(RuntimeContractError):
                self.check(runtime_bundle("shared_guest", **change))

    def test_disabled_task_kinds_follow_the_enabled_workflows(self):
        self.assertEqual(disabled_task_kinds(["WF-01", "WF-02", "WF-03", "WF-04", "WF-05", "WF-06"]), frozenset())
        self.assertEqual(disabled_task_kinds(["WF-01", "WF-03", "WF-06"]), {"appointment_lookup", "complaint"})
        self.assertEqual(disabled_task_kinds(["WF-01", "WF-06"]), {"service_request", "appointment_lookup", "complaint"})
        # No list, or an empty one, means the version reports no capability list. The server then keeps every workflow on.
        self.assertEqual(disabled_task_kinds(None), frozenset())
        self.assertEqual(disabled_task_kinds([]), frozenset())


class FakeResponse(io.BytesIO):
    def __enter__(self): return self
    def __exit__(self, *args): return False


class AssistantTurnPostTests(unittest.IsolatedAsyncioTestCase):
    async def test_posts_the_documented_body_to_the_worker_route_and_validates_the_receipt(self):
        runtime, seen = make_runtime(), {}
        def fake_urlopen(req, timeout):
            seen.update(url=req.full_url, method=req.get_method(), body=json.loads(req.data), headers={k.lower(): v for k, v in req.header_items()})
            return FakeResponse(json.dumps(wire({"seq": 3, "replayed": False})).encode())
        with patch("runtime.request.urlopen", fake_urlopen):
            result = await runtime.assistant_turn(uid(60), "  Sure, I can help with that.  ", True, 2)
        self.assertEqual(result, {"seq": 3, "replayed": False})
        self.assertEqual(seen["url"], f"http://127.0.0.1:1/v1/internal/demos/{uid(1)}/assistant-turns")
        self.assertEqual(seen["method"], "POST")
        self.assertEqual(seen["body"], {"clientTurnId": uid(60), "text": "Sure, I can help with that.", "interrupted": True, "expectedStateRevision": 2})
        self.assertEqual(seen["headers"]["authorization"], "Bearer service-token")
        self.assertEqual(seen["headers"]["x-frontline-generation"], "1")

    async def test_text_is_capped_at_2000_characters_and_interrupted_is_a_boolean(self):
        runtime, bodies = make_runtime(), []
        runtime._request_sync = lambda method, action, body=None: bodies.append(body) or {"seq": 1}
        await runtime.assistant_turn(uid(60), "a" * 2500, 0, 1)
        self.assertEqual(len(bodies[0]["text"]), 2000)
        self.assertIs(bodies[0]["interrupted"], False)

    async def test_bad_requests_never_reach_the_network(self):
        runtime, calls = make_runtime(), []
        runtime._request_sync = lambda *args: calls.append(args)
        for client_turn_id, text, revision in (("not-a-uuid", "hi", 1), (uid(60), "", 1), (uid(60), "   ", 1), (uid(60), "hi", 0)):
            with self.subTest(client_turn_id=client_turn_id, text=text, revision=revision), self.assertRaises(RuntimeContractError):
                await runtime.assistant_turn(client_turn_id, text, False, revision)
        self.assertEqual(calls, [])

    async def test_invalid_receipts_are_rejected(self):
        runtime = make_runtime()
        for reply in ({"seq": 0}, {}, {"seq": "1"}, {"seq": 1, "replayed": "yes"}):
            with self.subTest(reply=reply), patch("runtime.request.urlopen", lambda req, timeout, reply=reply: FakeResponse(json.dumps(wire(reply)).encode())):
                with self.assertRaises(RuntimeContractError):
                    await runtime.assistant_turn(uid(60), "hi", False, 1)

    async def test_server_refusals_surface_their_code(self):
        runtime = make_runtime()
        from urllib import error
        def refuse(req, timeout):
            raise error.HTTPError(req.full_url, 409, "Conflict", {}, io.BytesIO(json.dumps({"title": "session_ending"}).encode()))
        with patch("runtime.request.urlopen", refuse):
            with self.assertRaises(RuntimeHttpError) as caught:
                await runtime.assistant_turn(uid(60), "hi", False, 1)
        self.assertEqual((caught.exception.status, caught.exception.code), (409, "session_ending"))


if __name__ == "__main__": unittest.main()
