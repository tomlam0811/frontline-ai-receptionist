import json
import unittest
from pathlib import Path
from frontline_contracts import validate_contract, confirmation_authorizes_write, assert_session_mutable, DEADLINES_SECONDS

FIXTURES = json.loads((Path(__file__).resolve().parents[1] / 'fixtures.json').read_text())

class ContractTests(unittest.TestCase):
    def test_deadlines(self): self.assertEqual(DEADLINES_SECONDS, {'setup':20,'softClose':270,'hardEnd':300})
    def test_shared_schema_fixtures(self):
        for item in FIXTURES['cases']:
            with self.subTest(item['name']):
                if item['valid']: validate_contract(item['reference'],item['value'])
                else:
                    with self.assertRaises(ValueError): validate_contract(item['reference'],item['value'])
    def test_confirmation_semantics(self):
        binding, current = FIXTURES['confirmation']['binding'], FIXTURES['confirmation']['current']
        self.assertTrue(confirmation_authorizes_write(binding,current))
        for key,value in [('latestCallerTurnId',binding['confirmationId']),('latestCallerDialogueAct','negate'),('latestCallerDialogueAct','correct'),('latestCallerClassificationStatus','unavailable'),('readbackAfterCallerTurnSequence',7),('fieldRevision',8)]:
            with self.subTest(key=key,value=value): self.assertFalse(confirmation_authorizes_write(binding,{**current,key:value}))
    def test_guard_fails_closed(self):
        for value in ({'status':'ending'},{'phase':'terminal'},{},{'status':'nonsense','phase':'collecting'}):
            with self.assertRaisesRegex(ValueError,'terminal_session_immutable'): assert_session_mutable(value)
        self.assertEqual(assert_session_mutable({'status':'active','phase':'collecting'})['status'],'active')

if __name__ == '__main__': unittest.main()
