"""Voice v2 conversations with the real model and a fake backend (docs/voice-agent-v2-spec.md, VA-D12, VA-T1 to T13).

Paid: runs only with FRONTLINE_VOICE_HARNESS=on and an injected OPENAI_API_KEY, for example
    infisical run --env=dev -- env FRONTLINE_VOICE_HARNESS=on python -m unittest test_v2_harness
Text only: no audio, STT or TTS. The fake backend follows the VA-C1 task contract. Each scenario prints a short
transcript when it fails, or always with FRONTLINE_VOICE_HARNESS_SHOW=on.
"""
from __future__ import annotations

import asyncio
import os
import re
import sys
import unittest
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

sys.path.insert(0, os.path.dirname(__file__))

from livekit.agents import AgentSession
from livekit.agents.voice.run_result import ChatMessageEvent, FunctionCallEvent, FunctionCallOutputEvent
from livekit.plugins import openai

from conversation import CallFlow, FrontDesk
from intake import ASKED_FOR_OWNER, WANTS_IT_SOON, note_parts

ENABLED = os.getenv('FRONTLINE_VOICE_HARNESS') == 'on' and bool(os.getenv('OPENAI_API_KEY'))
MODEL = 'gpt-4.1-mini'
DEMO_ID = '00000000-0000-4000-8000-0000000000d1'
SERVICES = [{'serviceId': 'svc-1', 'name': 'Driveway pressure washing'}, {'serviceId': 'svc-2', 'name': 'Gutter cleaning'},
            {'serviceId': 'svc-3', 'name': 'Window washing'}, {'serviceId': 'svc-4', 'name': 'Patio cleaning'},
            {'serviceId': 'svc-5', 'name': 'Storefront walkway cleaning'}, {'serviceId': 'svc-6', 'name': 'Dumpster pad cleaning'}]
FACTS = [{'predicate': 'service_area', 'value': 'Orange County, California, including Tustin, Irvine and Newport Beach'},
         {'predicate': 'hours', 'value': 'Monday to Friday, 8am to 5pm'},
         {'predicate': 'pricing', 'value': 'Quotes are given by the owner after a visit'}]
# How a job goes, as Tom described it for his plaza business (2026-10-01). Added only by the tests that ask about it.
PROCESS = {'predicate': 'process', 'value': (
    "How a job works: after the request comes in, the owner follows up to get the exact address and availability and to settle "
    "the contract and pricing. Then a worker comes out in person to check the area. Once the location is confirmed, the crew "
    "pressure washes or does the work there. When they're done, they send a confirmation with photos of the finished work and "
    "check that the customer is happy with it.")}
# A claim that the request itself went through. "I've got your name saved" is true once details are written through.
SAVE_CLAIM = re.compile(r"\b((request|it|everything|that|this|you)('s|'re| is| was| has been| are)? (all )?(saved|set)|saved (it|your request|the request|everything)"
                        r"|passed (it|this|that|your \w+) along|submitted|sent (it|this|that) (over|along)|booked)\b", re.I)
SERVICE_REQUEST_FIELDS = ('callerName', 'contactPhone', 'contactEmail', 'serviceNeed', 'propertyCity', 'propertyState', 'cityConfirmed',
                          'phoneConfirmed')
# Bob asking when works best for someone to come out.
AVAILABILITY_QUESTION = re.compile(r"(?i)\bwhen\b[^?]*\b(works?|best|good|come out|available|convenient)\b[^?]*\?|\bwhat (day|time)s?\b[^?]*\?")
# A phone number read back as words in three, three and four digit groups, such as "four oh eight, five five five".
READBACK = re.compile(r'\b(?:oh|zero|one|two|three|four|five|six|seven|eight|nine)(?:[ ,-]+(?:oh|zero|one|two|three|four|five|six|seven|eight|nine)){2},', re.I)


class FakeBackend:
    """The internal runtime API the worker calls, following VA-C1. Keeps every command for assertions."""

    def __init__(self):
        self.dispatch = SimpleNamespace(demo_id=DEMO_ID, generation=1)
        self.tasks: dict[str, dict] = {}
        self.commands: list[dict] = []
        self.replays: dict[str, dict] = {}
        self.turns: dict[str, str] = {}
        self.revision = 1
        self.facts = list(FACTS)
        self.services = list(SERVICES)

    async def caller_turn(self, client_turn_id, text):
        turn_id = str(uuid.uuid5(uuid.NAMESPACE_URL, client_turn_id))
        self.turns[turn_id] = text
        return {'callerTurnId': turn_id, 'workflowRevision': self.revision}

    def _answer(self, task, **extra):
        self.revision += 1
        return {'workflowRevision': self.revision, 'task': {**task, 'fields': dict(task['fields'])}, **extra}

    @staticmethod
    def _validate(key, value, phone_as_given=False):
        if key == 'contactPhone':
            digits = re.sub(r'\D', '', str(value))
            if len(digits) == 11 and digits.startswith('1'): digits = digits[1:]
            if re.fullmatch(r'[2-9]\d{2}[2-9]\d{6}', digits) or (phone_as_given and len(digits) == 10):
                return digits, None
            return None, ("That doesn't look like a working US number, because an area code or the next three digits never "
                          "start with 0 or 1." if len(digits) == 10 else "That isn't a complete US phone number.")
        if key == 'contactEmail':
            return (value, None) if re.fullmatch(r'[^@\s]+@[^@\s]+\.[^@\s]+', str(value)) else (None, 'that is not an email address')
        if key in ('cityConfirmed', 'phoneConfirmed', 'noContact', 'phoneAsGiven'):
            return (bool(value), None)
        if key == 'appointmentAction':
            return (value, None) if value in ('cancel', 'reschedule') else (None, 'say cancel or reschedule')
        return (str(value).strip(), None) if str(value).strip() else (None, 'it was empty')

    @staticmethod
    def _complete(fields):
        contact = (fields.get('contactPhone') and fields.get('phoneConfirmed')) or (fields.get('contactEmail') and not fields.get('contactPhone'))
        return bool(fields.get('callerName') and fields.get('serviceNeed') and contact
                    and fields.get('propertyCity') and (fields.get('propertyState') or fields.get('cityConfirmed')))

    async def task(self, command):
        assert command['callerTurnId'] in self.turns, 'commands must bind to a recorded caller turn'
        self.commands.append(command)
        if command.get('operationId') in self.replays:
            return self.replays[command['operationId']]
        action = command['action']
        if action == 'start':
            for task in self.tasks.values():
                if task['kind'] == command['kind'] and task['status'] == 'running':
                    return self._answer(task)
            task = {'taskId': command['taskId'], 'kind': command['kind'], 'status': 'running', 'goal': command['goal'],
                    'fields': {}, 'missingFields': [], 'receipt': None, 'lookup': None}
            self.tasks[task['taskId']] = task
            return self._answer(task)
        task = self.tasks[command['taskId']]
        # As on the backend: a saved service request takes changes until the call ends.
        editable = action == 'record' and task['kind'] == 'service_request' and task['status'] == 'succeeded' and task['receipt']
        if task['status'] != 'running' and not editable:
            raise AssertionError(f'{action} on a {task["status"]} task')
        if action == 'record':
            accepted, rejected = {}, {}
            for key, value in command['fields'].items():
                clean, reason = self._validate(key, value, command['fields'].get('phoneAsGiven') is True)
                if reason: rejected[key] = reason
                else: accepted[key] = clean
            # As on the backend: a new city drops the old state, and a new number drops the old confirmation.
            if 'propertyCity' in accepted:
                for key in ('propertyState', 'cityConfirmed'):
                    if key not in accepted: task['fields'].pop(key, None)
            if accepted.get('contactPhone') not in (None, task['fields'].get('contactPhone')) and 'phoneConfirmed' not in accepted:
                task['fields'].pop('phoneConfirmed', None)
            task['fields'].update(accepted)
            task['missingFields'] = [] if self._complete(task['fields']) else ['incomplete']
            if task['kind'] == 'service_request' and task['status'] == 'running' and self._complete(task['fields']):
                task['status'] = 'succeeded'
                task['receipt'] = {'operationId': command['operationId'], 'outcome': 'saved'}
            result = self._answer(task, accepted=accepted, rejected=rejected)
        elif action == 'finish':
            if task['kind'] == 'complaint':
                task['status'], task['receipt'] = 'succeeded', {'operationId': command['operationId'], 'outcome': 'saved'}
            else:
                task['status'], task['lookup'] = 'succeeded', {'kind': 'not_found'}
            result = self._answer(task)
        elif action == 'cancel':
            task['status'] = 'stopped'
            result = self._answer(task)
        else:
            raise AssertionError(f'unexpected action {action}')
        self.replays[command['operationId']] = result
        return result

    async def lookup_business_fact(self, query): return {'facts': self.facts}
    async def list_services(self): return {'services': self.services}
    async def get_service_details(self, service_id): return {'service': next((s for s in self.services if s['serviceId'] == service_id), None)}
    async def lookup_frontline_fact(self, query): return {'facts': []}

    def saved(self, kind='service_request'):
        return [task for task in self.tasks.values() if task['kind'] == kind and task['receipt']]

    def records(self):
        return [command['fields'] for command in self.commands if command['action'] == 'record']


