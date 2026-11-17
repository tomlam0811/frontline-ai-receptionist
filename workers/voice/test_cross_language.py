"""Offline Python worker client against the real Node API HTTP handler."""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import urllib.request
import uuid
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).parent))
from runtime import Dispatch, FrontlineRuntime, RuntimeHttpError
from agent import Bob, ToolResult, VoiceOrchestrator, exact_readback
from speech import readback_chunks

FIELDS = {"callerName":"Taylor", "contactEmail":"taylor@example.org", "serviceNeed":"Pressure washing", "propertyCity":"Anaheim"}

class _Handle:
    interrupted = False
    async def wait_for_playout(self): pass
    def exception(self): return None

class _Session:
    def __init__(self): self.prompts = []; self.tool = None
    async def interrupt(self, force=False): pass
    def generate_reply(self, **kwargs):
        self.prompts.append(kwargs)
        handle = _Handle()
        if self.tool:
            tool, self.tool = self.tool, None
            async def wait(): await tool(handle)
            handle.wait_for_playout = wait
        return handle
    def say(self, text, **kwargs): self.prompts.append({'text': text, **kwargs}); return _Handle()
    async def aclose(self): pass

class _Room:
    async def disconnect(self): pass

class _BlockingHandle(_Handle):
    def __init__(self): self.release = asyncio.Event(); self.interrupted = False
    async def wait_for_playout(self): await self.release.wait()

class _BlockingSession(_Session):
    def __init__(self): super().__init__(); self.readback = _BlockingHandle(); self.started = asyncio.Event()
    def say(self, text, **kwargs):
        self.prompts.append({'text': text, **kwargs})
        if not self.started.is_set(): self.started.set(); return self.readback
        return _Handle()
    async def interrupt(self, force=False):
        if self.started.is_set(): self.readback.interrupted = True


