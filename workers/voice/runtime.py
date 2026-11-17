"""Authenticated, contract-shaped bridge from the voice worker to Frontline."""

from __future__ import annotations

import asyncio
import json
import hashlib
import os
import re
import sys
from pathlib import Path
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any
from urllib import error, parse, request


_REPO_ROOT = Path(__file__).resolve().parents[2]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))
from contracts.v1.python.frontline_contracts import (
    validate_contract, validate_workflow_state, validate_retrieval_result,
)
_MANIFEST = json.loads((_REPO_ROOT / "contracts/v1/http-endpoints.json").read_text())
_ENDPOINTS = {item["path"].split("/v1/internal/demos/{demoId}/", 1)[1]: item
              for item in _MANIFEST["endpoints"]
              if item["path"].startswith("/v1/internal/demos/{demoId}/")}

def _revision(value):
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


# Call modes and the call policy each one carries. Owner test and shared guest calls are claimed calls: they run a
# saved Bob for a business, so they use the business tools, and /runtime must state their call policy.
CLAIMED_MODES = ("owner_test", "shared_guest")
BUSINESS_MODES = ("business_demo",) + CLAIMED_MODES
CALL_MODES = BUSINESS_MODES + ("frontline_qa",)
MODE_CALL_POLICY = {
    "business_demo": ("anonymous_trial", "signup_pitch"),
    "frontline_qa": ("frontline_qa", "signup_pitch"),
    "owner_test": ("owner_test", "test_summary"),
    "shared_guest": ("shared_guest", "guest_feedback"),
}
WORKFLOW_IDS = ("WF-01", "WF-02", "WF-03", "WF-04", "WF-05", "WF-06")
TASK_KIND_WORKFLOWS = {"service_request": "WF-03", "appointment_lookup": "WF-04", "complaint": "WF-05"}
ASSISTANT_TURN_MAX_CHARS = 2000


def disabled_task_kinds(enabled_workflows) -> frozenset[str]:
    """Task kinds whose workflow the pinned agent version turned off.

    An absent or empty list means the version reports no capability list, which the server treats as every workflow
    on. WF-01 and WF-06 can never be disabled, so a real list always contains them.
    """
    if not enabled_workflows:
        return frozenset()
    enabled = set(enabled_workflows)
    return frozenset(kind for kind, workflow in TASK_KIND_WORKFLOWS.items() if workflow not in enabled)


class RuntimeContractError(RuntimeError):
    pass


class RuntimeHttpError(RuntimeContractError):
    def __init__(self, status: int, *, code: str | None = None, workflow_revision=None, state_revision=None):
        self.code = code
        self.workflow_revision = workflow_revision if _revision(workflow_revision) else None
        self.state_revision = state_revision if _revision(state_revision) else None
        super().__init__(f"Frontline runtime returned HTTP {status}")
        self.status = status


@dataclass(frozen=True)
class Dispatch:
    demo_id: str
    agent_version_id: str
    generation: int

    @classmethod
    def from_metadata(cls, raw: str) -> "Dispatch":
        try:
            data = json.loads(raw)
            value = cls(data["demoId"], data["agentVersionId"], data["generation"])
        except (ValueError, KeyError, TypeError, UnicodeError) as exc:
            raise RuntimeContractError("Invalid dispatch metadata") from exc
        if not all(isinstance(item, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,128}", item)
                   for item in (value.demo_id, value.agent_version_id)):
            raise RuntimeContractError("Invalid dispatch binding")
        if isinstance(value.generation, bool) or not isinstance(value.generation, int) or value.generation < 1:
            raise RuntimeContractError("Invalid worker generation")
        return value


