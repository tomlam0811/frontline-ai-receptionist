"""Address check tests: misheard streets from Tom's 2026-10-05 recordings against the bundled Census street index."""
from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))

from unittest.mock import patch

from addresses import check_address, said_street, spoken_address, spoken_house_number, validate_address
from intake import ServiceRequestTask
from test_conversation import Context, FakeFlow, task

READY = {"serviceNeed": "AC blowing warm air", "callerName": "Tom Lam", "contactPhone": "(408) 555-2147", "phoneConfirmed": True}


class CheckAddress(unittest.TestCase):
    def test_misheard_streets_become_the_real_street_with_that_number(self):
        for place, city, real in (("2201 Center Road", "San Jose", "2201 Senter Road"),
                                  ("42150 Blockhouse Road", "Fremont", "42150 Blacow Road"),
                                  ("4100 Stephen Creek Boulevard", "San Jose", "4100 Stevens Creek Boulevard"),
                                  ("39439 Patio Padre Parkway", "Fremont", "39439 Paseo Padre Parkway"),
                                  ("555 Tooley Road", "San Jose", "555 Tully Road")):
            self.assertEqual(check_address(place, city).__dict__, {"verdict": "suggest", "address": real, "source": "census"}, place)

    def test_real_streets_stand_as_heard(self):
        for place, city, real in (("476 west taylor street", "San Jose", "476 West Taylor Street"),
                                  ("1660 Saratoga Avenue Suite 200", "San Jose", "1660 Saratoga Avenue Suite 200"),
                                  # The Census ranges lack 1250 on Mowry Avenue, which still exists as heard.
                                  ("1250 Mowry Avenue", "Fremont", "1250 Mowry Avenue"),
                                  ("34009 Alvarado Niles Road", "Union City", "34009 Alvarado Niles Road")):
            self.assertEqual(check_address(place, city).__dict__, {"verdict": "match", "address": real, "source": "census"}, place)

    def test_nothing_is_offered_without_a_close_street_a_number_or_street_data(self):
        for place, city in (("1250 Marjorie Avenue", "Fremont"), ("Westpark Plaza", "San Jose"), ("12 Main Street", "Reno"),
                            ("2201 Center Road", "")):
            self.assertEqual(check_address(place, city).verdict, "unchecked", place)

    def test_spoken_forms(self):
        self.assertEqual(said_street("W Taylor St"), "West Taylor Street")
        self.assertEqual([spoken_house_number(n) for n in ("555", "2201", "4100", "1250", "41039", "39439", "42150")],
                         ["five fifty-five", "twenty-two oh one", "forty-one hundred", "twelve fifty",
                          "forty-one oh thirty-nine", "thirty-nine four thirty-nine", "forty-two one fifty"])
        self.assertEqual(spoken_address("2201 Senter Road", "San Jose"), "twenty-two oh one Senter Road, San Jose")


def google(route, number='2201', level='CONFIRMED', **flags):
    components = [{'componentName': {'text': number}, 'componentType': 'street_number', 'confirmationLevel': 'CONFIRMED'},
                  {'componentName': {'text': route}, 'componentType': 'route', 'confirmationLevel': level, **flags}]
    return {'result': {'address': {'addressComponents': components}}}


