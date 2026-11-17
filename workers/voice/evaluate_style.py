"""Chat-side style comparison of Bob's baseline prompt (d8a7cf5) against the current prompt.

Text only: no tools, TTS, audio or backend writes. Dry-run unless --execute is supplied, and --execute
uses only an already injected OPENAI_API_KEY or MODEL_API_KEY. Only aggregate metrics and scenario IDs
are printed, never raw caller words. Measures wording (filler, length, contractions, questions); it cannot
judge how the voice sounds. Use evaluate_tts_pacing.py for audio pacing.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
from pathlib import Path
import statistics
import time

from prompts import front_desk_instructions
from speech import strip_filler_opener
from speech import style_findings

HERE = Path(__file__).parent
FIXTURES = HERE / "bob_eval_fixtures.json"
BASELINE = HERE / "style_baseline.json"
MODEL = "gpt-4.1-mini"
BUNDLE = {"mode": "business_demo", "businessName": "Example Valley Cleaning", "workflowRevision": 1}
GREETING = {"role": "assistant", "content": "Hi, I'm Blake, an AI customer service rep from Example Valley Cleaning. How can I help you?"}
FACTS = ("Tool results already gathered (sourced business facts): Example Valley Cleaning cleans storefronts, patios and "
         "parking areas. Published hours are 8am to 5pm Monday to Friday. Pricing is quoted by the business.")
EXTRA = [
    {"id": "S01", "input": "Hi, I need my storefront cleaned.", "facts": None},
    {"id": "S02", "input": "What kinds of things do you clean?", "facts": FACTS},
    {"id": "S03", "input": "Are you open on Saturdays?", "facts": FACTS},
    {"id": "S04", "input": "How much does a patio cleaning cost?", "facts": FACTS},
    {"id": "S05", "input": "Thanks, that's helpful.", "facts": None},
    {"id": "S06", "input": "Honestly this is taking a while.", "facts": None},
    {"id": "S07", "input": "It's a restaurant patio, about two hundred square feet.", "facts": None},
    {"id": "S08", "input": "Okay, and what happens after you take my info?", "facts": None},
    {"id": "P01", "input": "I manage a plaza and the walkways are covered in stains.", "facts": FACTS, "proactive": True},
    {"id": "P02", "input": "Our restaurant patio got really grimy this summer.", "facts": FACTS, "proactive": True},
    {"id": "P03", "input": "I need someone to clean the parking lot at my shop.", "facts": FACTS, "proactive": True},
    {"id": "P04", "input": "The front of my storefront looks terrible.", "facts": FACTS, "proactive": True},
]
SERVICE_WORDS = ("storefront", "patio", "parking", "walkway")


def scenarios():
    data = json.loads(FIXTURES.read_text())
    social = [{"id": s["id"], "history": s["history"], "input": s["input"], "facts": None}
              for s in data["scenarios"] if s["lane"] == "bob" and s["expected"]["tools"] == ["none"]]
    return social + [{"proactive": False, **item, "history": [GREETING]} for item in EXTRA]


def prompts():
    baseline = json.loads(BASELINE.read_text())
    return {"baseline": (baseline["conversation_instructions"], baseline["turn_instructions"]),
            # v2 has no per-turn instructions; the front desk prompt is the whole instruction set.
            "current": (front_desk_instructions(BUNDLE), "")}


def request_for(system, turn, case):
    messages = [{"role": "system", "content": system}, *case["history"], *([{"role": "system", "content": turn}] if turn else [])]
    if case["facts"]: messages.append({"role": "system", "content": case["facts"]})
    messages.append({"role": "user", "content": case["input"]})
    return {"model": MODEL, "messages": messages, "temperature": 0.4, "max_completion_tokens": 160}


def summarize(rows):
    """`text` is the model output as the model wrote it; `filtered` is what reaches TTS after the backstop."""
    raw = [style_findings(row["text"]) for row in rows]
    kept = [style_findings(row["filtered"]) for row in rows]
    count = len(rows)
    proactive = [row["filtered"] for row in rows if row.get("proactive")]
    return {"replies": count,
            "proactiveReplies": len(proactive),
            "proactiveEndWithQuestion": sum(text.rstrip().endswith("?") for text in proactive),
            "proactiveNameAService": sum(any(word in text.lower() for word in SERVICE_WORDS) for text in proactive),
            "proactiveOver35Words": sum(style_findings(text)["words"] > 35 for text in proactive),
            "meanWords": round(statistics.mean(item["words"] for item in raw), 1),
            "maxWords": max(item["words"] for item in raw),
            "fillerRepliesFromModel": sum(item["filler"] > 0 for item in raw),
            "fillerRepliesAfterBackstop": sum(item["filler"] > 0 for item in kept),
            "contractionRate": round(sum(item["contraction"] for item in raw) / count, 2),
            "questionRate": round(sum(item["questions"] > 0 for item in raw) / count, 2),
            "over25Words": sum(item["words"] > 25 for item in raw)}


async def evaluate(args, client=None):
    cases, versions = scenarios(), prompts()
    planned = len(cases) * len(versions) * args.repeats
    if planned > 120: raise ValueError("Evaluation exceeds 120 requests")
    if not args.execute:
        return {"status": "dry_run", "model": MODEL, "scenarios": len(cases), "versions": list(versions),
                "plannedCalls": planned, "scope": "prompts loaded; no paid model requests made"}
    if client is None:
        from openai import AsyncOpenAI
        key = os.environ.get("OPENAI_API_KEY") or os.environ.get("MODEL_API_KEY")
        if not key: raise ValueError("Injected OPENAI_API_KEY or MODEL_API_KEY is required")
        client = AsyncOpenAI(api_key=key, max_retries=0, timeout=15)
    rows = {name: [] for name in versions}; started = time.monotonic()
    for repeat in range(args.repeats):
        for case in cases:
            for name, (system, turn) in versions.items():
                completion = await asyncio.wait_for(client.chat.completions.create(**request_for(system, turn, case)), 16)
                text = (completion.choices[0].message.content or "").strip()
                rows[name].append({"caseId": case["id"], "proactive": case.get("proactive", False), "repeat": repeat + 1, "text": text, "filtered": strip_filler_opener(text)})
    result = {"status": "executed", "model": MODEL, "elapsedSeconds": round(time.monotonic() - started, 1),
              "summary": {name: summarize(items) for name, items in rows.items()}}
    if args.show_replies:
        result["replies"] = rows
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true", help="Make paid requests using only already injected credentials")
    parser.add_argument("--repeats", type=int, default=2)
    parser.add_argument("--show-replies", action="store_true", help="Include reply text (synthetic scenarios only)")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    try:
        result = asyncio.run(evaluate(args))
    except ValueError as exc:
        parser.error(str(exc))
    text = json.dumps(result, indent=2) + "\n"
    if args.output: args.output.write_text(text)
    print(text)


if __name__ == "__main__":
    main()