def parse_deadline(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (ValueError, TypeError) as exc:
        raise RuntimeContractError("Invalid server deadline") from exc
    if result.tzinfo is None:
        raise RuntimeContractError("Server deadline requires a timezone")
    return result.astimezone(timezone.utc)


def _validated_origin(raw: str) -> str:
    """Allow TLS origins, loopback development, or Railway's private DNS only."""
    try:
        url = parse.urlsplit(raw.rstrip("/"))
        port = url.port
    except ValueError as exc:
        raise RuntimeContractError("Invalid FRONTLINE_API_BASE_URL") from exc
    if url.username or url.password or url.query or url.fragment or url.path not in ("", "/"):
        raise RuntimeContractError("FRONTLINE_API_BASE_URL must be an origin")
    host = (url.hostname or "").lower()
    loopback = host in ("localhost", "127.0.0.1", "::1")
    railway_private = bool(re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.railway\.internal", host))
    if url.scheme == "https" and host and not railway_private:
        pass
    elif url.scheme == "http" and (loopback or railway_private):
        pass
    else:
        raise RuntimeContractError("API origin must use HTTPS, loopback, or Railway private DNS")
    if port is not None and not 1 <= port <= 65535:
        raise RuntimeContractError("Invalid API origin port")
    return raw.rstrip("/")


def request_fields_hash(fields: dict[str, str]) -> str:
    # Canonical field keys are ASCII and values are strings, matching the API's
    # sorted-key JSON.stringify encoding without JSON's default Python spaces.
    encoded = json.dumps(fields, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


class FrontlineRuntime:
    """Every method maps one-for-one to a frozen contracts/v1 HTTP endpoint."""

    def __init__(self, dispatch: Dispatch, room: str):
        self.base_url = _validated_origin(os.environ.get("FRONTLINE_API_BASE_URL", ""))
        self.token = os.environ.get("FRONTLINE_VOICE_SERVICE_TOKEN", "")
        if not self.token or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", room or ""):
            raise RuntimeContractError("Voice service identity and room are required")
        self.dispatch, self.room, self.soft_close_at = dispatch, room, None
        self.knowledge_revision_id = None

    def _request_sync(self, method: str, action: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        url = f"{self.base_url}/v1/internal/demos/{parse.quote(self.dispatch.demo_id, safe='')}/{action}"
        headers = {"Authorization": f"Bearer {self.token}", "X-Frontline-Room": self.room,
                   "X-Frontline-Generation": str(self.dispatch.generation),
                   "X-Frontline-Agent-Version-Id": self.dispatch.agent_version_id,
                   "Accept": "application/json"}
        payload = None
        if body is not None:
            payload = json.dumps(body, separators=(",", ":")).encode()
            headers["Content-Type"] = "application/json"
        try:
            with request.urlopen(request.Request(url, data=payload, headers=headers, method=method), timeout=8) as response:
                raw = response.read(256_001)
        except error.HTTPError as exc:
            try:
                body = json.loads(exc.read(256_001))
                if not isinstance(body, dict): body = {}
            except (ValueError, OSError): body = {}
            raise RuntimeHttpError(exc.code, code=body.get("title"),
                workflow_revision=body.get("currentWorkflowRevision"),
                state_revision=body.get("currentStateRevision")) from None
        except (error.URLError, TimeoutError) as exc:
            raise RuntimeContractError("Frontline runtime request failed") from exc
        if len(raw) > 256_000:
            raise RuntimeContractError("Frontline response exceeded limit")
        try:
            data = json.loads(raw)
        except ValueError as exc:
            raise RuntimeContractError("Frontline returned invalid JSON") from exc
        if not isinstance(data, dict):
            raise RuntimeContractError("Frontline returned invalid payload")
        return self._validate_response(action, data, body)

    def _validate_response(self, action, data, body=None):
        """Strip exactly the frozen flat envelope and fail closed at the wire boundary."""
        try:
            validate_contract("boundary.schema.json#/$defs/responseMetadata",
                              {key: data[key] for key in ("requestId", "version")})
            payload = {key: value for key, value in data.items() if key not in ("requestId", "version")}
            endpoint = _ENDPOINTS.get(action)
            if endpoint:
                validate_contract(endpoint["response"]["$ref"], payload)
            else:
                self._validate_legacy_response(action, payload)
            if action == "caller-turns":
                if (payload["clientTurnId"] != body["clientTurnId"] or payload["demoId"] != self.dispatch.demo_id
                        or payload["text"] != body["text"].strip()):
                    raise ValueError("Caller turn binding mismatch")
            if action == "task":
                # A start while a task of the same kind is open returns that task (VA-C1); every other command
                # answers for the task it named.
                same_kind_start = body["action"] == "start" and payload["task"]["kind"] == body["kind"]
                if payload["task"]["taskId"] != body["taskId"] and not same_kind_start:
                    raise ValueError("Task binding mismatch")
            if action == "task-end":
                if payload["sessionId"] != self.dispatch.demo_id or payload["reason"] != body["reason"]:
                    raise ValueError("Task terminal binding mismatch")
            if action == "turn":
                validate_workflow_state(payload["workflow"])
                turn, workflow = payload["callerTurn"], payload["workflow"]
                if (turn["clientTurnId"] != body["clientTurnId"] or turn["demoId"] != self.dispatch.demo_id
                        or turn["workflowRevision"] != workflow["revision"]):
                    raise ValueError("Turn response binding mismatch")
                if payload["nextAction"] == "escalate" and (workflow["workflowId"] != "WF-06"
                        or workflow["phase"] != "ending" or not payload["classification"]["escalationReason"]):
                    raise ValueError("Invalid escalation authority")
                if payload["nextAction"] == "confirm" and (payload["classification"]["dialogueAct"] != "affirm"
                        or payload["classification"]["status"] != "classified" or "save_request" not in workflow["allowedToolIds"]):
                    raise ValueError("Invalid confirmation authority")
            if action in ("lookup-business-fact", "services", "services/details"):
                validate_retrieval_result(payload)
                if self.knowledge_revision_id and payload["knowledgeRevisionId"] != self.knowledge_revision_id:
                    raise ValueError("Knowledge revision mismatch")
            if action in ("requests", "cases", "escalations"):
                expected = {"requests": "request", "cases": "case", "escalations": "escalation"}[action]
                if payload["operationId"] != body["operationId"] or payload["operationKind"] != expected:
                    raise ValueError("Receipt binding mismatch")
            if action in ("ending", "terminal"):
                if payload["sessionId"] != self.dispatch.demo_id or payload["reason"] != body["reason"]:
                    raise ValueError("Terminal binding mismatch")
            if action == "requests/confirmations":
                for result_key, input_key in [("callerTurnId","callerTurnId"),("fieldRevision","fieldRevision"),
                        ("readbackRevision","readbackRevision"),("readbackPayloadHash","payloadHash")]:
                    if payload[result_key] != body[input_key]: raise ValueError("Confirmation binding mismatch")
            if action in ("requests/validate", "requests/readback"):
                if payload["payloadHash"] != request_fields_hash(payload["fields"]):
                    raise ValueError("Request fields hash mismatch")
                if action == "requests/validate" and payload["missingFields"] == []:
                    validate_contract("boundary.schema.json#/$defs/completeRequestFields", payload["fields"])
            if action == "requests/readback":
                if payload["fieldRevision"] != body["fieldRevision"] or payload["payloadHash"] != body["payloadHash"]:
                    raise ValueError("Readback binding mismatch")
            return payload
        except (ValueError, KeyError, TypeError, UnicodeError) as exc:
            raise RuntimeContractError(f"Invalid {action} response") from exc

    @staticmethod
    def _validate_call_policy(data):
        """callPurpose, closingPolicy and enabledWorkflows, for a mode that may carry them.

        The original modes may omit all three and then keep the signup pitch close. A claimed mode must state its
        policy, so a missing field can never fall back to the trial wording on a guest or owner test call.
        """
        purpose, policy = MODE_CALL_POLICY[data["mode"]]
        claimed = data["mode"] in CLAIMED_MODES
        for key, expected in (("callPurpose", purpose), ("closingPolicy", policy)):
            if key not in data:
                if claimed: raise ValueError(f"Missing {key}")
            elif data[key] != expected:
                raise ValueError(f"Invalid {key}")
        if "enabledWorkflows" not in data:
            if claimed: raise ValueError("Missing enabledWorkflows")
            return
        enabled = data["enabledWorkflows"]
        if (not isinstance(enabled, list) or len(enabled) != len(set(enabled))
                or not all(isinstance(item, str) and item in WORKFLOW_IDS for item in enabled)):
            raise ValueError("Invalid enabledWorkflows")

    def _validate_legacy_response(self, action, data):
        # These existing three endpoints predate the frozen workflow schemas.
        # They grant no tool/action authority; validate their actual public shape.
        if action == "ready":
            if set(data) != {"demoId", "startedAt", "softCloseAt", "hardEndAt"} or data["demoId"] != self.dispatch.demo_id:
                raise ValueError("Invalid readiness binding")
            deadlines = [parse_deadline(data[key]) for key in ("startedAt", "softCloseAt", "hardEndAt")]
            if None in deadlines or not deadlines[0] < deadlines[1] < deadlines[2]: raise ValueError("Invalid deadlines")
        elif action == "runtime":
            required = {"demoId","mode","representedEntity","businessName","profile","facts","capabilityManifest",
                "agentVersionId","knowledgeRevisionId","generation","roomName","setupDeadlineAt","startedAt",
                "softCloseAt","hardEndAt","expiresAt"}
            optional = {"workflowRevision","stateRevision","currentValidation","currentReadback","sessionState",
                "callArchitectureVersion","currentTask","workflowId","workflowPhase",
                "callPurpose","closingPolicy","enabledWorkflows","receptionistName","businessType"}
            if not required <= set(data) or set(data)-required-optional:
                raise ValueError("Invalid runtime fields")
            if (data["demoId"] != self.dispatch.demo_id or data["agentVersionId"] != self.dispatch.agent_version_id
                    or data["generation"] != self.dispatch.generation or data["roomName"] != self.room
                    or data["mode"] not in CALL_MODES):
                raise ValueError("Invalid runtime binding")
            self._validate_call_policy(data)
            for key in ("workflowRevision","stateRevision"):
                if not _revision(data.get(key)): raise ValueError("Missing authoritative runtime revision")
            for key in ("setupDeadlineAt","expiresAt"):
                if parse_deadline(data[key]) is None: raise ValueError("Missing deadline")
            for key in ("startedAt","softCloseAt","hardEndAt"): parse_deadline(data[key])
            if data.get("sessionState") not in ("dispatching", "waiting", "active", "ending", "ended", "failed"):
                raise ValueError("Missing authoritative runtime session state")
            validation, readback = data.get("currentValidation"), data.get("currentReadback")
            for name, value, schema in (("validation", validation, "fieldValidation"), ("readback", readback, "readback")):
                if value is not None:
                    validate_contract(f"boundary.schema.json#/$defs/{schema}", value)
                    if value["payloadHash"] != request_fields_hash(value["fields"]):
                        raise ValueError("Runtime request fields hash mismatch")
                    if data["mode"] not in BUSINESS_MODES or value["workflowRevision"] > data["workflowRevision"]:
                        raise ValueError(f"Invalid runtime {name} revision or mode")
            if readback is not None:
                if validation is None or validation["missingFields"]:
                    raise ValueError("Readback lacks complete current validation")
                for key in ("workflowInstanceId", "fieldRevision", "payloadHash", "fields"):
                    if readback[key] != validation[key]: raise ValueError("Runtime readback snapshot mismatch")
            task = data.get("currentTask")
            if task is not None:
                validate_contract("task.schema.json#/$defs/task", task)
                if task["sessionId"] != self.dispatch.demo_id or task["agentVersionId"] != self.dispatch.agent_version_id:
                    raise ValueError("Runtime task binding mismatch")
            self.knowledge_revision_id = data["knowledgeRevisionId"]
            if data.get("callArchitectureVersion", "legacy-v1") not in ("legacy-v1", "bob-task-v1"):
                raise ValueError("Unsupported call architecture")
        elif action == "lookup-frontline-fact":
            if set(data) != {"facts","knowledgeRevisionId"} or data["knowledgeRevisionId"] != "frontline-product-v1" or not isinstance(data["facts"],list):
                raise ValueError("Invalid product facts")
            for fact in data["facts"]:
                if set(fact) != {"id","predicate","value","source","evidence"} or not all(isinstance(v,str) and v for v in fact.values()):
                    raise ValueError("Invalid product fact")
        else: raise ValueError("Unmapped runtime endpoint")

    async def _post(self, action: str, body: dict[str, Any]) -> dict[str, Any]:
        if action in _ENDPOINTS:
            try: validate_contract(_ENDPOINTS[action]["request"]["$ref"], body)
            except (ValueError, KeyError, TypeError, UnicodeError) as exc: raise RuntimeContractError(f"Invalid {action} request") from exc
        return await asyncio.to_thread(self._request_sync, "POST", action, body)

    async def get_bundle(self): return await asyncio.to_thread(self._request_sync, "GET", "runtime", None)
    async def ready(self):
        result = await self._post("ready", {})
        self.soft_close_at = parse_deadline(result.get("softCloseAt"))
        return result
    async def turn(self, client_turn_id, text, revision):
        return await self._post("turn", {"clientTurnId": client_turn_id, "text": text, "finalized": True,
                                         "expectedWorkflowRevision": revision})
    async def caller_turn(self, client_turn_id, text):
        return await self._post("caller-turns", {"clientTurnId": client_turn_id, "text": text, "finalized": True})
    async def assistant_turn(self, client_turn_id, text, interrupted, state_revision):
        """Record one spoken Bob turn for the display transcript (PO-E17). Text is stored trimmed, up to 2000 characters."""
        return await self._post("assistant-turns", {"clientTurnId": client_turn_id,
            "text": text.strip()[:ASSISTANT_TURN_MAX_CHARS], "interrupted": bool(interrupted),
            "expectedStateRevision": state_revision})
    async def task(self, command):
        return await self._post("task", command)
    async def task_end(self, caller_turn_id, workflow_revision, state_revision, reason):
        return await self._post("task-end", {"callerTurnId": caller_turn_id,
            "expectedWorkflowRevision": workflow_revision, "expectedStateRevision": state_revision, "reason": reason})
    async def validate_request(self, revision, caller_turn_id, fields):
        return await self._post("requests/validate", {"expectedWorkflowRevision": revision,
            "callerTurnId": caller_turn_id, "fields": fields})
    async def record_readback(self, revision, field_revision, payload_hash):
        return await self._post("requests/readback", {"expectedWorkflowRevision": revision,
            "fieldRevision": field_revision, "payloadHash": payload_hash})
    async def confirm(self, revision, caller_turn_id, field_revision, readback_revision, payload_hash):
        return await self._post("requests/confirmations", {"expectedWorkflowRevision": revision,
            "callerTurnId": caller_turn_id, "fieldRevision": field_revision,
            "readbackRevision": readback_revision, "payloadHash": payload_hash})
    async def save_request(self, operation_id, revision, confirmation_id):
        return await self._post("requests", {"operationId": operation_id,
            "expectedWorkflowRevision": revision, "confirmationId": confirmation_id})
    async def lookup_appointment(self, operation_id, revision, caller_name, action):
        return await self._post("appointments/lookup", {"operationId": operation_id,
            "expectedWorkflowRevision": revision, "callerName": caller_name, "action": action})
    async def save_case(self, operation_id, revision, context):
        return await self._post("cases", {"operationId": operation_id, "expectedWorkflowRevision": revision,
            "kind": "complaint", "context": context})
    async def record_escalation(self, operation_id, revision, reason, context):
        return await self._post("escalations", {"operationId": operation_id,
            "expectedWorkflowRevision": revision, "reason": reason, "context": context})
    async def begin_ending(self, state_revision, reason):
        return await self._post("ending", {"expectedStateRevision": state_revision, "reason": reason})
    async def terminal(self, state_revision, reason):
        return await self._post("terminal", {"expectedStateRevision": state_revision, "reason": reason})
    async def lookup_business_fact(self, query):
        return await self._post("lookup-business-fact", {"query": query[:320]})
    async def list_services(self): return await self._post("services", {})
    async def get_service_details(self, service_id):
        return await self._post("services/details", {"serviceId": service_id})
    async def lookup_frontline_fact(self, query):
        return await self._post("lookup-frontline-fact", {"query": query[:320]})