class Call:
    """One harness call: a session with the real model, the front desk, and the v2 call flow."""

    def __init__(self, test, **bundle):
        self.test = test
        self.backend = FakeBackend()
        self.bundle = {'mode': 'business_demo', 'businessName': 'Sunny Day Exterior Cleaning', 'workflowRevision': 1,
                       'stateRevision': 1, 'closingPolicy': None, **bundle}
        self.transcript: list[str] = []
        self.ended: list[str] = []
        self.turn = 0

    async def __aenter__(self):
        self.llm = openai.LLM(model=MODEL, parallel_tool_calls=False, max_completion_tokens=160)
        self.judge_llm = openai.LLM(model=MODEL)
        self.session = AgentSession(llm=self.llm, max_tool_steps=4)
        self.front_desk = FrontDesk(self.backend, self.bundle)
        await self.front_desk.configure_tools()
        await self.session.start(self.front_desk)
        self.flow = CallFlow(self.session, self.front_desk, self.backend, AsyncMock(), self.bundle)
        # As in agent.py: a reply counts as heard once the session adds it to the conversation.
        self.session.on('conversation_item_added', self.flow.on_item_added)
        # Ending is the application's job after end_call; the harness records the reason instead of closing.
        async def end_for_turn(reason): self.ended.append(reason)
        self.flow.end_for_turn = end_for_turn
        return self

    async def __aexit__(self, *exc):
        await self.session.aclose()
        await self.llm.aclose(); await self.judge_llm.aclose()
        if exc[0] is not None or os.getenv('FRONTLINE_VOICE_HARNESS_SHOW') == 'on':
            print('\n'.join(['', f'--- transcript ({self.test.id()})', *self.transcript]))

    async def say(self, text):
        """One caller turn. The caller turn is recorded first, as on_user_turn_completed does on a live call."""
        self.turn += 1
        self.transcript.append(f'CALLER: {text}')
        await self.flow.record_caller_turn(SimpleNamespace(id=f'item_{self.turn}', text_content=text))
        result = await asyncio.wait_for(self.session.run(user_input=text), 60)
        tools, replies = [], []
        for event in result.events:
            if isinstance(event, FunctionCallEvent):
                tools.append((event.item.name, event.item.arguments))
                self.transcript.append(f'  tool {event.item.name}({event.item.arguments})')
            elif isinstance(event, FunctionCallOutputEvent):
                self.transcript.append(f'  -> {event.item.output[:200]}')
            elif isinstance(event, ChatMessageEvent) and event.item.role == 'assistant':
                replies.append(event.item.text_content or '')
                self.transcript.append(f'BOB: {replies[-1]}')
        return SimpleNamespace(result=result, tools=tools, names=[name for name, _ in tools], reply=' '.join(replies))

    async def judge(self, turn, intent):
        """Asserts the last thing Bob said in this turn meets the intent, using LiveKit's LLM judge. A turn can hold two
        messages when a reply is followed by a tool call, and the last one is what the caller is left with."""
        events = turn.result.events
        said = [index for index, event in enumerate(events) if isinstance(event, ChatMessageEvent) and event.item.role == 'assistant']
        self.test.assertTrue(said, f'Bob said nothing to judge against: {intent}')
        last = said[-1]
        await turn.result.expect[last].is_message(role='assistant').judge(self.judge_llm, intent=intent)

    def replies(self):
        return [line[5:] for line in self.transcript if line.startswith('BOB: ')]

    async def answer_availability(self, turn, answer='Weekday mornings work best.'):
        """Since 2026-10-03 Bob asks when works best before the address. Answers it when asked, and returns the next turn."""
        if AVAILABILITY_QUESTION.search(turn.reply):
            return await self.say(answer)
        return turn

    def no_save_claim_before_receipt(self, reply):
        if not self.backend.saved() and not self.backend.saved('complaint'):
            # "I don't have it saved yet" is honest, not a claim.
            for sentence in re.split(r'(?<=[.!?])\s+', reply):
                if not re.search(r"(?i)n't|\bnot\b|\byet\b", sentence):
                    self.test.assertIsNone(SAVE_CLAIM.search(sentence), f'claimed a save before any receipt: {reply!r}')