class GoogleFirst(unittest.TestCase):
    def setUp(self):
        patcher = patch.dict('os.environ', {'GOOGLE_MAP_API': 'test-key'})
        patcher.start()
        self.addCleanup(patcher.stop)

    def check(self, response, place='2201 Center Road', city='San Jose'):
        with patch('addresses._validate_with_google', return_value=response) as call:
            result = validate_address(place, city, 'California')
        return result, call

    def test_a_spelling_google_corrects_is_offered(self):
        # Google returned Senter Road for "Center Road" without flagging a correction, so any new name is offered.
        result, call = self.check(google('Senter Road'))
        self.assertEqual((result.verdict, result.address, result.source), ('suggest', '2201 Senter Road', 'google'))
        body = call.call_args.args[0]['address']
        self.assertEqual((body['addressLines'], body['locality'], body['administrativeArea']),
                         (['2201 Center Road'], 'San Jose', 'California'))

    def test_a_street_google_confirms_stands(self):
        result, _ = self.check(google('West Taylor Street', '476'), '476 west taylor street')
        self.assertEqual((result.verdict, result.address, result.source), ('match', '476 West Taylor Street', 'google'))

    def test_a_route_number_is_never_offered_as_the_street(self):
        # Tom's 2026-10-06 call: "5150 E Coast Highway" came back as "East California 1", and Blake read that back.
        result, _ = self.check(google('East California 1', '5150'), '5150 E Coast Highway', 'Long Beach')
        self.assertNotEqual(result.address, '5150 East California 1')
        result, _ = self.check(google('California 1', '5150'), '5150 Highway 1', 'Long Beach')
        self.assertEqual((result.verdict, result.address), ('suggest', '5150 California 1'))

    def test_the_census_ranges_decide_when_google_cannot_vouch_for_the_street(self):
        for response in (google('Center Road', level='UNCONFIRMED_AND_SUSPICIOUS'),
                         google('Center Road', level='UNCONFIRMED_BUT_PLAUSIBLE'), google('Senter Road', number='2200'),
                         google('Senter Road', inferred=True), {}):
            result, _ = self.check(response)
            self.assertEqual((result.verdict, result.address, result.source), ('suggest', '2201 Senter Road', 'census'))

    def test_a_google_failure_falls_back_to_the_census_ranges(self):
        with patch('addresses._validate_with_google', side_effect=TimeoutError()):
            result = validate_address('2201 Center Road', 'San Jose')
        self.assertEqual((result.verdict, result.source), ('suggest', 'census'))


def saved(fields):
    return {"accepted": {"x": 1}, "rejected": {}, "task": task(status="succeeded", fields=fields, receipt={"operationId": "x" * 20})}


