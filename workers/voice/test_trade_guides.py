from __future__ import annotations

import unittest

from trade_guides import GENERAL_GUIDE, situation_block, trade_guide


class TradeGuides(unittest.TestCase):
    def test_the_business_type_or_services_pick_the_trade(self):
        self.assertEqual(trade_guide({"businessType": "plumbing contractor"})["trade"], "plumbing")
        services = {"profile": {"services": [{"name": "Furnace repair"}]}}
        self.assertEqual(trade_guide(services)["trade"], "heating and air conditioning")
        self.assertIs(trade_guide({"businessType": "hair salon"}), GENERAL_GUIDE)

    def test_an_urgent_problem_gets_one_safe_step_and_no_other_advice(self):
        block = situation_block({"businessType": "plumbing"})
        self.assertIn("Urgent signs: water spreading", block)
        self.assertIn("turning off the small valve under the sink", block)
        self.assertIn("Suggest nothing else to fix or check", block)
        self.assertNotIn("While they wait", situation_block({"businessType": "hair salon"}))


if __name__ == "__main__":
    unittest.main()