class HarnessCase(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        # The test loop runs in debug mode, which logs every model round trip as a slow callback.
        asyncio.get_running_loop().set_debug(False)


@unittest.skipUnless(ENABLED, 'paid harness: set FRONTLINE_VOICE_HARNESS=on with OPENAI_API_KEY injected')
class ServiceRequestCalls(HarnessCase):
    async def test_va_t1_details_from_the_first_turn_are_never_asked_again(self):
        async with Call(self) as call:
            first = await call.say("Hi, this is Maria, I need my driveway pressure washed in Tustin.")
            call.no_save_claim_before_receipt(first.reply)
            turn = first
            if 'start_service_request' not in first.names:
                turn = await call.say("Sure, let's do that.")
            self.assertIn('start_service_request', turn.names)
            recorded = {key: value for fields in call.backend.records() for key, value in fields.items()}
            self.assertEqual(recorded.get('callerName'), 'Maria')
            self.assertIn('Tustin', recorded.get('propertyCity', ''))
            self.assertTrue(recorded.get('serviceNeed'))
            await call.judge(turn, 'Asks for a phone number to reach the caller. Does not ask again for their name (addressing them by name '
                             'is fine), the service, or the city.')
            call.no_save_claim_before_receipt(turn.reply)
            turn = await call.say("It's 714-555-0182.")
            self.assertRegex(turn.reply, READBACK)
            await call.judge(turn, 'Reads the phone number back digit by digit in groups and asks if it is right. Asks nothing else.')
            turn = await call.say('Yes.')
            self.assertEqual(len(call.backend.saved()), 1)
            self.assertEqual(call.backend.saved()[0]['fields'].get('propertyState'), 'California')
            await call.judge(turn, 'Tells the caller the request was passed along or saved for the manager, and asks if there is anything else.')

    async def test_va_t2_name_and_number_in_separate_turns_are_each_asked_once(self):
        async with Call(self) as call:
            await call.say('I need my gutters cleaned.')
            turn = await call.say("Yes please, go ahead.")
            if not call.backend.tasks:
                turn = await call.say("Yes, take my info.")
            # Starting on "I need my gutters cleaned" is fine too; what matters is that one request is open.
            self.assertEqual(len(call.backend.tasks), 1, call.replies())
            turn = await call.say('Tom Lam')
            # Only the closing question matters: "Got your name, Tom. What's the best number?" does not ask for the name.
            self.assertNotRegex(turn.reply.lower(), r'(?:^|[.!?]\s)[^.!?]*\bname\b[^.!?]*\?$')
            turn = await call.say('408-555-2147')
            recorded = {key: value for fields in call.backend.records() for key, value in fields.items()}
            self.assertEqual(recorded.get('contactPhone'), '4085552147')
            self.assertIn('Tom', recorded.get('callerName', ''))
            self.assertRegex(turn.reply, READBACK)
            turn = await call.answer_availability(await call.say("Yep, that's right."))
            await call.judge(turn, 'Asks for the address or the city of the job. Does not ask for the name or the phone number again and '
                             'does not ask for an email.')

    async def test_a_corrected_number_is_read_back_again_before_it_counts(self):
        async with Call(self) as call:
            await call.say('I need my windows washed.')
            turn = await call.say("Sure, I'm Lee, 714-555-0183.")
            if not READBACK.search(turn.reply):
                turn = await call.say("Lee, 714-555-0183.")
            self.assertRegex(turn.reply, READBACK)
            turn = await call.say("No, the last part is zero one eight four.")
            self.assertIn('7145550184', [fields.get('contactPhone') for fields in call.backend.records()])
            self.assertRegex(turn.reply, READBACK)
            await call.judge(turn, 'Reads back the corrected number, ending in zero one eight four, and asks if it is right.')
            turn = await call.answer_availability(await call.say('Yes.'))
            await call.judge(turn, 'Asks for the address or the city of the job or place. Does not call it a house, since the caller '
                             'never said house.')

    async def test_va_t3_a_detail_inside_a_question_is_recorded_and_the_question_answered(self):
        async with Call(self) as call:
            await call.say("Hi, I'm Dana and I need my windows washed.")
            turn = await call.say('Sure. My number is 949-555-0147.')
            if 'start_service_request' not in turn.names:
                turn = await call.say('949-555-0147.')
            turn = await call.say('It\'s in Irvine, do you guys go there?')
            recorded = {key: value for fields in call.backend.records() for key, value in fields.items()}
            self.assertIn('Irvine', recorded.get('propertyCity', ''))
            self.assertIn('Irvine', turn.reply)
            self.assertNotRegex(turn.reply.lower(), r'(what|which) (city|state)')
            if call.backend.saved():
                self.assertTrue(call.backend.saved()[0]['fields'].get('phoneConfirmed'))
                await call.judge(turn, 'Tells the caller the request is passed along or that someone will follow up.')

    async def test_va_t4_a_bare_city_takes_its_state_from_the_service_area_and_saves(self):
        async with Call(self) as call:
            await call.say('I need my patio cleaned.')
            turn = await call.say("Yeah, I'm Sam, 714-555-0199.")
            if 'start_service_request' not in turn.names:
                turn = await call.say("Sam, 714-555-0199.")
            if READBACK.search(turn.reply):
                await call.say('Yes, that is right.')
            turn = await call.say('Tustin.')
            self.assertEqual(len(call.backend.saved()), 1)
            self.assertEqual(call.backend.saved()[0]['fields'].get('propertyState'), 'California')
            self.assertNotRegex(turn.reply, r'(?i)california\?')

    async def test_va_t6_after_the_save_a_question_is_answered_then_a_goodbye_ends_the_call(self):
        async with Call(self) as call:
            await call.say("Hi, I'm Maria Lopez, I need my driveway pressure washed in Tustin, California.")
            turn = await call.say('Yes, go ahead, my number is 714-555-0182.')
            for answer in ('Yes, that number is right.', 'Yes.'):
                if call.backend.saved(): break
                turn = await call.say(answer)
            self.assertEqual(len(call.backend.saved()), 1)
            turn = await call.say('What are your hours?')
            self.assertEqual(call.ended, [])
            await call.judge(turn, 'Answers with the business hours, Monday to Friday 8am to 5pm.')
            await call.say("No, that's all, thanks.")
            self.assertEqual(call.ended, ['caller_ended'])

    async def test_va_t7_urgency_is_noted_without_a_promise_and_intake_continues(self):
        async with Call(self) as call:
            turn = await call.say('My gutters are overflowing, I need someone today.')
            self.assertEqual(call.ended, [])
            await call.judge(turn, 'Does not promise that someone will come today. Saying it will mark this urgent, or that the manager '
                             'will know it is urgent, is expected. Then asks a short question about the problem, offers gutter cleaning, '
                             'or starts taking the details.')
            started = 'start_service_request' in turn.names
            turn = await call.say('Okay, fine, take my info.')
            self.assertTrue(started or 'start_service_request' in turn.names)
            self.assertEqual(call.ended, [])
            # The urgency said before the request started goes on the request's first write.
            self.assertTrue(any(WANTS_IT_SOON in (fields.get('notes') or '') for fields in call.backend.records()),
                            call.backend.records())

    async def test_va_t8_a_person_request_keeps_the_call_and_tells_the_owner(self):
        async with Call(self) as call:
            turn = await call.say('Can I talk to a person?')
            self.assertEqual(call.ended, [])
            self.assertIn('ask_for_owner', turn.names)
            await call.judge(turn, OWNER_AWAY_INTENT + ' Offers to take their name and number so the manager can follow up.')
        async with Call(self) as call:
            await call.say('I need my windows washed.')
            turn = await call.say("Sure, I'm Lee.")
            if 'start_service_request' not in turn.names:
                await call.say("Yes, I'm Lee.")
            turn = await call.say('Actually, can I just talk to a real person?')
            self.assertEqual(call.ended, [])
            self.assertTrue(any(ASKED_FOR_OWNER in (fields.get('notes') or '') for fields in call.backend.records()),
                            call.backend.records())
            await call.judge(turn, OWNER_AWAY_INTENT + ' Then asks for a detail still missing from the request, such as the '
                             'phone number.')

    async def test_a_saved_request_takes_a_new_city_and_the_exact_address(self):
        async with Call(self) as call:
            await call.say("Hi, I'm Maria Lopez, I need my driveway pressure washed in Irvine, California.")
            turn = await call.say('Yes, go ahead, my number is 714-555-0182.')
            for answer in ('Yes, that number is right.', 'Yes.'):
                if call.backend.saved(): break
                turn = await call.say(answer)
            self.assertEqual(len(call.backend.saved()), 1)
            turn = await call.say("Oh wait, sorry, it's actually in Tustin, not Irvine. The address is twelve Main Street.")
            for _ in range(2):
                fields = call.backend.saved()[0]['fields']
                if fields.get('propertyCity') == 'Tustin' and '12 Main' in (fields.get('notes') or '').replace('Twelve', '12').replace('twelve', '12'):
                    break
                turn = await call.say("Yes, Tustin, and the address is twelve Main Street.")
            fields = call.backend.saved()[0]['fields']
            self.assertEqual(fields.get('propertyCity'), 'Tustin', call.replies())
            self.assertRegex(fields.get('notes') or '', r'(?i)(?:12|twelve) Main', call.replies())
            self.assertEqual(len([task for task in call.backend.tasks.values() if task['kind'] == 'service_request']), 1)
            await call.judge(turn, 'Acknowledges the new city or address, for example by saying it is updated or by repeating the new '
                             'place. Does not ask for the name or number again, and does not ask which state.')

    async def test_va_t11_no_save_claim_before_the_receipt_and_no_dead_end_reply(self):
        async with Call(self) as call:
            for line in ('I need my patio cleaned.', 'Yes please.', "I'm Ana.", 'Did you get all that saved already?'):
                turn = await call.say(line)
                call.no_save_claim_before_receipt(turn.reply)
                self.assertNotEqual(turn.reply.strip(), 'Let me get the rest of your details first.')
                if line == "I'm Ana.":
                    # VA-D8: a detail is written through in the turn it is given, so a hang-up now still leaves the name.
                    self.assertIn('Ana', [fields.get('callerName') for fields in call.backend.records()])


@unittest.skipUnless(ENABLED, 'paid harness: set FRONTLINE_VOICE_HARNESS=on with OPENAI_API_KEY injected')
class ComplaintAndAppointmentCalls(HarnessCase):
    async def test_va_t9_a_complaint_is_saved_and_contact_is_asked_once(self):
        async with Call(self) as call:
            turn = await call.say('Your crew left a mess in my yard yesterday and I want to complain.')
            if 'report_complaint' not in turn.names:
                turn = await call.say('Yes, please take down my complaint.')
            self.assertIn('report_complaint', turn.names)
            turn = await call.say("I'd rather not give my info.")
            if not call.backend.saved('complaint'):
                turn = await call.say("No, I don't want to give a name or number.")
            self.assertEqual(len(call.backend.saved('complaint')), 1)
            self.assertNotRegex(turn.reply.lower(), r'refund|fix it|call you back')

    async def test_va_t10_an_appointment_lookup_starts_without_asking_the_name_first(self):
        async with Call(self) as call:
            turn = await call.say('I need to cancel my appointment.')
            self.assertIn('check_appointment', turn.names)
            turn = await call.say("It's under Jordan Kim.")
            await call.judge(turn, 'Says no appointment was found under that name, and offers to take a new service request. Does not say it was cancelled.')


@unittest.skipUnless(ENABLED, 'paid harness: set FRONTLINE_VOICE_HARNESS=on with OPENAI_API_KEY injected')
class ReplayedFailures(HarnessCase):
    """VA-T13: the moments production call b0610848 went wrong, reconstructed from the spec's diagnosis (VA-P1)."""

    async def test_b0610848_service_is_not_asked_again_and_no_email_after_a_phone(self):
        async with Call(self) as call:
            await call.say('Hi, I need my gutters cleaned at my house.')
            turn = await call.say("Yeah, let's do it. My name's Chris and my number is 949-555-0147.")
            if not READBACK.search(turn.reply):
                turn = await call.say("Chris, 949-555-0147.")
            await call.judge(turn, 'Reads the phone number back to confirm it. Does not ask what service they need, and does not ask for an email.')

    async def test_b0610848_the_phone_is_never_asked_for_twice(self):
        async with Call(self) as call:
            await call.say('I need my driveway pressure washed.')
            turn = await call.say("Sure. I'm Chris, 949-555-0147.")
            if not READBACK.search(turn.reply):
                turn = await call.say("Chris, 949-555-0147.")
            await call.say("Yep, that's it.")
            turn = await call.say('Newport Beach.')
            self.assertEqual(len(call.backend.saved()), 1)
            await call.judge(turn, 'Says the request is passed along or that someone will follow up. Does not ask for a phone number. '
                             'Asking if there is anything else is fine.')
            self.assertEqual(sum(1 for fields in call.backend.records() if 'contactPhone' in fields), 1)

    async def test_the_business_phone_number_is_looked_up_and_read_out(self):
        """Tom's 2026-10-02 Bayside call: asked for the business's number, which the website lists, Blake said it didn't have it."""
        async with Call(self) as call:
            call.backend.facts.append({'predicate': 'identity_contact', 'value': 'Call us 1 (800) 846-9274'})
            turn = await call.say("Hi, what's your phone number?")
            self.assertIn('lookup_business_fact', turn.names)
            await call.judge(turn, 'Gives the business phone number, 1 800 846 9274, spoken as words or digits. Does not say it '
                             "doesn't have a number.")


PLAZA ="Hey Bob, I have a friend who runs a commercial plaza. He needs cleaning in front of each store and around the trash area. Can you help me with that?"


@unittest.skipUnless(ENABLED, 'paid harness: set FRONTLINE_VOICE_HARNESS=on with OPENAI_API_KEY injected')
class ReplayedPlazaCalls(HarnessCase):
    """Four production calls with the same script: today's call and the three before it. Tom made them as the owner."""

    def owner_call(self):
        return Call(self, mode='owner_test', callPurpose='owner_test', closingPolicy='test_summary', receptionistName='Bob')

    async def start(self, call, contact_line):
        turn = await call.say(PLAZA)
        self.assertLessEqual(len(re.findall(r"[\w']+", turn.reply)), 35, turn.reply)
        self.assertLessEqual(len(re.findall(r'[.!?](?:\s|$)', turn.reply)), 2, turn.reply)
        # When the model starts the request in this same turn, the offer is replaced by the first question.
        self.assertRegex(turn.reply, r'(?i)\b(help|we (?:do|can|offer|have|clean|wash|handle))\b')
        turn = await call.say('Yeah, sounds good.')
        self.assertIn('start_service_request', turn.names)
        return await call.say(contact_line)

    def assert_no_repeats(self, call):
        replies = call.replies()
        self.assertLessEqual(sum(reply.count('Tom') for reply in replies), 2, replies)
        self.assertLessEqual(sum(len(re.findall(r'(?i)\bthank', reply)) for reply in replies), 2, replies)
        self.assertFalse(any('everything right' in reply.lower() for reply in replies), replies)

    async def test_today_a_short_number_is_asked_again_then_read_back_and_the_city_saves(self):
        async with self.owner_call() as call:
            turn = await self.start(call, 'Oh, my name is Tom Lam, phone number is four eight five five five two one four seven.')
            await call.judge(turn, 'Says back the digits it heard and asks the caller to say the number again.')
            turn = await call.say("So I said it's four zero eight five five five two one four seven.")
            self.assertRegex(turn.reply, READBACK)
            self.assertIn('four oh eight, five five five, two one four seven', turn.reply.lower().replace('zero', 'oh'))
            self.assertTrue(turn.reply.rstrip().endswith('?'), turn.reply)
            turn = await call.answer_availability(await call.say('Yes.'))
            if re.search(r"friend|calling for|plaza'?s name|property|name or (?:the )?(?:street )?address|contact|\bwho\b", turn.reply.lower()):
                # The caller is asking for a friend, so Bob asks once who that is and which property before the city.
                turn = await call.say("I don't know his name. It's Westpark Plaza.")
            turn = await call.answer_availability(turn)
            await call.judge(turn, 'Asks what city or address the plaza or job is at. Does not use the phrase "located".')
            turn = await call.say('Uh, what do you mean?')
            await call.judge(turn, 'Asks again where the plaza is, such as the city or address, rephrased or with a few example cities, '
                             'not word for word the same question.')
            turn = await call.say("Yeah, so it's, uh, the location is based in Irvine.")
            self.assertEqual(len(call.backend.saved()), 1)
            self.assertEqual(call.backend.saved()[0]['fields'].get('propertyState'), 'California')
            await call.judge(turn, 'Says the request was passed along to the manager and asks if there is anything else. Does not ask to '
                             'confirm the state, and does not suggest an appointment day or time. Saying when the manager will usually '
                             'get back to them is fine.')
            await call.say("No, that's it.")
            self.assertEqual(call.ended, ['caller_ended'])
            self.assert_no_repeats(call)

    async def test_6f5e1287_an_address_for_later_saves_at_once_without_a_confirmation_loop(self):
        async with self.owner_call() as call:
            turn = await self.start(call, 'Yeah, so my name is Tom Lam. My phone number is four oh eight five five five two one four seven.')
            self.assertRegex(turn.reply, READBACK)
            await call.say('Yes.')
            turn = await call.say("Oh, this is based somewhere in Irvine. I'll provide the exact address later.")
            self.assertEqual(len(call.backend.saved()), 1)
            await call.judge(turn, 'Says the request was passed along to the manager, and does not ask for the street address. Asking if '
                             'there is anything else is fine.')
            turn = await call.say("Yeah, so I guess like what's the next step?")
            await call.judge(turn, 'Says the manager will review the request and follow up. Saying when they will usually get back to the '
                             'caller is fine, but it does not suggest an appointment day or time.')
            self.assert_no_repeats(call)

    async def test_b0610848_no_service_email_or_phone_is_asked_again(self):
        async with self.owner_call() as call:
            turn = await self.start(call, 'My name is Tom Lam, phone number is four oh eight five five five two one four seven.')
            self.assertRegex(turn.reply, READBACK)
            await call.say('Yes.')
            turn = await call.say("The plaza is located in Irvine. I'll follow up and give you the address later.")
            self.assertEqual(len(call.backend.saved()), 1)
            self.assertEqual(sum(1 for fields in call.backend.records() if 'contactPhone' in fields), 1)
            for reply in call.replies():
                self.assertNotRegex(reply.lower(), r'email|what service|best time')
            self.assert_no_repeats(call)

    async def test_c231c59a_the_next_step_answer_offers_nothing_bob_cannot_do(self):
        async with self.owner_call() as call:
            turn = await self.start(call, 'Uh, my name is Tom Lam. Phone number is four oh eight five five five two one four seven.')
            self.assertRegex(turn.reply, READBACK)
            await call.say('Correct.')
            await call.say("It is located in Irvine, but for the exact address, I'll provide that later.")
            self.assertEqual(len(call.backend.saved()), 1)
            turn = await call.say("I guess like what's the next step in terms of the process?")
            await call.judge(turn, 'Says the manager will follow up or explain, or that the request is with them. Does not offer a reminder, an appointment, '
                             'a day or a time.')
            await call.say("No, I'm good. Thank you.")
            self.assertEqual(call.ended, ['caller_ended'])
            self.assert_no_repeats(call)



# The 2026-09-30 owner test call (docs/voice-call-fixes-2026-09-30.md), with the caller's number replaced by 408-555-0153.
FRIEND = ["Hey Bob. I I'm going for a friend who is managing commercial plaza",
          "And um, he needs some cleaning in front of each of the store within that plaza as well as around the trash area. "
          "Can you help me with that?"]
METHOD_QUESTION = ("Can you tell me like a little bit more about like where you guys exactly do? Uh, like You know, how are you guys "
                   "gonna clean this property?")
CONCERN = ["Well, kind of, yes, um Also like I lost, like I heard from a friend that you guys Uh, last time when you cleaned there "
           "probably, you didn't clean Like some parts and it wasn't well received. So like, how can you ensure that like",
           "My probably, my friend probably not gonna have the same issue."]
# What Bob says when the caller asks for the owner (Tom, 2026-10-01).
OWNER_AWAY_INTENT = ("Says nobody can come to the phone right now or that they aren't available, that Bob will let them know and they'll follow up as soon as "
                     "possible, and apologizes for the inconvenience, in its own words. Saying the manager will get back to them is fine. Does "
                     "not say goodbye, and does not say it will transfer or connect them to someone now.")
OFFER_AGAIN = re.compile(r"(?i)\b(?:want|like|shall|should) (?:me|i) to (?:pass|send|forward)\b(?![^?]*\b(?:concern|complaint|worry|issue)\b)")


@unittest.skipUnless(ENABLED, 'paid harness: set FRONTLINE_VOICE_HARNESS=on with OPENAI_API_KEY injected')
class ReplayedConcernCall(HarnessCase):
    """VCF-2026-09-30 fixes 1, 2 and 5, replayed from Tom's owner test call to Bob for the plaza."""

    def owner_call(self):
        return Call(self, mode='owner_test', callPurpose='owner_test', closingPolicy='test_summary', receptionistName='Bob')

    async def to_saved(self, call):
        """The first half of the call, answering whatever Bob asks, until the request is saved. The phone number is split
        across two turns the way the caller said it."""
        for line in FRIEND:
            turn = await call.say(line)
        turn = await call.say('Uh, sure, um')
        if 'start_service_request' not in turn.names and not call.backend.tasks:
            turn = await call.say('Yeah, pass it along.')
        self.assertTrue(call.backend.tasks, 'no service request was started')
        answered = set()
        for _ in range(8):
            if call.backend.saved():
                break
            reply = turn.reply.lower()
            if READBACK.search(turn.reply):
                turn = await call.say('Yes.')
            elif 'friend' not in answered and re.search(r"friend|his name|plaza'?s name|property|address", reply):
                answered.add('friend')
                turn = await call.say("I don't know his last name, it's Mike. The place is Westpark Plaza.")
            elif 'phone' not in answered and re.search(r'number|phone|reach', reply):
                answered.add('phone')
                await call.say('My name is Tom Lam. My phone number is four oh eight')
                turn = await call.say('Five five five oh one five three.')
            elif re.search(r'\bname\b', reply):
                turn = await call.say('Tom Lam.')
            else:
                turn = await call.say("Uh, it's in Irvine.")
        self.assertEqual(len(call.backend.saved()), 1, call.replies())
        return turn

    async def test_fix5_a_number_split_across_turns_is_one_number_read_back_in_full(self):
        async with self.owner_call() as call:
            await self.to_saved(call)
            phones = [fields['contactPhone'] for fields in call.backend.records() if 'contactPhone' in fields]
            self.assertEqual([re.sub(r'\D', '', phone) for phone in phones], ['4085550153'])
            readbacks = [reply for reply in call.replies() if READBACK.search(reply)]
            self.assertTrue(readbacks, call.replies())
            self.assertIn('four oh eight, five five five, oh one five three', readbacks[0].lower().replace('zero', 'oh'))
            self.assertFalse(any('oh one five, three' in reply.lower() for reply in call.replies()), call.replies())

    async def test_fix2_give_me_to_the_owner_after_the_save_starts_no_second_request(self):
        async with self.owner_call() as call:
            await self.to_saved(call)
            turn = await call.say('No, I guess like what is the next step?')
            turn = await call.say(METHOD_QUESTION)
            await call.judge(turn, 'The first sentence answers how the work is done, using only the listed services and facts, or says '
                             "Bob isn't sure and the manager can walk them through it. Does not claim steam, heat or high temperature, "
                             'or any service not listed.')
            turn = await call.say('Why were you pass the information? Just give me to the owner.')
            self.assertEqual(len([task for task in call.backend.tasks.values() if task['kind'] == 'service_request']), 1)
            saved_at = next(index for index, line in enumerate(call.transcript) if line.startswith('  -> The request is saved'))
            for line in call.transcript[saved_at + 1:]:
                if line.startswith('BOB: '):
                    self.assertNotRegex(line, OFFER_AGAIN)
            # Asking for the owner keeps the call going and puts a call-back note on the saved request.
            self.assertEqual(call.ended, [])
            self.assertIn(ASKED_FOR_OWNER, call.backend.saved()[0]['fields'].get('notes') or '')
            # Tom, 2026-10-03: asking whether they have any other questions is fine here.
            await call.judge(turn, OWNER_AWAY_INTENT + ' Does not start taking the details again and does not ask for the name, '
                             'number or city. Asking if there is anything else or any other question is fine.')

    async def test_fix1_a_concern_about_past_work_is_acknowledged_and_never_ends_the_call(self):
        async with self.owner_call() as call:
            await self.to_saved(call)
            await call.say(METHOD_QUESTION)
            await call.say("Okay. And what areas do you cover?")
            heard = None
            for line in CONCERN:
                turn = await call.say(line)
                self.assertEqual(call.ended, [], call.replies())
                if heard is None and ('report_complaint' in turn.names or re.search(r'(?i)sorry|concern', turn.reply)):
                    heard = turn
            heard = heard or turn
            # Bob may take the complaint on the first half of the concern, so the turn judged is the one that heard it.
            await call.judge(heard, 'Acknowledges the concern about past work in a sentence without deciding fault, and either '
                             'offers to pass it to the manager or says it has been passed along. Does not say goodbye.')
            if not call.backend.saved('complaint'):
                turn = await call.say('Yes, please pass that along.')
            self.assertEqual(len(call.backend.saved('complaint')), 1, call.replies())
            self.assertEqual(len([task for task in call.backend.tasks.values() if task['kind'] == 'service_request']), 1)
            self.assertNotRegex(turn.reply.lower(), r'your (?:name|number)|phone number')
            self.assertEqual(call.ended, [])
            await call.say("No, that's all, thanks.")
            self.assertEqual(call.ended, ['caller_ended'])


# The 2026-10-01 owner test call: Tom asking for his friend's plaza, then about the process and how soon.
TOMS_PLAZA = ["Hey Bob, uh, I'm calling in for a friend who managed a commercial plaza",
         "I need clean in front of each store and around the trash area. Can you help me with that?"]
PROCESS_QUESTION = 'Can you tell me more about how the process will look like?'
NEXT_STEPS_INTENT = ("Starts with what happens next: the request goes to the manager, or the manager will review it and follow "
                     "up, for example about the details or a quote. Then asks for a contact name and phone number.")
# Tom's sixth 2026-10-01 call: Bob asked for "your friend's name and a phone number". He wants one neutral contact
# question, so the caller decides whose name and number to give.
WHOSE_CONTACT = (r"(?i)friend'?s (?:name|number|phone)|(?:you|yourself) or (?:your |the )?(?:friend|them|him|her)|"
                 r"(?:follow up with|reach|contact) (?:your |the )?friend|whether .{0,40}(?:you|friend)")
# Catalog words Tom did not understand on his 2026-10-01 call ("dumpster pads and corrals").
TRADE_TERMS = r"(?i)\bpads?\b|corral"


@unittest.skipUnless(ENABLED, 'paid harness: set FRONTLINE_VOICE_HARNESS=on with OPENAI_API_KEY injected')
class ReplayedPlazaCall(HarnessCase):
    """Tom's 2026-10-01 feedback: offer the services instead of echoing the need, say the next step, explain the process."""

    async def ask_about_the_plaza(self, call):
        for line in TOMS_PLAZA:
            turn = await call.say(line)
        self.assertNotIn('start_service_request', turn.names)
        return turn

    async def test_matching_services_are_offered_then_a_yes_hears_the_next_step(self):
        async with Call(self) as call:
            turn = await self.ask_about_the_plaza(call)
            self.assertTrue(turn.reply.rstrip().endswith('?'), call.replies())
            self.assertNotRegex(turn.reply, OFFER_AGAIN)
            self.assertNotRegex(turn.reply, TRADE_TERMS)
            await call.judge(turn, 'Names one or two fitting services in plain everyday words, such as cleaning in front of the '
                             "stores and around the trash area, and asks if that would work or if they're interested. Does not "
                             'offer to pass details to the manager.')
            turn = await call.say("Yeah, I'm interested.")
            self.assertIn('start_service_request', turn.names)
            await call.judge(turn, NEXT_STEPS_INTENT)

    async def test_the_third_plaza_call_confirms_a_spelled_name_and_wraps_up_warmly(self):
        """Tom's third 2026-10-01 call: "Da Vien", spelled out, was saved as "Dog bin", and "sounds good, thank you" got only
        "Take care!"."""
        async with Call(self) as call:
            await self.ask_about_the_plaza(call)
            turn = await call.say('Yes, if you provide it as a service, yes.')
            self.assertIn('start_service_request', turn.names)
            self.assertNotRegex(turn.reply, WHOSE_CONTACT, call.replies())
            await call.judge(turn, NEXT_STEPS_INTENT)
            turn = await call.say('My friend name is Tom Lam. His phone number is 408 555 2147.')
            for answer in ('Yes.', 'Yes, that is right.'):
                if re.search(r'(?i)property|address|city', turn.reply): break
                turn = await call.say(answer)
            turn = await call.say('Yeah, so the property is called Dog bin, uh, D-A V I E N. Those two are separate words. '
                                  "It's like a coffee shop, in Los Angeles.")
            self.assertRegex(turn.reply, r'(?i)V\W{0,3}I\W{0,3}E\W{0,3}N', call.replies())
            self.assertTrue(turn.reply.rstrip().endswith('?'), call.replies())
            notes = [record.get('notes') or '' for record in call.backend.records()]
            self.assertTrue(any('Da Vien' in note for note in notes), notes)
            self.assertFalse(any('Dog' in note for note in notes), notes)
            for answer in ("Yes, that's right.", 'Yes.'):
                turn = await call.say(answer)
                if call.backend.saved(): break
            self.assertEqual(len(call.backend.saved()), 1, call.replies())
            turn = await call.say('Okay, sounds good. Thank you.')
            self.assertEqual(call.ended, [], call.replies())
            await call.judge(turn, "A warm wrap-up: says you're welcome, invites them to ask if they have other questions, and "
                             'wishes them a good day or says the manager will be in touch. It does not ask for any detail.')
            await call.say('Okay, thanks. Bye.')
            self.assertEqual(call.ended, ['caller_ended'], call.replies())
            # Tom (2026-10-01): Bob calls the person who follows up the manager.
            self.assertFalse([reply for reply in call.replies() if re.search(r'(?i)\bowner\b', reply)], call.replies())

    async def test_the_fourth_plaza_call_a_yes_with_a_question_starts_the_request_and_spells_the_name(self):
        """Tom's fourth 2026-10-01 call: a yes with "what's the process?" got the offer again, and Lam was spelled L-A-M."""
        async with Call(self) as call:
            call.backend.facts.append(PROCESS)
            turn = await call.say("Hey Bob, I'm calling in for Fred. He manages a commercial plaza that needs cleaning in front of "
                                  'each store and around the trash area. Uh, can you help me with that?')
            self.assertNotRegex(turn.reply, TRADE_TERMS)
            turn = await call.say("Uh, yes. Um, so I guess like what's the next step? Like what does the process look like?")
            self.assertIn('start_service_request', turn.names, call.replies())
            self.assertNotRegex(turn.reply, OFFER_AGAIN)
            await call.judge(turn, 'Briefly gives at least one step of how a job goes from what the business wrote, such as the '
                             'manager following up or someone checking the area, then asks for a contact name and phone number. '
                             'Does not ask whether they want the request passed along; asking for details to pass along is fine.')
            turn = await call.say('Uh, name is Tom Lamb. Phone number is four oh eight five five five two one four seven. '
                                  'Last name is Lam, L-A-M.')
            self.assertRegex(turn.reply, r'(?i)L\W{0,3}A\W{0,3}M', call.replies())
            self.assertRegex(turn.reply, READBACK, call.replies())
            turn = await call.say('Yes.')
            names = [record['callerName'] for record in call.backend.records() if record.get('callerName')]
            self.assertEqual(names[-1:], ['Tom Lam'], call.replies())
            for answer in ("It's Irvine. But I'm not sure about the exact address, I'll let your manager know later.", 'Irvine.'):
                if call.backend.saved(): break
                turn = await call.say(answer)
            self.assertEqual(len(call.backend.saved()), 1, call.replies())
            await call.say("Oh no, that's it.")
            self.assertEqual(call.ended, ['caller_ended'], call.replies())

    async def test_the_sixth_plaza_call_asks_for_one_contact_and_the_caller_picks_whose(self):
        """Tom's sixth 2026-10-01 call: Bob asked for the friend's name and number instead of a contact name and number."""
        for contact, name in (("Can you contact my friend? His name is Magnus, and his number is 408 555 2147.", 'Magnus'),
                              ("You can reach me. My name is Tom Lam, and my number is 408 555 2147.", 'Tom Lam')):
            with self.subTest(name=name):
                async with Call(self) as call:
                    await call.say("Hey Bob, uh, I'm calling for a friend. He manages a commercial plaza and needs cleaning in "
                                   'front of each store and around the trash area. How are you guys gonna help?')
                    turn = await call.say("Yeah, that'd be great. Um, I guess like what's the next step?")
                    self.assertIn('start_service_request', turn.names, call.replies())
                    self.assertNotRegex(turn.reply, WHOSE_CONTACT, call.replies())
                    self.assertRegex(turn.reply, r'(?i)contact name', call.replies())
                    await call.judge(turn, NEXT_STEPS_INTENT)
                    await call.say(contact)
                    names = [record.get('callerName') for record in call.backend.records() if record.get('callerName')]
                    self.assertEqual(names[-1:], [name], call.replies())

    async def test_the_process_is_explained_from_what_the_owner_wrote(self):
        async with Call(self) as call:
            call.backend.facts.append(PROCESS)
            await self.ask_about_the_plaza(call)
            await call.say('Uh, sure, I guess like')
            turn = await call.say(PROCESS_QUESTION)
            await call.judge(turn, 'Explains how a job goes using the steps the business gave, in order, covering at least three of: '
                             'the manager or owner follows up about the address, timing and pricing; a worker checks the area in person; the '
                             'work is done; photos are sent when it is done. Does not invent other steps. Asking afterward for their name and '
                             'number is fine.')

    async def test_without_a_process_on_file_bob_says_the_owner_can_walk_them_through_it(self):
        async with Call(self) as call:
            await self.ask_about_the_plaza(call)
            await call.say('Uh, sure, I guess like')
            turn = await call.say(PROCESS_QUESTION)
            await call.judge(turn, "Says Bob isn't sure about the process or doesn't have those details. Saying the manager can explain or follow up, or going on to ask for a contact, is fine. "
                             'May mention a listed fact such as quotes after a visit. Does not '
                             'describe steps the business never gave.')

    async def save_maria(self, call):
        await call.say("Hi, I'm Maria Lopez, I need my driveway pressure washed in Irvine, California.")
        await call.say('Yes, go ahead, my number is 714-555-0182.')
        for answer in ('Yes, that number is right.', 'Yes.'):
            if call.backend.saved(): break
            await call.say(answer)
        self.assertEqual(len(call.backend.saved()), 1)

    async def test_va_t21_a_how_do_you_do_it_question_after_the_save_looks_up_the_process(self):
        async with Call(self) as call:
            call.backend.facts.append(PROCESS)
            await self.save_maria(call)
            turn = await call.say('Okay. And how do you guys usually clean it?')
            self.assertIn('lookup_business_fact', turn.names, call.replies())
            await call.judge(turn, 'Explains how a job goes using the steps the business gave, covering at least two of: the owner '
                             'follows up about the address, timing and pricing; a worker checks the area in person; the work is done; '
                             'photos are sent when it is done. Does not say it is unsure.')

    async def test_an_answer_about_the_process_ends_by_checking_in(self):
        # Tom's 2026-10-02 call: Blake explained the process and then said nothing. He wants it to end with
        # "Let me know if you have any other questions."
        for question in ("Sounds good, um, can you tell me what's like the process look like?",
                         'Okay. So what happens after this, like how does the whole thing work?'):
            with self.subTest(question=question):
                async with Call(self) as call:
                    call.backend.facts.append(PROCESS)
                    await self.save_maria(call)
                    turn = await call.say(question)
                    await call.judge(turn, 'Explains how a job goes, then ends by inviting more questions, such as "Let me '
                                     'know if you have any other questions." Does not end on the explanation alone.')

    async def test_va_t21_a_hedged_goodbye_ends_the_call(self):
        async with Call(self) as call:
            await self.save_maria(call)
            await call.say("Okay, sounds good. I guess like that's all I need.")
            self.assertEqual(call.ended, ['caller_ended'], call.replies())

    async def test_the_second_plaza_call_asks_only_for_the_property_hands_back_the_turn_and_ends_on_goodbye(self):
        """Tom's second 2026-10-01 call: a double question confused him, the line went silent, and Bob never hung up."""
        async with Call(self) as call:
            call.backend.facts.append(PROCESS)
            await self.ask_about_the_plaza(call)
            await call.say('Yeah, I need services that clean the two areas. So yes.')
            turn = await call.say('My name is Tom Lam. My phone number is 408 555 2147.')
            for answer in ('Yes.', 'Yes, that is right.'):
                if 'property' in turn.reply.lower() or 'address' in turn.reply.lower() or 'city' in turn.reply.lower(): break
                turn = await call.say(answer)
            self.assertNotRegex(turn.reply, r'(?i)who (?:exactly )?(?:is this|it is|it\'s) for|name of (?:the person|your friend)', call.replies())
            turn = await call.say("I don't have the exact address, but the city is Irvine. I'll follow up with the address later.")
            self.assertTrue(turn.reply.rstrip().endswith('?'), call.replies())
            turn = await call.say("Okay, sounds good. I guess like what's the process look like?")
            self.assertIn('lookup_business_fact', turn.names, call.replies())
            await call.say('Very cool.')
            await call.say("I guess that's all I need to know.")
            self.assertEqual(call.ended, ['caller_ended'], call.replies())

    async def test_urgency_after_the_save_is_added_to_the_request(self):
        async with Call(self) as call:
            await call.say("Hi, I'm Maria Lopez, I need my driveway pressure washed in Irvine, California.")
            turn = await call.say('Yes, go ahead, my number is 714-555-0182.')
            for answer in ('Yes, that number is right.', 'Yes.'):
                if call.backend.saved(): break
                turn = await call.say(answer)
            self.assertEqual(len(call.backend.saved()), 1)
            turn = await call.say('Do you have an estimate time, because I need to get this done as soon as possible?')
            self.assertIn(WANTS_IT_SOON, call.backend.saved()[0]['fields'].get('notes') or '', call.replies())
            self.assertEqual(len([task for task in call.backend.tasks.values() if task['kind'] == 'service_request']), 1)
            await call.judge(turn, 'Does not promise a specific time, and says it is marked urgent, or that the manager will know they '
                             'want it soon, or that this was noted for the manager. It does not ask for the name, number or city.')



PLUMBING = {'businessName': 'Knockout Plumbing', 'businessType': 'plumbing contractor',
            'profile': {'businessName': 'Knockout Plumbing', 'services': [{'name': 'Leak detection and repair'}, {'name': 'Repiping'},
                                                                         {'name': 'Drain cleaning'}]}}
PLUMBING_SERVICES = [{'serviceId': 'svc-1', 'name': 'Leak detection and repair'}, {'serviceId': 'svc-2', 'name': 'Repiping'},
                     {'serviceId': 'svc-3', 'name': 'Drain cleaning'}]
HVAC = {'businessName': 'Valley Comfort Heating & Air', 'businessType': 'HVAC contractor',
        'profile': {'businessName': 'Valley Comfort Heating & Air', 'services': [{'name': 'AC repair'}, {'name': 'Furnace repair'}]}}
HVAC_SERVICES = [{'serviceId': 'svc-1', 'name': 'AC repair'}, {'serviceId': 'svc-2', 'name': 'Furnace repair'},
                 {'serviceId': 'svc-3', 'name': 'Maintenance plans'}]
SERVING = [{'predicate': 'service_area', 'value': 'Serving the Bay Area and Southern California'},
           {'predicate': 'hours', 'value': 'Monday to Friday, 8am to 5pm'}]


@unittest.skipUnless(ENABLED, 'paid harness: set FRONTLINE_VOICE_HARNESS=on with OPENAI_API_KEY injected')
class TradeSituationCalls(HarnessCase):
    """Tom, 2026-10-03, after his stepdad's call to a plumber: Blake learns the situation before naming services, marks an
    urgent job urgent, can suggest one safe step, and tells the caller when the manager will get back to them."""

    async def finish_request(self, call, details, address):
        turn = await call.say(details)
        for answer in ('Yes, that number is right.', address, 'Yes.', address):
            if call.backend.saved(): break
            turn = await call.say(answer)
        self.assertEqual(len(call.backend.saved()), 1, call.replies())
        return turn

    async def test_an_active_leak_is_understood_marked_urgent_and_given_a_callback_window(self):
        # The callback window depends on the business being open, so the call happens during business hours.
        with patch('conversation.open_for', return_value=True):
            await self.active_leak()

    async def active_leak(self):
        async with Call(self, **PLUMBING) as call:
            call.backend.services, call.backend.facts = PLUMBING_SERVICES, SERVING
            turn = await call.say("Hi, water is coming out from under my bathroom sink and it's all over the floor.")
            await call.judge(turn, 'Asks one short question about the leak, such as whether water is still running or whether they '
                             'turned it off. Does not ask for a name or number and does not mention a price.')
            turn = await call.say("It's still spreading, and I don't know where the shutoff is.")
            await call.judge(turn, 'Says it will mark this urgent or make sure the manager knows it is urgent. Does not promise when '
                             'someone will arrive and does not guess what caused the leak. Naming a leak repair service, or suggesting they turn off a '
                             'water valve if it is safe, is fine.')
            if 'start_service_request' not in turn.names:
                await call.say('Yes please, I need someone out here.')
            turn = await self.finish_request(call, "I'm Priya Shah, my number is 650-555-0199, and I'm home all afternoon.",
                                             '42 Pine Court, Palo Alto, California.')
            parts = note_parts(call.backend.saved()[0]['fields'].get('notes') or '')
            self.assertIn(WANTS_IT_SOON, call.backend.saved()[0]['fields'].get('notes') or '')
            self.assertIn('afternoon', parts.get('available', ''))
            self.assertIn('Pine', parts.get('property', ''))
            # Tom (2026-10-04): "urgent" is said once in the call, and no thanks for patience the caller didn't need.
            await call.judge(turn, 'Says the request is passed along and says the manager will try to get back to them within about '
                             '30 minutes to an hour, softened with "or so" or similar.')

    async def test_a_broken_ac_hears_a_situation_question_and_a_one_business_day_callback(self):
        with patch('conversation.open_for', return_value=True):
            await self.broken_ac()

    async def broken_ac(self):
        async with Call(self, **HVAC) as call:
            call.backend.services, call.backend.facts = HVAC_SERVICES, SERVING
            turn = await call.say('Hi, my AC is running but blowing warm air since yesterday.')
            await call.judge(turn, 'Asks one short question to understand the problem, such as the kind of system or what the '
                             'thermostat shows. Does not ask for a name or number and does not mention a price.')
            started = 'start_service_request' in turn.names
            for answer in ("It's a central system, and the thermostat looks normal.", 'Yes, I need a repair.', 'Yes.'):
                if started: break
                turn = await call.say(answer)
                started = 'start_service_request' in turn.names
            self.assertTrue(started, call.replies())
            # Before the turn that starts the request: at most two situation questions, plus the offer of a service.
            self.assertLessEqual(sum('?' in reply for reply in call.replies()[:-1]), 3, call.replies())
            turn = await self.finish_request(call, "I'm Dana Park, 714-555-0142. Any time tomorrow works.", '88 Birch Lane, Irvine, California.')
            self.assertNotIn(WANTS_IT_SOON, call.backend.saved()[0]['fields'].get('notes') or '')
            await call.judge(turn, 'Says the request is passed along and that the manager will usually get back to them within one '
                             'business day. Does not say it is urgent.')

    async def test_a_misheard_street_is_read_back_as_the_real_street(self):
        # Tom's recordings, 2026-10-05: every transcriber heard Senter Road as "Center Road".
        async with Call(self, **HVAC) as call:
            call.backend.services, call.backend.facts = HVAC_SERVICES, SERVING
            turn = await call.say('Hi, my AC is blowing warm air. Can you pass a repair request to the manager?')
            for answer in ("It's a central system.", 'Yes, please pass it along.', 'Yes.'):
                if 'start_service_request' in turn.names: break
                turn = await call.say(answer)
            turn = await call.say("I'm Dana Park, 408-555-0142. Any time tomorrow works.")
            for answer in ('Yes, that number is right.', "It's twenty-two oh one Center Road in San Jose."):
                if 'Senter' in call.replies()[-1]: break
                turn = await call.say(answer)
            self.assertFalse(call.backend.saved(), call.replies())
            await call.judge(turn, 'Reads the address back as twenty-two oh one Senter Road in San Jose and asks if that is right.')
            await call.say("Yes, that's right.")
            self.assertEqual(len(call.backend.saved()), 1, call.replies())
            self.assertIn('2201 Senter Road', call.backend.saved()[0]['fields'].get('notes') or '')

    async def test_a_request_said_as_a_statement_is_answered_before_the_next_question(self):
        # Tom's 2026-10-06 call: "we're just looking to get an estimate over the phone if we can" got only the address question.
        async with Call(self) as call:
            await call.say('I need my gutters cleaned.')
            turn = await call.say('Yes please, go ahead.')
            if not call.backend.tasks:
                turn = await call.say('Yes, take my info.')
            turn = await call.say('My name is Fred and you can reach me at 323-658-4188.')
            self.assertNotIn('spell', turn.reply.lower())
            turn = await call.say('That is right.')
            self.assertNotIn('spell', turn.reply.lower())
            if AVAILABILITY_QUESTION.search(turn.reply):
                turn = await call.say("Uh, we're just looking to get an estimate over the phone if we can.")
                self.assertIn('lookup_business_fact', turn.names, call.replies())
                await call.judge(turn, 'Responds to the caller wanting an estimate over the phone, for example that the manager '
                                 'will follow up about the estimate or what the business says about pricing, instead of '
                                 'ignoring it. It may then ask for the address.')

    async def test_a_question_with_no_fact_on_file_is_left_to_the_manager(self):
        # Tom's 2026-10-06 call, replayed with no pricing on file: Blake said "We don't handle estimates over the phone".
        async with Call(self) as call:
            call.backend.facts = [fact for fact in call.backend.facts if fact['predicate'] != 'pricing']
            await call.say('Hi, I have a commercial property I would like to get an estimate on. We want the walls and awnings cleaned.')
            turn = await call.say('Yes, please.')
            if not call.backend.tasks:
                turn = await call.say('Yes, take my info.')
            await call.say('My name is Fred and you can reach me at 323-658-4188.')
            await call.say('That is right.')
            turn = await call.say("Uh, we're just looking to get an estimate over the phone if we can.")
            await call.judge(turn, 'Leaves the question about phone estimates to the manager, or says it does not know, without '
                             'stating a policy of its own. Asking for the address next is fine.')
            # Live replay: after answering, Blake asked "When else would be good for someone to come out?".
            self.assertNotRegex(turn.reply.lower(), r'come out|good time|when works|when would')
            if call.backend.saved():
                return
            turn = await call.say("It's 2 Park Plaza in Irvine.")
            self.assertEqual(len(call.backend.saved()), 1, call.replies())
            await call.judge(turn, 'Tells the caller their request is passed along to the manager. Mentioning the address is fine.')
            # Live replay: with the address saved, Blake said "the manager can get the exact address when they follow up".
            self.assertNotRegex(turn.reply.lower(), r'get the (?:exact )?address|address later|need the address')

    async def test_magnus_name_is_kept_as_said_and_a_cut_off_turn_never_ends_the_call(self):
        # Magnus's call, 2026-10-06: Blake asked him to spell a name it had heard right, saved half of it, and "It'll"
        # (the start of the address) ended the call. Blake no longer asks for a spelling.
        async with Call(self) as call:
            await call.say('I am looking to get my property cleaned, the trash areas and sidewalks.')
            turn = await call.say('Yes.')
            if not call.backend.tasks:
                turn = await call.say('Yes, take my info.')
            turn = await call.say('My name is Sarah Blakely.')
            if not READBACK.search(turn.reply):
                turn = await call.say('One five six two, eight six seven, zero nine nine zero.')
            turn = await call.say('Yes.')
            self.assertNotIn('spell', turn.reply.lower(), call.replies())
            turn = await call.answer_availability(turn, 'I think Friday, 2 p.m.')
            turn = await call.say("It'll")
            self.assertEqual(call.ended, [], call.replies())
            # Live call, 2026-10-06: the model saved a city on "It all", which saved the request without the street.
            self.assertEqual(call.backend.saved(), [], call.replies())
            turn = await call.say("It's 2 Park Plaza in Irvine.")
            self.assertEqual(len(call.backend.saved()), 1, call.replies())
            self.assertEqual(call.backend.saved()[0]['fields'].get('callerName'), 'Sarah Blakely', call.replies())

    async def test_a_spelling_split_across_two_turns_is_read_back_whole(self):
        # Magnus's call, 2026-10-06: he paused between "B L A K" and "E L Y", and Blake read back only "E-L-Y".
        async with Call(self) as call:
            await call.say('I am looking to get my property cleaned, the trash areas and sidewalks.')
            turn = await call.say('Yes.')
            if not call.backend.tasks:
                turn = await call.say('Yes, take my info.')
            turn = await call.say('My name is Sarah Blakely, 562-867-0990.')
            if READBACK.search(turn.reply):
                turn = await call.say('Yes.')
            await call.say('Let me spell the last name. B L A K')
            turn = await call.say('E L Y')
            self.assertNotRegex(turn.reply, r'\bE-L-Y\b(?<!K-E-L-Y)', call.replies())
            names = [record['callerName'] for record in call.backend.records() if record.get('callerName')]
            self.assertEqual(names[-1:], ['Sarah Blakely'], call.replies())


    async def test_tom_1924_details_given_before_any_offer_start_the_request(self):
        # Tom's 2026-10-06 call: after a third question instead of an offer, Blake took the name and number itself, read
        # the number back wrong, said the request was passed along, never asked for the address, and asked for the
        # number again once the request finally started.
        async with Call(self) as call:
            await call.say("Hi Blake, I'm looking to get my property cleaned and I want to request an estimate.")
            await call.say("I have a commercial retail property.")
            await call.say("I'm looking to get the trash area and the sidewalks done. We have a lot of heavy grease and stains. "
                           "Depending on the price, maybe the awnings as well.")
            turn = await call.say("Um, I'm not sure yet, but ideally eventually a recurring service.")
            if not call.backend.tasks:
                turn = await call.say("My name is Sarah Blakely.")
            self.assertTrue(call.backend.tasks, call.replies())
            for answer in ("My name is Sarah Blakely.", "It's 562-867-0990.", "Yes, that's right.", "Friday around 2 p.m.",
                           "It's 222 South Long Beach Boulevard in Long Beach."):
                if call.backend.saved(): break
                turn = await call.say(answer)
            self.assertEqual(len(call.backend.saved()), 1, call.replies())
            fields = call.backend.saved()[0]['fields']
            self.assertEqual(fields.get('contactPhone'), '5628670990', call.replies())
            self.assertIn('222 South Long Beach Boulevard', fields.get('notes') or '', call.replies())
            replies = call.replies()
            confirmed = next(index for index, reply in enumerate(replies) if READBACK.search(reply))
            # Once the number is read back and confirmed, it is never asked for again.
            self.assertFalse([reply for reply in replies[confirmed + 1:] if re.search(r'(?i)\bnumber\b[^.?!]*\?', reply)], replies)


    async def test_tom_pch_a_misheard_highway_is_read_back_as_the_real_street(self):
        # Tom's 2026-10-06 call: "E specific coast highway" was recorded as "E Coast Highway", read back as "East
        # California One", and the correction was saved as "East Specific Coast Highway".
        async with Call(self) as call:
            await call.say("Hi, I'd like to get the sidewalks at my store pressure washed. Can I get an estimate?")
            for answer in ("Yes, please.", "Sarah Blakely, 562-867-0990.", "Yes, that's right.", "Friday at 2 p.m."):
                if re.search(r'(?i)address|street|where is', call.replies()[-1] if call.replies() else ''): break
                await call.say(answer)
            await call.say("It is uh Five one five oh")
            await call.say("E specific coast highway Long Beach, California.")
            replies = ' '.join(call.replies())
            self.assertNotRegex(replies, r'(?i)california (?:one|1)\b', call.replies())
            for answer in ("Yes, that's it.", "Yes."):
                if call.backend.saved(): break
                await call.say(answer)
            self.assertEqual(len(call.backend.saved()), 1, call.replies())
            self.assertIn('Pacific Coast Highway', call.backend.saved()[0]['fields'].get('notes') or '', call.replies())

    async def test_a_name_and_number_before_any_offer_start_the_request_at_once(self):
        # Tom's 2026-10-06 call: details the caller gave with no request open were never saved or checked.
        async with Call(self) as call:
            await call.say("Hi, I need the sidewalks and trash area at my store pressure washed.")
            turn = await call.say("My name is Sarah Blakely and my number is 562-867-0990.")
            self.assertTrue(call.backend.tasks, call.replies())
            self.assertRegex(turn.reply, READBACK, call.replies())
            self.assertEqual([fields.get('contactPhone') for fields in call.backend.records() if fields.get('contactPhone')][-1:],
                             ['5628670990'], call.replies())


    async def test_tom_1924_two_questions_at_most_then_the_offer(self):
        # Tom's 2026-10-06 call: Blake asked a third and fourth question (one-time or regular) instead of offering.
        async with Call(self) as call:
            await call.say("Hi Blake, I'm looking to get my property cleaned and I want to request an estimate.")
            await call.say("I have a commercial retail property.")
            turn = await call.say("I'm looking to get the trash area and the sidewalks done. There's heavy grease and stains.")
            self.assertNotRegex(' '.join(call.replies()), r'(?i)one-time|recurring|regular', call.replies())
            if not call.backend.tasks:
                # An offer, such as "Would that work for you?" or "Want me to pass that along?", not another question.
                self.assertRegex(turn.reply, r"(?i)would (?:that|this|those|it)|does (?:that|this)|interested|sound|want me to|"
                                 r"like me to|pass", call.replies())


if __name__ == '__main__':
    unittest.main()