class AddressReadback(unittest.IsolatedAsyncioTestCase):
    async def offered(self, *responses):
        held = {**READY, "notes": "Property: 2201 Center Road."}
        flow = FakeFlow({"accepted": {"notes": "x"}, "rejected": {}, "task": task(fields=held)}, *responses, state="California")
        flow.caller_texts = ["It's twenty-two oh one Center Road in San Jose."]
        intake = ServiceRequestTask(flow, task(fields=READY), None)
        intake.told_next_step = True
        line = await intake.record_details(Context(), property_name="2201 Center Road", city="San Jose")
        return flow, intake, line

    async def test_a_misheard_street_is_read_back_as_the_real_one_before_the_request_is_saved(self):
        flow, intake, line = await self.offered(saved({**READY, "propertyCity": "San Jose"}))
        self.assertIn('read the address back as "twenty-two oh one Senter Road, San Jose"', line)
        self.assertNotIn("propertyCity", flow.records[0])
        flow.caller_texts.append("Yes, that's right.")
        await intake.record_details(Context())
        self.assertEqual(flow.records[1]["propertyCity"], "San Jose")
        self.assertEqual(flow.records[1]["propertyState"], "California")
        self.assertEqual(flow.records[1]["notes"], "Property: 2201 Senter Road.")

    async def test_a_corrected_street_is_kept_as_the_caller_says_it(self):
        flow, intake, _ = await self.offered(saved({**READY, "propertyCity": "San Jose"}))
        flow.caller_texts.append("No, it's 2201 Centre Court.")
        await intake.record_details(Context(), property_name="2201 Centre Court")
        self.assertEqual(flow.records[1]["propertyCity"], "San Jose")
        self.assertEqual(flow.records[1]["notes"], "Property: 2201 Centre Court.")

    async def test_a_correction_misheard_the_same_way_is_checked_and_read_back_once_more(self):
        # Tom's 2026-10-06 call: he corrected the street, the correction was misheard too ("Specific Coast Highway"), and it
        # was saved as heard. Google knows it as East Pacific Coast Highway.
        still_open = {"accepted": {"notes": "x"}, "rejected": {}, "task": task(fields=READY)}
        flow, intake, _ = await self.offered(still_open, saved({**READY, "propertyCity": "San Jose"}))
        flow.caller_texts.append("No, it's 2201 E specific coast highway.")
        with patch.dict('os.environ', {'GOOGLE_MAP_API': 'test-key'}), \
                patch('addresses._validate_with_google', return_value=google('East Pacific Coast Highway')):
            line = await intake.record_details(Context(), property_name="2201 E specific coast highway")
        self.assertIn('"twenty-two oh one East Pacific Coast Highway, San Jose"', line)
        self.assertNotIn("propertyCity", flow.records[1])
        flow.caller_texts.append("Yes.")
        await intake.record_details(Context())
        self.assertEqual(flow.records[2]["propertyCity"], "San Jose")
        self.assertEqual(flow.records[2]["notes"], "Property: 2201 East Pacific Coast Highway.")

    async def test_a_house_number_said_before_the_street_is_kept_with_it(self):
        # Tom's 2026-10-06 call: "It is uh Five one five oh", then "E specific coast highway Long Beach, California."
        from intake import only_a_house_number
        self.assertEqual(only_a_house_number("Five one five oh"), "5150")
        self.assertEqual(only_a_house_number("5150"), "5150")
        self.assertEqual(only_a_house_number("Five Points Plaza"), "")
        flow = FakeFlow({"accepted": {}, "rejected": {}, "task": task(fields=READY)}, saved({**READY, "propertyCity": "Long Beach"}),
                        state="California")
        flow.caller_texts = ["It is uh Five one five oh"]
        intake = ServiceRequestTask(flow, task(fields=READY), None)
        intake.told_next_step = True
        await intake.record_details(Context(), property_name="Five one five oh")
        self.assertNotIn("Property:", flow.records[0].get("notes", "") if flow.records else "")
        flow.caller_texts.append("E specific coast highway Long Beach, California.")
        with patch.dict('os.environ', {'GOOGLE_MAP_API': 'test-key'}), \
                patch('addresses._validate_with_google', return_value=google('East Pacific Coast Highway', '5150')) as call:
            line = await intake.record_details(Context(), property_name="E specific coast highway", city="Long Beach")
        self.assertEqual(call.call_args.args[0]['address']['addressLines'], ['5150 E specific coast highway'])
        self.assertIn('"fifty-one fifty East Pacific Coast Highway, Long Beach"', line)

    async def test_a_bare_no_asks_for_the_street_again_and_the_next_answer_saves_it(self):
        flow, intake, _ = await self.offered(saved({**READY, "propertyCity": "San Jose"}))
        flow.caller_texts.append("No.")
        line = await intake.record_details(Context())
        self.assertIn("say the street name once more", line)
        self.assertEqual(len(flow.records), 1)
        flow.caller_texts.append("Senter, S-E-N-T-E-R.")
        await intake.record_details(Context(), property_name="2201 Senter Road")
        self.assertEqual(flow.records[1]["propertyCity"], "San Jose")

    async def test_a_real_street_saves_without_a_question(self):
        flow = FakeFlow(saved({**READY, "propertyCity": "San Jose"}), state="California")
        flow.caller_texts = ["It's 476 west taylor street in San Jose."]
        intake = ServiceRequestTask(flow, task(fields=READY), None)
        intake.told_next_step = True
        await intake.record_details(Context(), property_name="476 west taylor street", city="San Jose")
        self.assertEqual(flow.records[0]["propertyCity"], "San Jose")
        self.assertEqual(flow.records[0]["notes"], "Property: 476 West Taylor Street.")
        self.assertTrue(intake.done())


if __name__ == '__main__':
    unittest.main()
