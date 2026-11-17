"""Spoken wording for Bob: readback chunks, spoken phone and email forms, filler removal.

Everything here is text in, text out, so it can be tested without LiveKit or a model.
Stored request values are never changed. Only the words spoken aloud differ.
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass

REQUEST_KEYS = ("callerName", "contactPhone", "contactEmail", "serviceNeed", "propertyCity", "propertyType",
                "company", "preferredDay", "preferredWindow", "timezone", "recurrence", "notes")

CONFIRM_QUESTION = "Did I get that right?"

_DIGIT_WORDS = {"0": "zero", "1": "1", "2": "2", "3": "3", "4": "4", "5": "5", "6": "6", "7": "7", "8": "8", "9": "9"}
_EMAIL_SYMBOLS = {".": " dot ", "@": " at ", "_": " underscore ", "-": " dash ", "+": " plus "}


def spoken_phone(value: str) -> str:
    """415-555-0132 becomes "4 1 5, 5 5 5, 0 1 3 2". Unrecognized shapes are returned unchanged."""
    digits = re.sub(r"\D", "", value or "")
    if len(digits) == 11 and digits.startswith("1"):
        digits = digits[1:]
    if len(digits) != 10:
        return value
    spaced = [" ".join(_DIGIT_WORDS[d] for d in group) for group in (digits[:3], digits[3:6], digits[6:])]
    return ", ".join(spaced)


def spoken_email(value: str) -> str:
    """alex.rivera@example.com becomes "alex dot rivera at example dot com"."""
    if not value or "@" not in value:
        return value
    spoken = "".join(_EMAIL_SYMBOLS.get(char, char) for char in value)
    return re.sub(r"\s+", " ", spoken).strip()


# One short sentence per field. The stored value sits verbatim inside a fixed frame.
_FRAMES = {
    "callerName": "Your name's {}.",
    "contactPhone": "Your number's {}.",
    "contactEmail": "Your email's {}.",
    "company": "The company's {}.",
    "serviceNeed": "You need {}.",
    "propertyType": "The property's {}.",
    "propertyCity": "The city's {}.",
    "preferredDay": "The day's {}.",
    "preferredWindow": "The time's {}.",
    "timezone": "The time zone's {}.",
    "recurrence": "It repeats {}.",
    "notes": "You also noted {}.",
}
_SPOKEN_FORMS = {"contactPhone": spoken_phone, "contactEmail": spoken_email}
_CONTACT_KEYS = ("callerName", "contactPhone", "contactEmail", "company")
_LEAD = "Let me make sure I've got this right."
_CHANGE_LEAD = "Got it."
_CHANGE_QUESTION = "Is that right?"
_RECHECK_QUESTION = "Should I save it as is?"


@dataclass(frozen=True)
class ReadbackPart:
    """One spoken part and the field keys whose values it reads out."""
    text: str
    keys: tuple[str, ...] = ()


def _sentence(key: str, value: str) -> str:
    return _FRAMES[key].format(_SPOKEN_FORMS.get(key, lambda text: text)(value).rstrip(".!?"))


def _run_on(keys: list[str] | tuple[str, ...], fields: dict[str, str]) -> str:
    """Join the field phrases into one flowing sentence. Every full stop is an audible gap in the voice."""
    phrases = [_sentence(key, fields[key]).rstrip(".") for key in keys]
    phrases = [phrases[0]] + [phrase[0].lower() + phrase[1:] for phrase in phrases[1:]]
    if len(phrases) == 1:
        return phrases[0] + "."
    return ", ".join(phrases[:-1]) + ", and " + phrases[-1] + "."


def plan_readback(fields: dict[str, str], heard: dict[str, str] | None = None) -> list[ReadbackPart]:
    """Plan what to say so the caller confirms once and never hears an unchanged value twice.

    `heard` holds the values already played to the caller without interruption. The first pass reads
    every field in short parts, ending with the question. After that only new or corrected values are read,
    followed by a short question. Once every current value has been heard and the closing question has played
    uninterrupted, the caller's yes covers the whole snapshot.
    """
    if not fields or set(fields) - set(REQUEST_KEYS):
        raise ValueError("Invalid readback fields")
    keys = [key for key in REQUEST_KEYS if key in fields]
    needed = [key for key in keys if not heard or heard.get(key) != fields[key]]
    if heard and needed and len(needed) < len(keys):
        text = _CHANGE_LEAD + " " + _run_on(needed, fields) + " " + _CHANGE_QUESTION
        return [ReadbackPart(text, tuple(needed))]
    if heard and not needed:
        return [ReadbackPart(_RECHECK_QUESTION)]
    first = [key for key in keys if key in _CONTACT_KEYS] or keys
    second = [key for key in keys if key not in first]
    parts = [ReadbackPart(_LEAD + " " + _run_on(first, fields), tuple(first))]
    if second:
        parts.append(ReadbackPart(_run_on(second, fields), tuple(second)))
    parts.append(ReadbackPart(CONFIRM_QUESTION))
    return parts


def closing_question(text: str) -> str:
    """The question a readback part ends with, so the task agent knows what the caller was asked."""
    sentences = re.findall(r"[^.?!]*\?", text)
    return sentences[-1].strip() if sentences else ""


def readback_chunks(fields: dict[str, str], heard: dict[str, str] | None = None) -> list[str]:
    return [part.text for part in plan_readback(fields, heard)]


def readback_text(fields: dict[str, str], heard: dict[str, str] | None = None) -> str:
    return " ".join(readback_chunks(fields, heard))


# Phrases that add nothing on a call. The prompt forbids them; this removes them when the model uses one anyway.
_FILLER_OPENER = re.compile(
    r"^\s*(?:"
    r"(?:that's |that is |what )?an? (?:great|good|excellent|fantastic|wonderful|interesting) (?:question|point)"
    r"|(?:great|good|excellent|fantastic|wonderful) (?:question|point)"
    r"|absolutely|certainly|definitely|of course|no problem at all"
    r"|i(?:'d| would) be (?:happy|glad|delighted) to help(?: you)?(?: with that)?"
    r"|i(?:'m| am) (?:happy|glad|delighted) to help(?: you)?(?: with that)?"
    r"|happy to help|glad to help"
    r")\s*[.!,;:-]*\s*", re.I)

FILLER_PATTERNS = {
    "praise_opener": re.compile(r"\b(?:great|good|excellent|fantastic|wonderful) (?:question|point)\b", re.I),
    "happy_to_help": re.compile(r"\b(?:happy|glad|delighted) to help\b", re.I),
    "absolutely": re.compile(r"\b(?:absolutely|certainly)\b", re.I),
    "of_course": re.compile(r"\bof course\b", re.I),
    "i_understand": re.compile(r"\bi (?:completely |totally )?understand\b", re.I),
    "thank_you_for": re.compile(r"\bthank you for (?:that|sharing|providing|letting me know)\b", re.I),
}


# A thank-you that opens a reply, such as "Thanks, Priya." or "Thanks for that." Tom (2026-10-03): saying thanks on
# every turn sounds odd, so after the first one in a call these openers are dropped. "Thanks for your patience" at the
# end of an urgent request is not an opener and stays.
_THANKS_OPENER = re.compile(
    r"^\s*(?:thanks|thank you)(?: so much| very much)?"
    r"(?: for (?:that|confirming(?: that)?|sharing(?: that| everything| all that)?|the info(?:rmation)?|letting me know|all that))?"
    r"(?:,\s*[A-Z][a-z]+)?(?=\s*(?:[.!,;:-]|$))\s*[.!,;:-]*\s*", re.I)
THANKS = re.compile(r"\b(?:thanks|thank you)\b", re.I)


_THANKS_SENTENCE = re.compile(r"^\s*(?:thanks|thank you)\b[^.!?]*[.!?]*\s*$", re.I)
# "Thanks for calling" closes the call and "Thanks for your patience" goes with an urgent request; both stay.
_KEPT_THANKS = re.compile(r"\bfor (?:calling|your patience|waiting|reaching out)\b", re.I)
_THANKS_FOR_A_DETAIL = re.compile(r"\bfor (?:that|the|your|this|confirming|sharing|explaining|clarifying|letting me know|all)\b", re.I)


def is_spare_thanks(sentence: str, thanked_before: bool) -> bool:
    """True for a short thank-you sentence that adds nothing: any after the first thanks of the call, and one for a detail
    the caller just gave ("Thanks for that address."). Tom (2026-10-03): just move on to the next thing."""
    if not _THANKS_SENTENCE.match(sentence) or _KEPT_THANKS.search(sentence) or len(sentence.split()) > 9:
        return False
    return thanked_before or bool(_THANKS_FOR_A_DETAIL.search(sentence))


def strip_thanks_opener(text: str) -> str:
    """The text without a thank-you opener. Empty when the opener was all of it. A thank-you that goes on to say what
    it is for, such as "Thanks for calling" or "Thanks for your patience", is a sentence of its own and is kept."""
    match = _THANKS_OPENER.match(text)
    if not match or not match.end():
        return text
    rest = text[match.end():].strip()
    return rest[0].upper() + rest[1:] if rest else ''


def is_filler_only(text: str) -> bool:
    """True when the text is nothing but filler openers, such as "Absolutely." or "Great question!"."""
    stripped = text
    while (match := _FILLER_OPENER.match(stripped)) and match.end():
        stripped = stripped[match.end():]
    return stripped != text and not stripped.strip()


def strip_filler_opener(text: str) -> str:
    """Drop stacked filler openers such as "Great question! Absolutely." Returns the input if nothing else would remain."""
    stripped = text
    while True:
        match = _FILLER_OPENER.match(stripped)
        if not match or match.end() == 0:
            break
        stripped = stripped[match.end():]
    stripped = stripped.strip()
    if not stripped:
        return text
    return stripped[0].upper() + stripped[1:] if stripped != text.strip() else text


def style_findings(text: str) -> dict[str, int | bool]:
    """Mechanical style measures for one spoken reply, used by tests and the chat-side evaluation."""
    words = re.findall(r"\b[\w']+\b", text)
    return {
        "words": len(words),
        "filler": sum(bool(pattern.search(text)) for pattern in FILLER_PATTERNS.values()),
        "contraction": any("'" in word or "’" in word for word in words),
        "questions": text.count("?"),
        "sentences": max(1, len(re.findall(r"[.!?]+(?:\s|$)", text))),
    }


# Tom, 2026-10-03: an urgent caller who hears only "I'll pass it along" doesn't know when the problem gets solved and may
# call someone else, so an urgent request gets a short window, softened because nobody can promise an exact time.
URGENT_FOLLOW_UP_WINDOW = "within the next 30 minutes to an hour or so"
FOLLOW_UP_WINDOW = "within one business day"
# Tom, 2026-10-05: outside business hours nobody may be there, so the caller hears the next business day, with room to
# spare, instead of a window the business may not be open for (business_hours.open_for).
CLOSED_FOLLOW_UP_WINDOW = "by the next business day"
URGENT_CLOSED_FOLLOW_UP_WINDOW = "as soon as they can, by the next business day at the latest"


def follow_up_window(urgent: bool, open_now: bool = True, open_an_hour: bool = True) -> str:
    """When the caller can expect to hear back: a short window for an urgent request while the business stays open for
    the next hour, one business day while it is open, and the next business day otherwise."""
    if urgent:
        return URGENT_FOLLOW_UP_WINDOW if open_an_hour else URGENT_CLOSED_FOLLOW_UP_WINDOW
    return FOLLOW_UP_WINDOW if open_now else CLOSED_FOLLOW_UP_WINDOW


def follow_up_line(business: str, fields: dict[str, str], urgent: bool = False, open_now: bool = True,
                   open_an_hour: bool = True) -> str:
    """The demo's follow-up promise. It shows the intended call structure; real delivery is integrated later.

    FRONTLINE_DEMO_FOLLOW_UP=off restores the earlier wording that promises nothing.
    """
    if (os.getenv("FRONTLINE_DEMO_FOLLOW_UP") or "on").strip().lower() == "off":
        return ""
    window = (follow_up_window(urgent, open_now, open_an_hour) if urgent or not open_now
              else (os.getenv("FRONTLINE_DEMO_FOLLOW_UP_WINDOW") or FOLLOW_UP_WINDOW).strip())
    channel = "by phone" if "contactPhone" in fields else "by email" if "contactEmail" in fields else ""
    who = business if business and business != "this business" else "the team"
    return f"Someone from {who} will follow up {channel} {window}.".replace("  ", " ")


# Tom's 2026-10-04 call: Blake said "urgent" in three replies. Once it has been said, later results don't ask for it again.
_SAID_URGENT = re.compile(r"\burgent\b", re.I)


def said_urgent(replies: list[str]) -> bool:
    """True when Blake already told the caller the request is marked urgent."""
    return any(_SAID_URGENT.search(reply) for reply in replies)
