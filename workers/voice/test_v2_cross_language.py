"""Voice v2 task commands from the Python worker against the real Node API handler (VA-C1). No model is used."""
import asyncio
import json
import os
import sys
import unittest
import urllib.request
from types import SimpleNamespace

sys.path.insert(0, os.path.dirname(__file__))
import test_cross_language as legacy
from test_cross_language import _Room, _Session
from conversation import CallFlow, FrontDesk
from runtime import RuntimeHttpError


class TaskContract(legacy.CrossLanguageContract):
    @classmethod
    def setUpClass(cls):
        old = os.environ.get('FRONTLINE_CALL_ARCHITECTURE')
        os.environ['FRONTLINE_CALL_ARCHITECTURE'] = 'bob-task-v1'
        try: super().setUpClass()
        finally:
            if old is None: os.environ.pop('FRONTLINE_CALL_ARCHITECTURE', None)
            else: os.environ['FRONTLINE_CALL_ARCHITECTURE'] = old

    # The inherited tests exercise legacy-v1 and run in their own file.
    test_request_correction_side_question_stale_duplicate_and_recovery = None
    test_browser_end_cannot_erase_authoritative_escalation = None
    test_human_interruption_preempts_real_api_readback_and_saves_one_escalation = None

    async def call(self):
        runtime = self.runtime()
        bundle = await runtime.get_bundle()
        self.assertEqual(bundle['callArchitectureVersion'], 'bob-task-v1')
        front_desk = FrontDesk(runtime, bundle)
        flow = CallFlow(_Session(), front_desk, runtime, _Room(), bundle)
        self.turns = 0
        return flow

    async def say(self, flow, text):
        self.turns += 1
        await flow.record_caller_turn(SimpleNamespace(id=f'item_{self.turns}', text_content=text))
        self.assertTrue(flow.bob.caller_turn_id, 'the caller turn was not recorded')

    async def state(self):
        return await asyncio.to_thread(lambda: json.load(urllib.request.urlopen(self.origin + '/fixture/state')))

    async def test_a_service_request_is_recorded_per_turn_and_saved_by_the_completing_record(self):
        flow = await self.call()
        await self.say(flow, 'Hi, this is Maria, I need my driveway pressure washed in Tustin.')
        started = await flow.start_task('service_request', 'Driveway pressure washing in Tustin')
        self.assertEqual(started['task']['status'], 'running')
        # Without a state in the service area, the worker takes the city as given.
        first = await flow.record({'callerName': 'Maria', 'serviceNeed': 'Driveway pressure washing', 'propertyCity': 'Tustin',
                                   'cityConfirmed': True})
        self.assertEqual(set(first['accepted']), {'callerName', 'serviceNeed', 'propertyCity', 'cityConfirmed'})
        await self.say(flow, 'It is 714-555-0182.')
        rejected = await flow.record({'contactPhone': '555-0182'})
        self.assertIn('contactPhone', rejected['rejected'])
        await flow.record({'contactPhone': '714-555-0182'})
        self.assertFalse(flow.has_receipt)
        await self.say(flow, 'Yes.')
        # The number was read back and the caller said yes.
        saved = await flow.record({'phoneConfirmed': True})
        self.assertEqual(saved['task']['status'], 'succeeded')
        self.assertTrue(flow.has_receipt)
        # The same command in the same turn replays its first result instead of failing or saving twice.
        self.assertEqual(await flow._send({**flow._command('record', fields={'phoneConfirmed': True})}), saved)
        # A reconnecting worker sees the task in its bundle.
        self.assertEqual((await flow.runtime.get_bundle())['currentTask']['status'], 'succeeded')

    async def test_a_second_start_of_the_same_kind_returns_the_open_task(self):
        flow = await self.call()
        await self.say(flow, 'I need my gutters cleaned.')
        first = await flow.start_task('service_request', 'Gutter cleaning')
        await self.say(flow, 'Yes, take my info.')
        second = await flow.start_task('service_request', 'Gutter cleaning')
        self.assertEqual(first['task']['taskId'], second['task']['taskId'])

    async def test_a_complaint_without_contact_saves_and_an_appointment_lookup_is_truthful(self):
        flow = await self.call()
        await self.say(flow, 'Your crew left a mess and I want to complain. I would rather not give my info.')
        await flow.start_task('complaint', 'Crew left a mess')
        await flow.record({'summary': 'Crew left a mess in the yard', 'noContact': True})
        complaint = await flow.finish()
        self.assertEqual(complaint['task']['status'], 'succeeded')
        self.assertTrue(complaint['task']['receipt'])
        await self.say(flow, 'Also I need to cancel my appointment, it is under Jordan Kim.')
        await flow.start_task('appointment_lookup', 'Cancel the appointment')
        await flow.record({'callerName': 'Jordan Kim', 'appointmentAction': 'cancel'})
        lookup = await flow.finish()
        self.assertEqual(lookup['task']['lookup']['kind'], 'not_found')

    async def test_finish_is_refused_for_a_service_request(self):
        flow = await self.call()
        await self.say(flow, 'I need my patio cleaned.')
        await flow.start_task('service_request', 'Patio cleaning')
        with self.assertRaises(RuntimeHttpError) as caught:
            await flow.finish()
        self.assertEqual(caught.exception.status, 409)

    async def test_a_caller_who_hangs_up_mid_request_leaves_one_needs_review_note(self):
        flow = await self.call()
        await self.say(flow, 'This is Tom Lam, 408-555-2147, I need my driveway washed.')
        await flow.start_task('service_request', 'Driveway washing')
        await flow.record({'callerName': 'Tom Lam', 'contactPhone': '408-555-2147', 'serviceNeed': 'Driveway washing'})
        await self.say(flow, "That's all, bye.")
        await flow.end_for_turn('caller_ended')
        notes = (await self.state())['outcomes'][self.meta['demoId']]
        self.assertEqual(len(notes), 1)
        # The number was never read back, so the owner sees it as unconfirmed.
        self.assertEqual(notes[0]['missingFields'], ['phoneConfirmed', 'propertyCity'])
        self.assertEqual(notes[0]['reviewStatus'], 'needs_review')

    async def test_a_person_request_mid_request_leaves_one_note(self):
        flow = await self.call()
        await self.say(flow, 'This is Ana, my number is 4085552147, I need pool cleaning.')
        await flow.start_task('service_request', 'Pool cleaning')
        await flow.record({'callerName': 'Ana', 'contactPhone': '4085552147', 'serviceNeed': 'Pool cleaning'})
        await self.say(flow, 'Can I talk to a person?')
        await flow.end_for_turn('human_preference')
        state = await self.state()
        self.assertEqual(len(state['outcomes'][self.meta['demoId']]), 1)
        self.assertEqual(state['outcomes'][self.meta['demoId']][0]['endedBecause'], 'human_preference')
        self.assertEqual(state.get('cases', {}).get(self.meta['demoId'], []), [])
        self.assertTrue(flow.closed.is_set())


if __name__ == '__main__':
    unittest.main()
