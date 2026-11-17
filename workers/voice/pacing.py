"""Privacy-safe aggregate timing for synthesized Bob speech.

OpenAI TTS does not expose word alignment through the current LiveKit plugin.
These measurements describe audible silence and overall rate, not exact word gaps.
No audio frames or spoken text are retained after an utterance completes.
"""

from __future__ import annotations

import math
import re


def _percentile(values: list[float], fraction: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, max(0, math.ceil(len(ordered) * fraction) - 1))]


class SpeechPacingMeter:
    """Measures effective rate and interior audible pauses in one TTS stream."""

    def __init__(self) -> None:
        self._text: list[str] = []
        self._levels: list[tuple[float, float]] = []
        self.audio_ms = 0.0

    def add_text(self, text: str) -> None:
        if isinstance(text, str):
            self._text.append(text)

    def add_audio(self, frame) -> None:
        samples = frame.data
        channels = max(1, frame.num_channels)
        block_size = max(channels, frame.sample_rate // 100 * channels)
        for start in range(0, len(samples), block_size):
            block = samples[start:start + block_size:channels]
            if not block:
                continue
            mean_square = sum(int(sample) * int(sample) for sample in block) / len(block)
            duration_ms = len(block) * 1000.0 / frame.sample_rate
            self._levels.append((math.sqrt(mean_square), duration_ms))
            self.audio_ms += duration_ms

    def summary(self) -> dict[str, int | float] | None:
        if not self._levels:
            self._text.clear()
            return None
        words = len(re.findall(r"\b[\w']+\b", "".join(self._text)))
        self._text.clear()
        reference = _percentile([level for level, _ in self._levels], .9)
        threshold = max(250.0, reference * .08)
        voiced = [index for index, (level, _) in enumerate(self._levels) if level >= threshold]
        gaps: list[float] = []
        if voiced:
            silence = 0.0
            for level, duration_ms in self._levels[voiced[0]:voiced[-1] + 1]:
                if level < threshold:
                    silence += duration_ms
                elif silence:
                    if silence >= 120.0:
                        gaps.append(silence)
                    silence = 0.0
        result = {
            "words": words,
            "audio_ms": round(self.audio_ms),
            "effective_wpm": round(words * 60_000 / self.audio_ms, 1) if self.audio_ms else 0.0,
            "audible_gap_count": len(gaps),
            "gap_p50_ms": round(_percentile(gaps, .5)),
            "gap_p90_ms": round(_percentile(gaps, .9)),
            "long_gap_count": sum(gap >= 500 for gap in gaps),
        }
        self._levels.clear()
        return result
