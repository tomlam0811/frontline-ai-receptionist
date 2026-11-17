"""Audio pacing comparison for Bob's voice instructions (paid; dry-run unless --execute).

Synthesizes the same short lines with the baseline instructions (d8a7cf5, which told the voice to slow down for
names and numbers) and the current instructions, then reports effective words per minute and pause
statistics from pacing.SpeechPacingMeter. This measures rate and audible pauses only. It cannot judge
naturalness, so a listening check on the same lines is still needed. Uses only an already injected key.
"""
from __future__ import annotations

import argparse
import json
import os
from array import array
from pathlib import Path
from types import SimpleNamespace
import statistics

from agent import TTS_INSTRUCTIONS, TTS_SPEED, TTS_VOICE
from pacing import SpeechPacingMeter
from speech import readback_chunks

BASELINE = json.loads((Path(__file__).parent / "style_baseline.json").read_text())
FIELDS = {"callerName": "Alex Rivera", "contactPhone": "415-555-0132", "contactEmail": "alex.rivera@example.com",
          "serviceNeed": "storefront cleaning", "propertyCity": "Example City"}
LINES = {
    "chat": ["Sure, we clean storefronts, patios and parking areas.", "Yeah, we're open eight to five, Monday through Friday.",
             "Got it, so a restaurant patio, about two hundred square feet. Mind if I grab a few details?"],
    "readback_baseline": [BASELINE["sample_readback"]],
    "readback_current": readback_chunks(FIELDS),
}


def synthesize(client, text, instructions, speed):
    audio = client.audio.speech.create(model="gpt-4o-mini-tts", voice=TTS_VOICE, input=text, speed=speed,
                                       instructions=instructions, response_format="pcm")
    samples = array("h"); samples.frombytes(audio.content)
    return SimpleNamespace(data=samples, num_channels=1, sample_rate=24000)


def measure(client, lines, instructions, speed):
    rows = []
    for text in lines:
        meter = SpeechPacingMeter(); meter.add_text(text); meter.add_audio(synthesize(client, text, instructions, speed))
        rows.append(meter.summary())
    return rows


def aggregate(rows):
    return {"clips": len(rows), "meanWpm": round(statistics.mean(r["effective_wpm"] for r in rows), 1),
            "wpmSpread": round(max(r["effective_wpm"] for r in rows) - min(r["effective_wpm"] for r in rows), 1),
            "gapsPerClip": round(statistics.mean(r["audible_gap_count"] for r in rows), 1),
            "p90GapMs": max(r["gap_p90_ms"] for r in rows)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args()
    clips = sum(len(v) for v in LINES.values())
    if not args.execute:
        print(json.dumps({"status": "dry_run", "plannedSynthesisRequests": clips + len(LINES["chat"]),
                          "scope": "no paid requests made"}, indent=2)); return
    key = os.environ.get("OPENAI_API_KEY") or os.environ.get("MODEL_API_KEY")
    if not key: raise SystemExit("Injected OPENAI_API_KEY or MODEL_API_KEY is required")
    from openai import OpenAI
    client = OpenAI(api_key=key, max_retries=0, timeout=30)
    old, new = BASELINE["tts_instructions"], TTS_INSTRUCTIONS
    report = {"chat_baseline_instructions": aggregate(measure(client, LINES["chat"], old, BASELINE["tts_speed"])),
              "chat_current_instructions": aggregate(measure(client, LINES["chat"], new, TTS_SPEED)),
              "readback_baseline_wording_and_instructions": aggregate(measure(client, LINES["readback_baseline"], old, BASELINE["tts_speed"])),
              "readback_current_wording_and_instructions": aggregate(measure(client, LINES["readback_current"], new, TTS_SPEED))}
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