class CrossLanguageContract(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        node = shutil.which('node')
        if not node:
            raise RuntimeError('Node.js is required for the cross-language contract test')
        cls.process = subprocess.Popen([node, str(ROOT / 'tests/fixtures/cross-language-api.mjs'), str(Path(cls.temp.name) / 'state.json')], cwd=ROOT, stdout=subprocess.PIPE, text=True)
        cls.meta = json.loads(cls.process.stdout.readline())
        cls.origin = f"http://127.0.0.1:{cls.meta['port']}"

    @classmethod
    def tearDownClass(cls):
        cls.process.terminate(); cls.process.wait(timeout=5); cls.temp.cleanup()

    def runtime(self):
        os.environ['FRONTLINE_API_BASE_URL'] = self.origin
        os.environ['FRONTLINE_VOICE_SERVICE_TOKEN'] = self.meta['token']
        return FrontlineRuntime(Dispatch(self.meta['demoId'], self.meta['agentVersionId'], 1), self.meta['room'])

    async def asyncSetUp(self):
        await self.reset()

    async def reset(self):
        self.meta = await asyncio.to_thread(lambda: json.load(urllib.request.urlopen(self.origin + '/fixture/reset')))

    async def test_request_correction_side_question_stale_duplicate_and_recovery(self):
        runtime = self.runtime()
        bundle = await runtime.get_bundle()
        session = _Session(); bob = Bob(runtime, bundle)
        orchestrator = VoiceOrchestrator(session, bob, runtime, _Room(), bundle)
        await orchestrator.handle_turn(str(uuid.uuid4()), 'what are your hours')
        self.assertEqual(orchestrator.workflow_revision, 2)
        async def validate(handle):
            result = await bob.validate_request(SimpleNamespace(speech_handle=handle), **FIELDS)
            self.assertIsInstance(result, ToolResult)
        session.tool = validate
        await orchestrator.handle_turn(str(uuid.uuid4()), 'request details')
        self.assertEqual([item['text'] for item in session.prompts[-3:]], readback_chunks(FIELDS))
        await orchestrator.handle_turn(str(uuid.uuid4()), 'what are your hours')
        self.assertEqual((await runtime.get_bundle())['currentReadback']['fields'], FIELDS)
        await orchestrator.handle_turn(str(uuid.uuid4()), 'yes correct')
        state = await asyncio.to_thread(lambda: json.load(urllib.request.urlopen(self.origin + '/fixture/state')))
        receipts = list(state['receipts'].values())
        self.assertEqual(len(receipts), 1)
        receipt = receipts[0]
        self.assertEqual(receipt['operationKind'], 'request')
        self.assertEqual(receipt, await runtime.save_request(receipt['operationId'], receipt['workflowRevision'] - 1, state['workflows'][self.meta['demoId']]['confirmation']['confirmationId']))
        recovered = await runtime.get_bundle()
        self.assertEqual(recovered['workflowRevision'], receipt['workflowRevision'])
        with self.assertRaises(RuntimeHttpError) as stale:
            await runtime.turn(str(uuid.uuid4()), 'request details', 1)
        self.assertEqual(stale.exception.code, 'stale_workflow')

        await self.reset(); runtime = self.runtime(); bundle = await runtime.get_bundle()
        first = await runtime.turn(str(uuid.uuid4()), 'request details', bundle['workflowRevision'])
        validation = await runtime.validate_request(first['workflow']['revision'], first['callerTurn']['callerTurnId'], FIELDS)
        readback = await runtime.record_readback(validation['workflowRevision'], validation['fieldRevision'], validation['payloadHash'])
        correction = await runtime.turn(str(uuid.uuid4()), 'change the city', readback['workflowRevision'])
        self.assertEqual(correction['nextAction'], 'collect')
        self.assertIsNone((await runtime.get_bundle())['currentReadback'])

    async def test_browser_end_cannot_erase_authoritative_escalation(self):
        runtime = self.runtime(); bundle = await runtime.get_bundle()
        turn = await runtime.turn(str(uuid.uuid4()), 'I want a human', bundle['workflowRevision'])
        browser = await asyncio.to_thread(lambda: json.load(urllib.request.urlopen(urllib.request.Request(self.origin + '/fixture/browser-end', data=b'', method='POST'))))
        self.assertEqual(browser['state'], 'ending')
        operation = str(uuid.uuid4())
        context = {'summary':'Caller requested a human', 'callerTurnIds':[turn['callerTurn']['callerTurnId']]}
        receipt = await runtime.record_escalation(operation, turn['workflow']['revision'], 'human_preference', context)
        self.assertEqual(receipt, await runtime.record_escalation(operation, turn['workflow']['revision'], 'human_preference', context))
        terminal = await runtime.terminal(browser['stateRevision'], 'human_preference')
        self.assertEqual(terminal['status'], 'terminal')
        state = await asyncio.to_thread(lambda: json.load(urllib.request.urlopen(self.origin + '/fixture/state')))
        self.assertEqual(len(state['cases'][self.meta['demoId']]), 1)

    async def test_human_interruption_preempts_real_api_readback_and_saves_one_escalation(self):
        runtime = self.runtime(); bundle = await runtime.get_bundle()
        session = _BlockingSession(); bob = Bob(runtime, bundle)
        orchestrator = VoiceOrchestrator(session, bob, runtime, _Room(), bundle)
        async def validate(handle): await bob.validate_request(SimpleNamespace(speech_handle=handle), **FIELDS)
        session.tool = validate
        pending = asyncio.create_task(orchestrator.handle_turn(str(uuid.uuid4()), 'request details'))
        await session.started.wait()
        await asyncio.wait_for(orchestrator.handle_turn(str(uuid.uuid4()), 'I want a human'), 1)
        session.readback.release.set(); await pending
        state = await asyncio.to_thread(lambda: json.load(urllib.request.urlopen(self.origin + '/fixture/state')))
        self.assertIsNone(state['workflows'][self.meta['demoId']]['readback'])
        self.assertEqual(len(state['cases'][self.meta['demoId']]), 1)
        self.assertEqual(len([r for r in state['receipts'].values() if r['operationKind'] == 'escalation']), 1)


if __name__ == '__main__': unittest.main()
