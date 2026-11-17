"""Request intake as LiveKit tasks (docs/voice-agent-v2-spec.md, VA-D1, VA-D7).

The model records what it hears through one record_details tool per task. The backend validates and stores each value
(VA-D8) and code turns the stored request into one status line naming the next action, so the model never has to work
out from the transcript what it already has. A status line names actions in words, never field keys, because the
model reads field names aloud.
"""
from __future__ import annotations

import asyncio
import difflib
import logging
import re
import time
from typing import TYPE_CHECKING, Annotated, Literal

from livekit.agents import AgentTask, ModelSettings, RunContext, function_tool
from livekit.agents.utils import is_given
from pydantic import Field

from addresses import spoken_address, validate_address
from prompts import task_instructions
from speech import said_urgent
from trade_guides import tip_given, trade_guide

if TYPE_CHECKING:
    from conversation import CallFlow

logger = logging.getLogger('frontline.voice')

SPOKEN = {'callerName': 'name', 'contactPhone': 'phone number', 'contactEmail': 'email', 'serviceNeed': 'what they need',
          'propertyCity': 'city', 'propertyState': 'state', 'summary': 'complaint', 'appointmentAction': 'what to change',
          'notes': 'who it is for and the property'}

# A caller asking on someone else's behalf: "for a friend", "my boss who runs the plaza".
_OTHERS = (r"(?:friend|boss|tenant|client|landlord|neighbou?r|mom|dad|mother|father|parents?|brother|sister|son|daughter|wife|"
           r"husband|partner|manager|employer|customer|relative|cousin|aunt|uncle|grandma|grandmother|grandpa|grandfather|"
           r"co-?worker|colleague)s?")
_FOR_SOMEONE = re.compile(rf"\b(?:for|on behalf of)\s+(?:a|my|our|the)\s+(?:\w+\s+)?{_OTHERS}\b"
                          rf"|\b(?:a|my|our)\s+{_OTHERS}\s+(?:who|that|needs|wants|runs|owns|manages|has)\b", re.I)
_NOTE_PARTS = {'person': 'Calling for', 'property': 'Property:', 'available': 'Available:'}


def calling_for_someone(caller_texts: list[str]) -> bool:
    """True when the caller said they are calling for someone else, such as a friend, a boss or a tenant."""
    return any(_FOR_SOMEONE.search(text) for text in caller_texts)


# Written into the notes when the caller asks to talk to the owner, or says they need the work soon. The backend's next
# step for the owner reads both.
ASKED_FOR_OWNER = 'Asked to talk to the owner.'
WANTS_IT_SOON = 'Wants it done as soon as possible.'
# Tom (2026-10-03): a number the caller repeats is kept even when it fails the US pattern check, so the request is not
# lost, and the manager is told to check it.
PHONE_AS_GIVEN = "Phone number taken as the caller gave it; it doesn't look like a standard US number, so check it."
_NOTES = re.compile(r'^(?:Calling for (?P<person>.+?)\.(?: |$))?(?:Property: (?P<property>.+?)\.)?(?: ?Available: (?P<available>.+?)\.)?(?: ?(?P<soon>'
                    + re.escape(WANTS_IT_SOON) + r'))?(?: ?(?P<owner>' + re.escape(ASKED_FOR_OWNER) + r'))?(?: ?(?P<phone_as_given>'
                    + re.escape(PHONE_AS_GIVEN) + r'))?$')
_SOON = re.compile(r"\b(?:as soon as (?:possible|you can)|asap|a\.s\.a\.p|(?<!not )(?<!n't )urgent(?:ly)?|right away|"
                   r"need (?:it|this|that|them|someone|you)(?: done| out| here)? (?:today|tonight|tomorrow|this week)|"
                   # Tom (2026-10-03): "can you get someone here right now" means the earliest time anyone can come.
                   r"(?:get|send|have|need) (?:someone|somebody|anyone|a (?:plumber|tech|technician|person|guy))(?: out| over)?"
                   r"(?: here| there)?(?: like)? (?:right now|now|today|immediately)|"
                   r"come (?:out |over )?(?:right now|immediately|today))\b", re.I)
# What Bob says when a request becomes urgent, above all to "can you get someone here right now?".
URGENT_REPLY = ("Marked urgent. If they asked for someone to come soon, say it's marked urgent so the manager can get back to "
                "them as soon as possible; never say whether or when anyone can come. ")
URGENT_ALREADY_SAID = ("Marked urgent; you already told them, so don't say urgent again. If they asked for someone to come "
                       "soon, never say whether or when anyone can come. ")
# What "as soon as possible" means for when they're free, so Bob doesn't then ask when works best.
EARLIEST = 'the earliest time someone can come'



_KIND_OF_PLACE = re.compile(r"(?:(?:my|our|the|a|an|his|her|their|this|that|[a-z]+'s)\s+)?"
                            r"(?:(?:commercial|rental|small|main|new|old|family|friend's|mom's|dad's|parents')\s+)*"
                            r"(?:office|house|home|rental|property|apartment|condo|place|shop|store|business|building|work|unit|"
                            r"restaurant|warehouse|garage|plaza|complex|site|location|storefront)s?", re.I)


def is_a_kind_of_place(text: str) -> bool:
    """True when what was taken as the property's name only says what kind of place it is, such as "my office" or "the
    rental", so the street address is still needed."""
    return bool(_KIND_OF_PLACE.fullmatch((text or '').strip(' .,!')))


# Live call, 2026-10-06: a cut-off "It'll" was taken as the property, and Blake asked "What city is It'll in?".
_ONLY_SMALL_WORDS = re.compile(r"(?:(?:it|it's|its|it'll|that|that's|this|the|a|an|uh|um|so|well|i|i'm|we|we're|our|my|is|at|"
                               r"in|on)[\s.,!?-]*)+", re.I)


def is_a_cut_off(text: str) -> bool:
    """True when what was taken as the property's name is only small words such as "It'll", the start of a cut-off turn."""
    return bool(_ONLY_SMALL_WORDS.fullmatch((text or '').replace('’', "'").strip()))


def wants_it_soon(caller_texts: list[str]) -> bool:
    """True when the caller said they need the work soon, such as "as soon as possible" or "I need it done today"."""
    return any(_SOON.search(text) for text in caller_texts)


def note_parts(notes: str) -> dict:
    """The person, property, timing and owner request kept in a request's notes, which read "Calling for Mike. Property:
    Westpark Plaza. Wants it done as soon as possible. Asked to talk to the owner.". A property such as "12 St. Mark
    Plaza" keeps its own full stops."""
    match = _NOTES.match(notes or '')
    return {key: value for key, value in (match.groupdict() if match else {}).items() if value}


def notes_text(parts: dict) -> str:
    """Notes for the person and property, each cut short enough to fit the contract's 500 characters together, then
    the timing and the owner request."""
    text = [f'{label} {parts[key].strip().rstrip(".")[:200]}.' for key, label in _NOTE_PARTS.items() if parts.get(key)]
    return ' '.join(text + ([WANTS_IT_SOON] if parts.get('soon') else []) + ([ASKED_FOR_OWNER] if parts.get('owner') else [])
                    + ([PHONE_AS_GIVEN] if parts.get('phone_as_given') else []))


def someone_step(parts: dict) -> str:
    # Only the property: asking for the other person's name in the same breath confused a caller, and the owner reaches
    # the caller anyway. A name the caller offers is still recorded.
    return '' if parts.get('property') else "ask once for the property's name or street address, in plain words, without suggesting one"


def _join(words: list[str]) -> str:
    return words[0] if len(words) == 1 else ', '.join(words[:-1]) + ' and ' + words[-1]


US_STATES = {'AL': 'Alabama', 'AK': 'Alaska', 'AZ': 'Arizona', 'AR': 'Arkansas', 'CA': 'California', 'CO': 'Colorado',
             'CT': 'Connecticut', 'DE': 'Delaware', 'FL': 'Florida', 'GA': 'Georgia', 'HI': 'Hawaii', 'ID': 'Idaho',
             'IL': 'Illinois', 'IN': 'Indiana', 'IA': 'Iowa', 'KS': 'Kansas', 'KY': 'Kentucky', 'LA': 'Louisiana',
             'ME': 'Maine', 'MD': 'Maryland', 'MA': 'Massachusetts', 'MI': 'Michigan', 'MN': 'Minnesota',
             'MS': 'Mississippi', 'MO': 'Missouri', 'MT': 'Montana', 'NE': 'Nebraska', 'NV': 'Nevada',
             'NH': 'New Hampshire', 'NJ': 'New Jersey', 'NM': 'New Mexico', 'NY': 'New York', 'NC': 'North Carolina',
             'ND': 'North Dakota', 'OH': 'Ohio', 'OK': 'Oklahoma', 'OR': 'Oregon', 'PA': 'Pennsylvania',
             'RI': 'Rhode Island', 'SC': 'South Carolina', 'SD': 'South Dakota', 'TN': 'Tennessee', 'TX': 'Texas',
             'UT': 'Utah', 'VT': 'Vermont', 'VA': 'Virginia', 'WA': 'Washington', 'WV': 'West Virginia',
             'WI': 'Wisconsin', 'WY': 'Wyoming', 'DC': 'District of Columbia'}


def state_was_said(state: str, caller_texts: list[str]) -> bool:
    """True when the caller said this state (full name or abbreviation) somewhere on the call. The model otherwise fills
    in a likely state itself, which would skip the city check."""
    name = US_STATES.get(state.strip().upper().replace('.', ''), state.strip())
    abbreviation = next((code for code, full in US_STATES.items() if full.lower() == name.lower()), '')
    patterns = [re.escape(name)] + ([rf'\b{abbreviation[0]}\.?\s?{abbreviation[1]}\.?(?=\W|$)'] if abbreviation else [])
    return any(re.search(rf'\b(?:{"|".join(patterns)})', text, re.I) for text in caller_texts)


# A run of spelled letters, such as "D-A V I E N": lone letters, or letters joined by hyphens or dots.
_LETTER = r"[A-Za-z](?:[-.][A-Za-z])*\.?"
_SPELLED_RUN = re.compile(rf"(?<![\w'’-]){_LETTER}(?:[\s,]+{_LETTER})*(?![\w'’-])")


def spelled_words(text: str) -> list[str]:
    """The words a caller spelled out letter by letter: "D-A V I E N" gives ["DA", "VIEN"]. Letters joined by hyphens or
    dots are one word, and so is a run of lone letters up to a full stop. Runs of fewer than three letters, such as "I"
    or "a", are ordinary words."""
    words = []
    for run in _SPELLED_RUN.finditer(text or ''):
        tokens = re.split(r'[\s,]+', run.group().strip())
        joined = [token for token in tokens if re.search(r'\w[-.]\w', token)]
        if sum(len(re.sub(r'\W', '', token)) for token in tokens) < 3 or (len(tokens) < 3 and not joined):
            continue
        group = []
        for token in tokens:
            if token in joined:
                words += [''.join(group)] if group else []
                words.append(re.sub(r'\W', '', token).upper())
                group = []
                continue
            group.append(token.rstrip('.').upper())
            if token.endswith('.'):
                words.append(''.join(group))
                group = []
        words += [''.join(group)] if group else []
    return [word for word in words if word]


def spelled_name(words: list[str]) -> str:
    return ' '.join(word.capitalize() for word in words)


_FILLERS = {'uh', 'um', 'so', 'like', 'its', "it's", 'is', 'called', 'the'}


def misheard_before(text: str, count: int) -> set[str]:
    """The words just before a spelled run, which are what the caller's spelled word sounded like: "Dog bin, uh, D-A V I E N"
    gives {"dog", "bin"}. Fillers are skipped."""
    run = _SPELLED_RUN.search(text or '')
    before = [word for word in re.findall(r"[^\W\d_]+(?:'[a-z]+)?", (text or '')[:run.start()].lower()) if word not in _FILLERS] if run else []
    return set(before[-count:]) if count else set()


def with_spelled_parts(name: str, spelled: list[str]) -> str:
    """The caller's name with each part they spelled put in place of the part that sounded like it: "Tom Lamb" with L-A-M
    is "Tom Lam". A part is replaced only when it sounds close, so a spelled first name never replaces the last name."""
    parts = name.split()
    for word in spelled:
        close = [(difflib.SequenceMatcher(None, part.casefold(), word.casefold()).ratio(), index)
                 for index, part in enumerate(parts) if part[:1].casefold() == word[:1].casefold()]
        if close and (best := max(close))[0] >= 0.6:
            parts[best[1]] = word.capitalize()
    return ' '.join(parts)


# A name written as spelled letters: "T R A N", "T-R-A-N." or "T. R. A. N."
_LETTERS = re.compile(r"(?:[A-Za-z][\s.,-]+){2,}[A-Za-z]\.?")


def only_letters(text: str) -> list[str]:
    """The letters, when a turn is nothing but spelled letters such as "E L Y" or "uh, E-L-Y.", else []."""
    letters = re.findall(r"[A-Za-z]+", re.sub(r"\b(?:uh|um|and)\b", ' ', text or '', flags=re.I))
    return [letter.upper() for letter in letters] if letters and all(len(letter) == 1 for letter in letters) else []


def trailing_letters(text: str) -> list[str]:
    """The spelled letters a turn ends with, two or more: "Let me spell it. B L A K" gives B, L, A, K."""
    words = re.findall(r"[A-Za-z]+", re.sub(r"\b(?:uh|um)\b", ' ', text or '', flags=re.I))
    letters = []
    for word in reversed(words):
        if len(word) != 1:
            break
        letters.insert(0, word.upper())
    return letters if len(letters) >= 2 else []


def spelled_turn(caller_texts: list[str]) -> str:
    """The caller's last turn, joined with the letters the turn before ended with when this one is only letters. Magnus's
    call, 2026-10-06: he paused between "B L A K" and "E L Y", and Blake read back only "E-L-Y"."""
    last = caller_texts[-1] if caller_texts else ''
    if len(caller_texts) > 1 and (more := only_letters(last)) and (before := trailing_letters(caller_texts[-2])):
        return ' '.join(before + more)
    return last


def with_spelling(fields: dict, text: str) -> dict:
    """Puts what the caller spelled in this turn into the name, property or person it belongs to, when the model wrote it
    as it sounded: "Dog bin, D-A V I E N" is recorded as "Da Vien", and "Tom Lamb ... L-A-M" as "Tom Lam". With more than
    one name in the turn, nothing is changed."""
    spelled = spelled_words(text)
    notes = fields.get('notes') or {}
    names = [(key, value) for key, value in [('callerName', fields.get('callerName')), *notes.items()] if value]
    if not spelled or len(names) != 1:
        return fields
    if names[0][0] == 'callerName':
        # The caller's own name may be spelled one part at a time, so only the parts they spelled change.
        return {**fields, 'callerName': with_spelled_parts(fields['callerName'], spelled)}
    key, value = names[0]
    words = {word.casefold() for word in re.findall(r'[^\W\d_]+', value)}
    misheard = misheard_before(text, len(spelled)) - {word.casefold() for word in spelled}
    if {word.casefold() for word in spelled} <= words and not words & misheard:
        return fields
    return {**fields, 'notes': {**notes, key: spelled_name(spelled)}}


def spelling_line(text: str) -> str:
    """An instruction to read back what the caller just spelled, or '' when they spelled nothing."""
    words = spelled_words(text)
    if not words:
        return ''
    letters = ', '.join('-'.join(word) for word in words)
    name = spelled_name(words)
    return (f'They spelled "{name}" letter by letter as {letters}. Use that spelling. Before anything else, '
            f'read back only those letters and ask if that is right, for example: "Just to make sure, is that {letters}?" '
            'Don\'t mention any other spelling or how it sounded.')


def was_said(value: str, caller_texts: list[str]) -> bool:
    """True when every word of a name or place (three letters or more) is something the caller said on this call, or
    spelled out letter by letter. Digits are skipped, since a caller says "one two three Main Street" for "123 Main
    Street"."""
    heard = {word.casefold() for text in caller_texts for word in re.findall(r"[^\W\d_]{3,}", text)}
    for text in caller_texts:
        spelled = spelled_words(text)
        heard |= {word.casefold() for word in spelled} | {''.join(spelled).casefold()}
    return all(word.casefold() in heard for word in re.findall(r"[^\W\d_]{3,}", value or ''))


# An answer such as "Yes, that's right." is never a city, even when it comes right after the city question.
# Availability names a day or a time. "Yes, that's right" said to another question is not availability.
_WHEN = re.compile(r"\b(?:today|tonight|tomorrow|morning|afternoon|evening|night|noon|weekdays?|weekends?|week|day|days|monday|tuesday|"
                   r"wednesday|thursday|friday|saturday|sunday|any ?time|anytime|whenever|asap|soon|now|later|month|"
                   r"am|pm|a\.m\.|p\.m\.|\d)\b|\d", re.I)
_NOT_A_CITY = re.compile(r"^\W*(?:yes|yeah|yep|yup|no|nope|correct|right|sure|okay|ok|that's right|that is right)\b", re.I)


def city_needs_state(fields: dict) -> bool:
    return bool(fields.get('propertyCity')) and not fields.get('propertyState') and not fields.get('cityConfirmed')


_STATE_NAME = re.compile(r'\b(' + '|'.join(sorted(map(re.escape, US_STATES.values()), key=len, reverse=True)) + r')\b')
# An abbreviation counts only in an address position, such as "Irvine, CA 92618", since "OR" and "IN" are also words.
_STATE_CODE = re.compile(r',\s*([A-Z]{2})\b(?=\s*(?:\d{5}|$|[,.;)"\]]))')


def service_area_state(text: str) -> str | None:
    """The one US state a business's address and service area name, or None when they name none or several."""
    names = {name for name in _STATE_NAME.findall(text or '')}
    names |= {US_STATES[code] for code in _STATE_CODE.findall(text or '') if code in US_STATES}
    return names.pop() if len(names) == 1 else None


_DIGIT_WORDS = ('oh', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine')


def phone_digits(phone: str) -> str:
    digits = re.sub(r'\D', '', phone or '')
    return digits[1:] if len(digits) == 11 and digits.startswith('1') else digits


def spoken_phone(phone: str) -> str:
    """A stored number in three, three and four digit groups with every digit as a word, so the voice reads it back the
    way a person would instead of as one large number."""
    digits = phone_digits(phone)
    groups = [digits[:3], digits[3:6], digits[6:]] if len(digits) == 10 else [digits]
    return ', '.join(' '.join(_DIGIT_WORDS[int(d)] for d in group) for group in groups if group)


_YES = re.compile(r"\b(?:yes|yeah|yep|yup|correct|right|exactly|uh-huh|mm-hmm|sure|that's it|that is it|perfect)\b", re.I)
_NO = re.compile(r"\b(?:no|nope|not|wrong|isn't|wasn't)\b", re.I)
_DIGIT_VALUES = {word: str(i) for i, word in enumerate(_DIGIT_WORDS)} | {'zero': '0', 'o': '0'}
_TEENS = {word: str(10 + i) for i, word in enumerate(('ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
                                                       'seventeen', 'eighteen', 'nineteen'))}
_TENS = {word: str(i + 2) for i, word in enumerate(('twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'))}
_REPEATS = {'double': 2, 'triple': 3}


def said_digits(text: str) -> str:
    """Every digit in the text in order, whether written as numerals or said the ways people say phone numbers:
    "four oh eight", "five fifty-five", "twenty-one forty-seven", "double five", "eight hundred"."""
    tokens = re.findall(r"[a-z]+|\d", text.lower())
    digits, repeat = [], 1
    for index, token in enumerate(tokens):
        following = tokens[index + 1] if index + 1 < len(tokens) else ''
        if token in _REPEATS:
            repeat = _REPEATS[token]
            continue
        if token.isdigit() or token in _DIGIT_VALUES:
            digits.append(_DIGIT_VALUES.get(token, token) * repeat)
        elif token in _TEENS:
            digits.append(_TEENS[token])
        elif token in _TENS:
            # "seventy-five" is 75, and "seventy" on its own is 70.
            digits.append(_TENS[token] + ('' if following in _DIGIT_VALUES and following not in ('zero', 'o', 'oh') else '0'))
        elif token == 'hundred':
            digits.append('00')
        repeat = 1
    return ''.join(digits)


def with_country_code(line: str, caller_texts: list[str], phone: str) -> str:
    """The number read back with its leading "one" when the caller said it. Tom's 2026-10-06 call: he said "one five six
    two...", heard it back without the one, and said "No... first digit is one"."""
    digits = phone_digits(phone)
    readback = f'"{spoken_phone(phone)}"' if len(digits) == 10 else ''
    if not readback or readback not in line or f'1{digits}' not in said_digits(' '.join(caller_texts[-3:])):
        return line
    return line.replace(readback, f'"one, {readback[1:]}')


_GIVES_NUMBER = re.compile(r"\b(?:phone|number|cell|reach (?:me|him|her|them))\b", re.I)


def phone_in_words(caller_texts: list[str]) -> str:
    """A full US phone number in the caller's latest words, when they say it is their number, or ''."""
    text = caller_texts[-1] if caller_texts else ''
    digits = said_digits(text)
    if not _GIVES_NUMBER.search(text) or not (len(digits) == 10 or (len(digits) == 11 and digits.startswith('1'))):
        return ''
    return digits


def spoken_digits(digits: str) -> str:
    """Digits as words in the groups a person would say: three, three and four for a full number, three and four for a
    local one, threes otherwise."""
    if len(digits) == 10:
        return spoken_phone(digits)
    sizes = [3, 4] if len(digits) == 7 else [3] * (len(digits) // 3 + 1)
    groups, start = [], 0
    for size in sizes:
        if digits[start:start + size]:
            groups.append(digits[start:start + size])
        start += size
    return ', '.join(' '.join(_DIGIT_WORDS[int(d)] for d in group) for group in groups)


def joined_phone(phone: str, caller_texts: list[str]) -> str:
    """One number said across two turns, such as "my number is four oh eight" and then "five five five oh one five three",
    as all ten digits. Anything else comes back unchanged."""
    digits = phone_digits(phone)
    if not digits or len(digits) >= 10 or len(caller_texts) < 2:
        return phone
    last, before = said_digits(caller_texts[-1]), said_digits(caller_texts[-2])
    lead = 10 - len(last)
    # The earlier turn must end on those digits, so a house number said earlier is never taken for an area code.
    ends_on_digits = re.search(rf"(?:\d|\b(?:{'|'.join(_DIGIT_VALUES)}))\W*$", caller_texts[-2], re.I)
    if digits == last and lead in (3, 6) and len(before) >= lead and ends_on_digits:
        return before[-lead:] + last
    return phone


def without_segment_repeat(phone: str, caller_texts: list[str]) -> str:
    """Eleven digits where the transcript repeats one digit word across a break, such as "one two three four Four five
    six seven", as the ten the caller said. The transcriber starts each piece with a capital and sometimes hears the
    word at the break twice. The number can come from an earlier turn, as when the caller answers the read-back with
    "No, that is correct" and the model sends the eleven digits again. Anything else comes back unchanged."""
    digits = phone_digits(phone)
    text = next((text for text in reversed(caller_texts[-3:]) if said_digits(text) == digits), '')
    if len(digits) != 11 or not text:
        return phone
    repeats = [match for match in re.finditer(r"\b([a-z]+)\W+([A-Z][a-z]*)\b", text)
               if match.group(1) == match.group(2).lower() and match.group(1) in _DIGIT_VALUES]
    if len(repeats) != 1:
        return phone
    at = len(said_digits(text[:repeats[0].start(2)]))
    return digits[:at] + digits[at + 1:]


def _one_run_of_digits(text: str, digits: str) -> bool:
    """True when the digits are said as one unbroken run, not scattered through a sentence, so a house number and a ZIP
    code in one turn are never taken for a phone attempt."""
    digit = rf"(?:\b(?:{'|'.join(_DIGIT_VALUES)})\b|\d)"
    runs = re.findall(rf"{digit}(?:[\W_]*{digit})*", text, re.I)
    return len(runs) == 1 and said_digits(runs[0]) == digits


def combined_attempts(phone: str, caller_texts: list[str]) -> str:
    """The ten digits two nine-digit attempts make together, when the transcriber dropped a different digit each time.
    Tom's 2026-10-04 call gave 485552147 and then 085552147 for 4085552147. Every ten-digit number holding both attempts
    in order is tried, and only a valid US number counts. With exactly one left it comes back, and the caller still
    hears it read back. Identical attempts, two candidates or none leave the phone unchanged."""
    digits = phone_digits(phone)
    if len(digits) != 9:
        return phone
    for text in reversed(caller_texts[-4:]):
        other = said_digits(text)
        if len(other) != 9 or other == digits or not _one_run_of_digits(text, other):
            continue
        found = set()
        for at in range(10):
            for new in '0123456789':
                candidate = digits[:at] + new + digits[at:]
                rest = iter(candidate)
                if all(char in rest for char in other) and candidate[0] in '23456789' and candidate[3] in '23456789':
                    found.add(candidate)
        return found.pop() if len(found) == 1 else phone
    return phone


_STREET_TYPE = re.compile(r"\b(?:street|st|road|rd|avenue|ave|boulevard|blvd|drive|dr|lane|ln|way|court|ct|place|pl|"
                          r"parkway|pkwy|circle|cir|terrace|ter|highway|hwy|expressway|expy|trail|loop|square|plaza)\b", re.I)
_NUMBER_WORD = rf"(?:\d|\b(?:{'|'.join([*_DIGIT_VALUES, *_TEENS, *_TENS, 'hundred', 'thousand', 'double', 'triple'])})\b)"
_HOUSE_NUMBER = re.compile(rf"^\s*({_NUMBER_WORD}(?:[\s,-]+{_NUMBER_WORD})*)\s+(?=[^\W\d_])", re.I)


def house_number_as_digits(place: str) -> str:
    """A street address whose house number came through as words, such as "one two three Buckingham Drive", with the
    number as digits, "123 Buckingham Drive", the way the manager will look it up. Tom's 2026-10-05 test call saved the
    words. A place without a street type, or a number with "thousand" in it, is left as it was."""
    match = _HOUSE_NUMBER.match(place or '')
    if not match or not _STREET_TYPE.search(place[match.end():]) or re.fullmatch(r'[\d\s,-]+', match.group(1)):
        return place
    if re.search(r'\bthousand\b', match.group(1), re.I) or not (digits := said_digits(match.group(1))):
        return place
    return digits + ' ' + place[match.end():]


_NUMBER_WORDS = set(_DIGIT_WORDS) | {'zero', 'o', 'hundred', 'double', 'triple'}


def only_a_house_number(place: str) -> str:
    """The digits when the place is only a house number, such as "Five one five oh" with the street still to come."""
    tokens = re.findall(r"[a-z]+|\d+", (place or '').lower())
    if not tokens or not all(token.isdigit() or token in _NUMBER_WORDS or token in _TEENS or token in _TENS
                             for token in tokens):
        return ''
    digits = said_digits(place)
    return digits if 1 <= len(digits) <= 6 else ''


def phone_start(phone: str, caller_texts: list[str]) -> bool:
    """True when the number is only an area code (or area code and exchange) the caller ended their turn on, so the rest
    is coming in the next turn."""
    digits = phone_digits(phone)
    return len(digits) in (3, 6) and bool(caller_texts) and said_digits(caller_texts[-1]).endswith(digits)


def number_was_said(phone: str, caller_texts: list[str], stored: str = '') -> bool:
    """True when the caller's last few turns contain these digits, or the caller just corrected the last four digits of
    the stored number. A forced tool call can otherwise invent a number."""
    digits, stored = phone_digits(phone), phone_digits(stored)
    said = said_digits(' '.join(caller_texts[-3:]))
    if not digits or not caller_texts:
        return False
    if digits[-7:] in said:
        return True
    return (len(digits) == 10 and digits[-4:] in said_digits(caller_texts[-1])
            and (digits[:6] == stored[:6] or digits[:6] in said))


def confirms_number(text: str, phone: str) -> bool:
    """True when the caller's answer to the readback is a yes, or repeats the number, and has no "no" in it."""
    if _NO.search(text):
        return False
    return bool(_YES.search(text)) or (len(phone_digits(phone)) == 10 and phone_digits(phone)[-7:] in said_digits(text))


# "No, that is correct." and "I just told you the number." both stand by a number that was read back.
_STANDS_BY = re.compile(r"\b(?:correct|(?:that|it)(?:'s| is) (?:right|it)|i (?:just |already )?(?:told|gave) you)\b", re.I)
_WRONG = re.compile(r"\b(?:not|wrong|isn't|wasn't|incorrect)\b", re.I)


def stands_by_number(text: str) -> bool:
    """True when the caller says the number read back to them is right, even with a leading "no"."""
    return confirms_number(text, '') or bool(_STANDS_BY.search(text) and not _WRONG.search(text))


# Words a caller uses to drop a request or switch to something else. Without one, a stop is a misreading.
_STOP = re.compile(r"\b(?:no|nope|not|don't|do not|never ?mind|cancel|stop|forget|actually|instead|rather|wait|complain|"
                   r"complaint|appointment|person|human|later)\b", re.I)


def _unchanged(key: str, value, stored) -> bool:
    """True when a value sent for a saved request is what it already holds."""
    if stored in (None, ''):
        return False
    if key == 'contactPhone':
        return phone_digits(str(value)) == phone_digits(str(stored))
    if isinstance(value, str) and isinstance(stored, str):
        return value.strip().casefold() == stored.strip().casefold()
    return value == stored


def phone_needs_readback(fields: dict) -> bool:
    return bool(fields.get('contactPhone')) and not fields.get('phoneConfirmed')


def readback_step(fields: dict) -> str:
    return f'read the number back as "{spoken_phone(fields["contactPhone"])}" and ask if that\'s right, with no other question'


# The contact question when the caller is calling for someone else. Tom (2026-10-01): ask for one contact name and number
# and let the caller decide whether it is their own or the other person's, instead of asking which one or assuming.
CONTACT_FOR_SOMEONE = ('ask for a contact name and phone number for the manager to follow up with, for example "Can I get a '
                       'contact name and number for the manager to follow up?". Don\'t say or ask whose it should be, theirs '
                       'or the person they are calling for; they choose, and whoever they give is the contact')


# Tom, 2026-10-03: a caller who wants to schedule should be asked when works for them, and an in-person job needs its
# address, not only the city. Asked once each; the manager still confirms the time.
AVAILABILITY_STEP = 'ask when works best for them to have someone come out, without suggesting a day or time'
ADDRESS_STEP = 'ask for the address of the job, the street and the city'
# When the street or the property's name is already known, only the city is missing.
CITY_STEP = 'ask what city the job is in, calling the place by the word the caller used for it, if they used one, and without the word "located"'


def address_readback_step(address: str) -> str:
    return f'read the address back as "{address}" and ask if that\'s right, with no other question'


ADDRESS_AGAIN_STEP = 'ask them to say the street name once more, and to spell it if it is an unusual name'


def next_step(kind: str, fields: dict, someone: str = '', for_someone: bool = False, asked_available: bool = False,
              address_step: str = '') -> str:
    """The next action for an open request, from what the backend has stored. A new phone number is read back first,
    while the caller still has it in mind. `someone` is the one-time question about the property of a caller who is
    calling for someone else, and `for_someone` says they are. `address_step` checks a street that may be misheard."""
    has_contact = bool(fields.get('contactPhone') or fields.get('contactEmail'))
    if kind in ('service_request', 'complaint') and phone_needs_readback(fields):
        return readback_step(fields)
    if address_step:
        return address_step
    if kind == 'service_request':
        if not fields.get('serviceNeed'):
            return 'ask what they need done'
        if not fields.get('callerName') and not has_contact:
            return CONTACT_FOR_SOMEONE if for_someone else 'ask for their name and phone number together'
        if not has_contact:
            return 'ask for the best number to reach them'
        if not fields.get('callerName'):
            return 'ask for their name'
        # Asked after the caller's own name and number, so their answer to one is never taken for the other.
        if someone:
            return someone
        # The address completes the request, so availability comes before it.
        if not fields.get('propertyCity') and not asked_available and not note_parts(fields.get('notes') or '').get('available'):
            return AVAILABILITY_STEP
        if not fields.get('propertyCity'):
            return CITY_STEP if note_parts(fields.get('notes') or '').get('property') else ADDRESS_STEP
        if city_needs_state(fields):
            return f'ask which state {fields["propertyCity"]} is in'
        return 'wait, the request is complete'
    if kind == 'complaint':
        if not fields.get('summary'):
            return 'ask what happened'
        return 'ask once for their name and a way to reach them, and record no_contact if they would rather not say'
    if not fields.get('callerName'):
        return 'ask for the name the appointment is under'
    return 'ask whether they want to cancel it or change it'


# Transcripts often drop the question mark, and a request can be a statement. Tom's 2026-10-06 call: "we're just looking
# to get an estimate over the phone if we can" got the address question with no answer.
_ASKS = re.compile(r"^\W*(?:what|how|why|where|which|can|could|does|is|are|would)\b|"
                   r"\b(?:if (?:we|i|you) (?:can|could)|is (?:it|that|there) (?:possible|a way|okay|ok)|possible to|"
                   r"wondering|can (?:you|we|i)|could (?:you|we|i)|do you|would you|is there)\b", re.I)


def asks_something(text: str) -> bool:
    return '?' in (text or '') or bool(_ASKS.search(text or ''))


# Tom's 2026-10-06 replay call: asked for a phone estimate, Blake said "We don't provide estimates over the phone" without
# looking anything up. What the business does or doesn't do comes only from its facts.
ANSWER_FIRST = ('They also asked something. Before the next step, if it is about the business (prices, estimates, policies, '
                'what it offers), call lookup_business_fact about it and answer briefly from what it returns. If it returns '
                'nothing on it, say the manager can go over that when they follow up. Never say what the business does or '
                "doesn't do without looking it up.")
# A process question that came with the yes: the request step has not seen the business's answer yet.
ANSWER_HOW = ('They also asked how the work goes: call lookup_business_fact about the process first, then give the steps it '
              'returns in a few short sentences before the next step.')
# The opening of a new service request, after any answer and before the first question.
# Tom's wording (2026-10-01): the next step comes first, so the caller knows why they are asked for a name and number.
# Tom (2026-10-03): price comes up only when the business publishes one, so the next step no longer promises a quote.
NEXT_STEPS = ("Start with the next step, in your own words, then ask for what is missing. For example: \"In terms of next "
              "steps, I'll pass your request along to the manager, and they'll follow up about the details. In "
              "the meantime, can I get a contact name and number?\"")

NEXT_STEP_FIRST = ("first tell them the next step in your own words, for example \"In terms of next steps, I'll pass your "
                   "request along to the manager, and they'll follow up about the details\"")


def phone_start_line(digits: str) -> str:
    return f'Heard the start of the phone number, {spoken_digits(digits)}. Next: ask for the rest of the number, in a few words.'


def status_line(kind: str, response: dict, asked_question: bool | str = False, someone: str = '', heard_phone: str = '',
                held_phone: str = '', for_someone: bool = False, spelled: str = '', asked_available: bool = False,
                asked_again: bool = False, address_step: str = '') -> str:
    """Tool result for record_details: what was stored, what was rejected, and the next action. `heard_phone` is the
    number that was sent, and `held_phone` the start of a number kept back until the caller says the rest. `asked_again` is
    true when the caller was already asked on this call to say a short or long number again."""
    task = response.get('task') or {}
    fields = task.get('fields') or {}
    accepted = [SPOKEN.get(key, key) for key in (response.get('accepted') or {}) if key in SPOKEN]
    parts = [f'Recorded {_join(accepted)}.'] if accepted else []
    for key, reason in (response.get('rejected') or {}).items():
        reason = str(reason).rstrip('.') + '.'
        if key == 'contactPhone':
            digits = phone_digits(heard_phone)
            heard = f' as "{spoken_digits(digits)}"' if digits else ', in small groups,'
            # Tom (2026-10-03): the caller hears that it doesn't look right, never the rules behind the check. Only a full
            # ten-digit number can be kept as they gave it; a short or long one is asked for again.
            if len(digits) == 10:
                # The server's reason names area codes, which Bob turned into "doesn't look right for this area".
                parts.append(f'The phone number was not recorded. Next: say back the digits you heard{heard}, say '
                             "only that it doesn't look quite right, with no reason such as phone number rules or the area, "
                             "and ask them to check it. "
                             "If they say the same number again or say it's right, record it again; it is then kept as they "
                             'gave it.')
            else:
                why = (f'say you only caught {len(digits)} digits' if 0 < len(digits) < 10
                       else f'say you caught {len(digits)} digits, more than a phone number has' if digits
                       else "say you didn't catch all of it")
                if asked_again:
                    # Tom's call, 2026-10-04: "that's again nine digits" sounded like blame. The second miss is ours.
                    parts.append(f'The phone number was not recorded: {reason} Next: ask them to say the number once more, '
                                 'slowly. Do not say "again", do not count tries or digits, and do not suggest they said it wrong.')
                else:
                    parts.append(f'The phone number was not recorded: {reason} Next: say back the digits you heard{heard}, '
                                 f'{why}, and ask them to say the whole number again.')
            return ' '.join(parts)
        parts.append(f'The {SPOKEN.get(key, key)} was not recorded: {reason}')
    if held_phone:
        return ' '.join(parts + [phone_start_line(held_phone)])
    if spelled:
        if kind in ('service_request', 'complaint') and phone_needs_readback(fields):
            # One question checks both, so the caller's yes confirms a number that was actually read back.
            return ' '.join(parts + [spelled, f'In that same question, also read the number back as "{spoken_phone(fields["contactPhone"])}".'])
        return ' '.join(parts + [spelled])
    if asked_question:
        parts.append(asked_question if isinstance(asked_question, str) else ANSWER_FIRST)
    parts.append(f'Next: {next_step(kind, fields, someone, for_someone, asked_available, address_step)}.')
    return ' '.join(parts)


class IntakeTask(AgentTask[dict]):
    """One open request. Completes with the backend's final task, or with {'status': 'stopped'}."""

    def __init__(self, flow: 'CallFlow', kind: str, task: dict, chat_ctx, editing: bool = False):
        super().__init__(instructions=task_instructions(flow.bundle, 'request_change' if editing else kind), chat_ctx=chat_ctx)
        self.flow, self.kind = flow, kind
        # Changing a request that is already saved: it completes once the change is stored and any new number confirmed.
        self.editing = editing
        self.fields = dict(task.get('fields') or {})
        # Code, not the model, decides when the number was read back, so a "yes" to anything else confirms nothing.
        self.readback_asked = False
        # True once a short or long number has been refused and the caller asked to say it again.
        self.phone_reasked = False
        # A full number the pattern check refused. If the caller repeats or confirms it, it is kept as they gave it.
        self.refused_phone = ''
        # The front desk already answered whatever the caller asked before this request started, unless the question came
        # with the yes that started it and nothing was said yet this turn: "Yes. What does the process look like?"
        texts = flow.caller_texts
        unanswered = bool(texts) and '?' in texts[-1] and not getattr(flow, 'spoken_this_turn', '').strip()
        self.turns_before = len(texts) - unanswered
        # Who the caller is calling for and the property, kept in notes. Asked for once, only when they call for someone.
        self.someone = note_parts(self.fields.get('notes', ''))
        self.someone_asked = False
        self.available_asked = False
        # A new request says the next step once, in the first result that asks the caller for something.
        self.told_next_step = editing or kind != 'service_request'
        # A street that may be misheard is read back once, as the real street it most likely is. Until the caller
        # answers, the city is held back, because the city completes and saves the request.
        self.address_checked = False
        self.address_suggested = ''
        self.address_offer = ''
        self.address_corrected = False
        self.address_rechecked = False
        self.house_number = ''
        self.address_again = False
        self.held_city: dict = {}

    async def on_user_turn_completed(self, turn_ctx, new_message):
        await self.flow.record_caller_turn(new_message)

    async def llm_node(self, chat_ctx, tools, model_settings):
        # The first model call after a caller turn must call a tool, so a detail is recorded in the turn it is given
        # (VA-D8) instead of whenever the model decides to. A turn with nothing to record calls record_details empty.
        last = chat_ctx.items[-1] if chat_ctx.items else None
        if getattr(last, 'type', None) == 'message' and last.role == 'user' and not is_given(model_settings.tool_choice):
            model_settings = ModelSettings(tool_choice='required')
        async for chunk in self.flow.guarded_llm_node(self, chat_ctx, tools, model_settings):
            yield chunk

    async def tts_node(self, text, model_settings):
        async for frame in self.flow.paced_tts_node(self, text, model_settings):
            yield frame

    async def on_enter(self):
        # The first reply records what the caller already said before it asks anything, so the next step it follows
        # comes from code instead of the model's guess at what is missing.
        said = ('the change the caller just asked for' if self.editing
                else 'anything the caller already said that belongs in this request')
        # A new service request opens with what happens next, so a caller who just said yes knows why they are asked
        # for details. These instructions also hold for the reply after any lookup this turn makes.
        told = '' if self.editing or self.kind != 'service_request' else f' {NEXT_STEPS}'
        self.session.generate_reply(tool_choice='required', instructions=(
            f'Call record_details with {said}, then follow the next step its result gives you.{told} Do not greet them or '
            'introduce yourself again.'))

    async def _record(self, context: RunContext, fields: dict) -> str | None:
        line = await self._record_fields(context, fields)
        return with_country_code(line, self.flow.caller_texts, self.fields.get('contactPhone', '')) if line else line

    async def _record_fields(self, context: RunContext, fields: dict) -> str | None:
        started = time.monotonic()
        urgent = bool(fields.pop('urgent', False))
        fields = {key: value for key, value in fields.items() if value not in (None, '', False)}
        if (self.kind in ('service_request', 'complaint') and not fields.get('contactPhone')
                and not self.fields.get('contactPhone') and (heard := phone_in_words(self.flow.caller_texts[-1:]))):
            # "My phone number is four oh eight..." with only the name recorded: the number the caller gave is not lost.
            logger.warning('phone_recovered kind=%s', self.kind)
            fields['contactPhone'] = heard
        if fields.get('contactPhone') and not phone_digits(fields['contactPhone']) and said_digits(fields['contactPhone']):
            # Harness, 2026-10-04: the model sent "four oh eight five five five..." as the phone, which was then dropped.
            fields['contactPhone'] = said_digits(fields['contactPhone'])
        held_phone = ''
        if fields.get('contactPhone'):
            # A number split across two turns is joined before it is checked, and a bare area code waits for the rest.
            fields['contactPhone'] = joined_phone(fields['contactPhone'], self.flow.caller_texts)
            if (whole := without_segment_repeat(fields['contactPhone'], self.flow.caller_texts)) != fields['contactPhone']:
                # Live call, 2026-10-03: "four zero eight One two three four Four five six seven" came out as 11 digits.
                logger.info('phone_segment_repeat_removed kind=%s', self.kind)
                fields['contactPhone'] = whole
            if (combined := combined_attempts(fields['contactPhone'], self.flow.caller_texts)) != fields['contactPhone']:
                # Tom's call, 2026-10-04: two nine-digit attempts that each lost a different digit.
                logger.info('phone_attempts_combined kind=%s', self.kind)
                fields['contactPhone'] = combined
            if phone_start(fields['contactPhone'], self.flow.caller_texts):
                held_phone = phone_digits(fields.pop('contactPhone'))
                logger.info('phone_start_held kind=%s digits=%d', self.kind, len(held_phone))
        if fields.get('contactPhone') and not number_was_said(fields['contactPhone'], self.flow.caller_texts,
                                                              self.fields.get('contactPhone', '')):
            logger.warning('phone_not_said kind=%s', self.kind)
            fields.pop('contactPhone')
        new_phone = fields.get('contactPhone')
        stored_phone = self.fields.get('contactPhone', '')
        last_words = self.flow.caller_texts[-1] if self.flow.caller_texts else ''
        stored_name = self.fields.get('callerName') or ''
        if fields.get('callerName') and _LETTERS.fullmatch(fields['callerName'].strip()):
            # Harness, 2026-10-06: the model sent the spelled letters "T R A N" as the caller's whole name.
            fields['callerName'] = re.sub(r'[^A-Za-z]', '', fields['callerName']).capitalize()
        if (fields.get('callerName') and stored_name and len(stored_name.split()) > len(fields['callerName'].split())
                and {part.casefold() for part in fields['callerName'].split()} <= {part.casefold() for part in stored_name.split()}):
            # Harness, 2026-10-05: after "T-R-A-N" the model sent the name as just "Tran", which dropped "Bao".
            fields.pop('callerName')
        fields = with_spelling(fields, spelled_turn(self.flow.caller_texts))
        if fields.get('phoneConfirmed') and (not self.readback_asked or not confirms_number(last_words, stored_phone) or (
                new_phone and phone_digits(new_phone) != phone_digits(stored_phone))):
            fields.pop('phoneConfirmed')
        if self.refused_phone and not stored_phone:
            # The caller repeats or confirms a number the pattern check refused: keep it as they gave it. Bob read it back
            # when it was refused, so the repeat or the yes also confirms it.
            if new_phone and phone_digits(new_phone) == self.refused_phone:
                fields |= {'phoneAsGiven': True, 'phoneConfirmed': True}
            elif not new_phone and stands_by_number(last_words):
                fields |= {'contactPhone': self.refused_phone, 'phoneAsGiven': True, 'phoneConfirmed': True}
            if fields.get('phoneAsGiven'):
                logger.info('phone_as_given kind=%s', self.kind)
                self.someone['phone_as_given'] = 'yes'
        if fields.get('callerName') and _NOT_A_CITY.fullmatch(fields['callerName'].strip(' .,!')):
            # "Yeah" said to the name question is an answer, not a name.
            fields.pop('callerName')
        if fields.get('propertyCity') and (_NOT_A_CITY.match(fields['propertyCity']) or is_a_cut_off(fields['propertyCity'])
                                           or not was_said(fields['propertyCity'], self.flow.caller_texts)):
            # Live call, 2026-10-06: on a cut-off "It'll" the model saved a city the caller never said, which saved the
            # request without the street, and Blake told them the manager would get the address later.
            logger.warning('city_not_said kind=%s', self.kind)
            fields.pop('propertyCity')
            fields.pop('propertyState', None)
        if fields.get('propertyState') and not state_was_said(fields['propertyState'], self.flow.caller_texts):
            fields.pop('propertyState')
        if fields.get('propertyCity') and not fields.get('propertyState'):
            # The state comes from the business's service area. Without one, the city is taken as given.
            if state := await self.flow.service_area_state():
                fields['propertyState'] = state
            else:
                fields['cityConfirmed'] = True
        own_names = {name.casefold() for name in (fields.get('callerName'), self.fields.get('callerName')) if name}
        if fields.get('notes') and (fields['notes'].get('person') or '').casefold() in own_names:
            # The caller's own name is not the person they are calling for.
            fields['notes']['person'] = ''
        if (fields.get('notes') or {}).get('property') and is_a_cut_off(fields['notes']['property']):
            logger.info('property_cut_off kind=%s', self.kind)
            fields['notes']['property'] = ''
        if (fields.get('notes') or {}).get('property') and is_a_kind_of_place(fields['notes']['property']):
            # Tom's 2026-10-04 call: "this is at my office" was kept as the property, so Bob asked only for the city and
            # the request reached the manager without a street address.
            logger.info('property_not_a_name kind=%s', self.kind)
            fields['notes']['property'] = ''
        if (fields.get('notes') or {}).get('available') and not _WHEN.search(fields['notes']['available']):
            logger.warning('available_not_a_time kind=%s', self.kind)
            fields['notes']['available'] = ''
        for key, value in (fields.get('notes') or {}).items():
            if value and not was_said(value, self.flow.caller_texts):
                # A name or place the caller never said is a guess, like a phone number they never said.
                logger.warning('note_not_said key=%s kind=%s', key, self.kind)
                fields['notes'][key] = ''
        if (place := (fields.get('notes') or {}).get('property')) and (written := house_number_as_digits(place)) != place:
            logger.info('house_number_as_digits kind=%s', self.kind)
            fields['notes']['property'] = written
        if place := (fields.get('notes') or {}).get('property'):
            if number := only_a_house_number(place):
                # Tom's 2026-10-06 call: "It is uh Five one five oh", then the street in the next turn. The number alone
                # was kept as the property, Blake asked what city "Five one five oh" is in, and the street replaced it.
                logger.info('house_number_only kind=%s', self.kind)
                self.house_number = number
                fields['notes']['property'] = ''
            elif self.house_number and not re.match(r'\s*\d', place):
                fields['notes']['property'] = house_number_as_digits(f'{self.house_number} {place}')
                self.house_number = ''
        if (self.kind == 'service_request' and fields.get('contactPhone') and not fields.get('callerName')
                and not self.fields.get('callerName') and (person := (fields.get('notes') or {}).get('person'))):
            # "Can you contact my friend? His name is Magnus, and his number is..." makes Magnus the contact, so Bob does
            # not go on to ask the caller for their own name.
            fields['callerName'] = person
        heard_place = self.someone.get('property', '')
        said_place = (fields.get('notes') or {}).get('property', '')
        if fields.get('notes'):
            # The person and the property arrive in separate turns, so notes always carry both.
            self.someone |= {key: value for key, value in fields.pop('notes').items() if value}
            if (notes := notes_text(self.someone)) and notes != self.fields.get('notes'):
                fields['notes'] = notes
        if self.held_city:
            fields = self._answer_address(fields, last_words, said_place, heard_place)
            if self.address_corrected and not self.address_rechecked and fields.get('propertyCity'):
                # Tom's 2026-10-06 call: the caller's correction was misheard the same way ("Specific Coast Highway") and
                # saved as heard. The corrected street is checked once more, and read back only if the check finds a
                # different street than the one already offered.
                self.address_rechecked = True
                fields = await self._check_address(fields, again=True)
        elif (self.kind == 'service_request' and not self.editing and not self.address_checked and fields.get('propertyCity')
              and not self.fields.get('propertyCity') and not phone_needs_readback({**self.fields, **fields})):
            fields = await self._check_address(fields)
        if self.kind == 'service_request' and not self.someone.get('soon') and (urgent or wants_it_soon(self.flow.caller_texts)):
            # "I need it as soon as possible" goes on the request, so Bob's "I'll make sure the owner knows" is true. It is checked
            # before an empty write returns, so an urgent flag with no other new detail is not lost.
            self.someone['soon'] = 'yes'
            fields['notes'] = notes_text(self.someone)
            newly_urgent = True
        else:
            newly_urgent = False
        if (self.kind == 'service_request' and not self.someone.get('available') and not self.editing
                and wants_it_soon(self.flow.caller_texts)):
            self.someone['available'] = EARLIEST
            fields['notes'] = notes_text(self.someone)
        if self.someone.get('phone_as_given') and PHONE_AS_GIVEN not in (self.fields.get('notes') or ''):
            fields['notes'] = notes_text(self.someone)
        if self.editing:
            # A change sends only what differs from the saved request, never the whole request again.
            changed = {key: value for key, value in fields.items() if not _unchanged(key, value, self.fields.get(key))}
            if 'propertyCity' in changed:
                # A new city clears the stored state, so the state goes with it even when it is the same.
                changed |= {key: fields[key] for key in ('propertyState', 'cityConfirmed') if key in fields}
            fields = changed
        if not fields:
            if held_phone:
                return phone_start_line(held_phone)
            hint = f' {self._answer_hint()}' if self._asked_question() else ''
            if self.editing and not phone_needs_readback(self.fields):
                return f'Nothing new to record.{hint} Next: ask what they would like to change.'
            if (spelled := self.flow.take_spelling()):
                return f'Nothing new to record. {spelled}'
            return self._asked_once(f'Nothing new to record.{hint} Next: {self._next_step()}.')
        if self.done():
            return 'record_details did not run because this request is already finished.'
        if self.flow.asked_for_owner and self.kind == 'service_request' and not self.someone.get('owner'):
            # The caller asked for the owner before this request held any details, so the request carries it.
            self.someone['owner'] = 'yes'
            fields['notes'] = notes_text(self.someone)
        # The write may complete and save the request, so a barge-in must not cancel it halfway (VA-D7). Once it is
        # stored the caller may cut in again, and their words are heard instead of dropped.
        context.disallow_interruptions()
        asked_again = self.phone_reasked
        try:
            response = await self.flow.record(fields)
            if 'contactPhone' in (response.get('rejected') or {}) and len(sent := phone_digits(fields.get('contactPhone', ''))) == 10:
                self.refused_phone = sent
            task = response['task']
            self.fields = dict(task.get('fields') or {})
            if 'contactPhone' in (response.get('rejected') or {}):
                # Only a short or long number counts as asked once more, and a number that is recorded starts over.
                self.phone_reasked = self.phone_reasked or len(phone_digits(fields.get('contactPhone', ''))) not in (0, 10)
            elif 'contactPhone' in (response.get('accepted') or {}):
                self.phone_reasked = False
            if self.kind != 'service_request' and self._ready_to_finish():
                try:
                    response = await self.flow.finish()
                    task = response['task']
                except Exception:
                    logger.warning('finish_failed kind=%s', self.kind, exc_info=True)
                    return 'That did not go through, so nothing was saved. Next: tell the caller you could not finish it right now.'
        except Exception:
            logger.warning('record_failed kind=%s', self.kind, exc_info=True)
            return f'That did not go through, so nothing new was recorded. Next: {next_step(self.kind, self.fields, for_someone=self._for_someone())}.'
        finally:
            context.speech_handle.allow_interruptions = True
        self._log_record(response, started, newly_urgent)
        # A saved request that a change left without a confirmed number stays open here until the number is read back.
        if task.get('status') == 'succeeded' and not (self.editing and task.get('missingFields')):
            if not self.done():
                self.complete(task)
            return None
        self.readback_asked = phone_needs_readback(self.fields)
        # Tom (2026-10-03): the safe step while they wait is welcome but was hit or miss, so the result that marks the
        # request urgent reminds Bob of it, right before the reply. A tip Bob already gave is not given again.
        guide = trade_guide(self.flow.bundle)
        step = guide.get('while_waiting') if newly_urgent and not tip_given(guide, self.flow.replies) else None
        # Live call, 2026-10-04: asked to send someone ASAP, Bob said "We don't send someone immediately". Tom's call the
        # same day: Bob then said "urgent" in three replies, so once it was said the result only keeps him from promising.
        urgent = ('' if not newly_urgent else URGENT_ALREADY_SAID if said_urgent(self.flow.replies) else URGENT_REPLY)
        tip = f"If it fits what they described, they haven't already and it's safe, suggest once, briefly: {step}. " if step else ''
        return urgent + tip + self._asked_once(status_line(self.kind, response, self._answer_hint(), self._someone_step(),
                                            fields.get('contactPhone', ''), held_phone, self._for_someone(),
                                            self.flow.take_spelling(), self.available_asked, asked_again,
                                            self._address_step()))

    async def _check_address(self, fields: dict, again: bool = False) -> dict:
        """Checks the street against the real streets in the city before the city saves the request. A street that
        does not exist there as heard is read back as the one that most likely does, and the city waits for the answer."""
        place, city = self.someone.get('property', ''), fields['propertyCity']
        if not place:
            return fields
        self.address_checked = True
        try:
            check = await asyncio.to_thread(validate_address, place, city, fields.get('propertyState', ''))
        except Exception:
            logger.warning('address_check_failed kind=%s', self.kind, exc_info=True)
            return fields
        logger.info('address_check kind=%s verdict=%s source=%s', self.kind, check.verdict, check.source)
        if check.verdict == 'match' and check.address != place:
            # The street's own spelling, such as "Senter Road" for "senter rd".
            self.someone['property'] = check.address
            fields['notes'] = notes_text(self.someone)
        elif check.verdict == 'suggest' and not (again and check.address.casefold() == self.address_suggested.casefold()):
            self.address_suggested = check.address
            self.address_offer = spoken_address(check.address, city)
            self.held_city = {key: fields.pop(key) for key in ('propertyCity', 'propertyState', 'cityConfirmed') if key in fields}
        return fields

    def _answer_address(self, fields: dict, last_words: str, said_place: str, heard_place: str) -> dict:
        """The caller's answer to the address read back: a yes keeps the real street, a new street is kept as they said
        it, and a bare no asks once more for the street. The held city is sent with the answer, which saves the request."""
        new_place = bool(said_place) and said_place.casefold() not in (heard_place.casefold(), self.address_suggested.casefold())
        offered, self.address_offer = bool(self.address_offer), ''
        if not new_place and offered and _NO.search(last_words) and not _YES.search(last_words):
            # "No." on its own: the street is asked for again, and the city still waits for it.
            self.address_again = True
            logger.info('address_rejected kind=%s', self.kind)
            return fields
        if not new_place and offered and confirms_number(last_words, ''):
            logger.info('address_confirmed kind=%s', self.kind)
            self.someone['property'] = self.address_suggested
            fields['notes'] = notes_text(self.someone)
        elif new_place:
            logger.info('address_corrected kind=%s', self.kind)
            self.address_corrected = True
        self.address_again = False
        held, self.held_city = self.held_city, {}
        return {**fields, **held}

    def _address_step(self) -> str:
        if self.address_offer:
            return address_readback_step(self.address_offer)
        return ADDRESS_AGAIN_STEP if self.address_again else ''

    def _for_someone(self) -> bool:
        return self.kind == 'service_request' and calling_for_someone(self.flow.caller_texts)

    def _next_step(self) -> str:
        return next_step(self.kind, self.fields, self._someone_step(), self._for_someone(), self.available_asked,
                         self._address_step())

    def _someone_step(self) -> str:
        """The question about the person the caller is calling for, until it has been handed out once."""
        if self.kind != 'service_request' or self.someone_asked or not calling_for_someone(self.flow.caller_texts):
            return ''
        return someone_step(self.someone)

    def _asked_once(self, line: str) -> str:
        """Marks the question about the person the caller is calling for as asked, once a result has handed it out."""
        if (step := self._someone_step()) and f'Next: {step}.' in line:
            self.someone_asked = True
        if f'Next: {AVAILABILITY_STEP}.' in line:
            self.available_asked = True
        if not self.told_next_step:
            # Only the first result of a new request, when it asks for something. Said in the result, right before the
            # reply, the model says it reliably; the opening instruction alone was skipped.
            self.told_next_step = True
            if 'Next: ask' in line and 'start of the phone number' not in line:
                line = line.replace('Next: ', f'Next: {NEXT_STEP_FIRST}, then ', 1)
        return line

    def _log_record(self, response: dict, started: float, newly_urgent: bool = False) -> None:
        """One line per write: which keys were stored or refused and what comes next. Values are never logged, and the
        phone number only by its last four digits."""
        task = response.get('task') or {}
        phone = phone_digits(self.fields.get('contactPhone', ''))
        logger.info('tool_call tool=record_details task_id=%s kind=%s accepted=%s rejected=%s phone=%s urgent=%s status=%s receipt=%s duration_ms=%d',
                    task.get('taskId', ''), self.kind, ','.join(response.get('accepted') or {}) or '-',
                    ','.join(response.get('rejected') or {}) or '-', f'***{phone[-4:]}' if phone else '-',
                    'new' if newly_urgent else bool(self.someone.get('soon')), task.get('status', ''), bool(task.get('receipt')), (time.monotonic() - started) * 1000)

    def _answer_hint(self) -> str:
        if not self._asked_question():
            return ''
        return ANSWER_HOW if getattr(self.flow, 'asked_how_it_works', lambda: False)() else ANSWER_FIRST

    def _asked_question(self) -> bool:
        texts = self.flow.caller_texts
        return len(texts) > self.turns_before and asks_something(texts[-1])

    def _ready_to_finish(self) -> bool:
        if self.kind == 'complaint':
            if phone_needs_readback(self.fields):
                return False
            return bool(self.fields.get('summary')) and bool(
                self.fields.get('contactPhone') or self.fields.get('contactEmail') or self.fields.get('noContact'))
        return bool(self.fields.get('callerName') and self.fields.get('appointmentAction'))

    @function_tool()
    async def stop_request(self, context: RunContext) -> str | None:
        """The caller no longer wants this request, or wants something this request cannot do. Ends it without saving."""
        last_words = self.flow.caller_texts[-1] if self.flow.caller_texts else ''
        if not _STOP.search(last_words):
            # A "sounds good" must never throw a request away.
            logger.warning('stop_refused kind=%s', self.kind)
            return f'stop_request did not run because the caller did not ask to stop. Next: {next_step(self.kind, self.fields)}.'
        if self.editing:
            # Backing out of a change keeps the saved request as it is.
            if not self.done():
                self.complete({'status': 'unchanged'})
            return None
        try:
            await self.flow.cancel()
        except Exception:
            logger.warning('cancel_failed kind=%s', self.kind, exc_info=True)
        if not self.done():
            self.complete({'status': 'stopped'})

    @function_tool()
    async def lookup_business_fact(self, context: RunContext, query: str) -> str:
        """Look up a fact about the business to answer a side question. Not for recording details."""
        facts = await self.flow.lookup_business_fact(query)
        # Tom's 2026-10-06 call, replayed: after answering from a lookup alone, Blake asked its last question again.
        return self._asked_once(f'{facts}\nNext: {self._next_step()}.')

    @function_tool()
    async def list_services(self, context: RunContext) -> str:
        """List the services the business offers, to answer a side question."""
        return await self.flow.list_services()

    @function_tool()
    async def ask_for_owner(self, context: RunContext) -> str:
        """The caller asks to talk to the owner, a manager or a real person. Call it right away. The call stays open; the
        result says what to tell them."""
        line = await self.flow.ask_for_owner(self)
        then = ('ask what they would like to change' if self.editing and not phone_needs_readback(self.fields)
                else self._next_step())
        return f'{line} Then: {then}.'

    def noted_owner(self, task: dict) -> None:
        """The owner request is in this request's notes."""
        self.someone['owner'] = 'yes'
        self.fields = dict(task.get('fields') or {})

    @function_tool()
    async def end_call(self, context: RunContext,
                       reason: Literal['safety_emergency', 'urgency', 'blocking_unknown', 'caller_ended']):
        """End the call now. safety_emergency: immediate danger. urgency: they refuse a noted request and insist on someone
        right now, after you said you can't promise that. blocking_unknown: they won't go on without a fact you don't have.
        caller_ended: they say they are done, such as "no thanks", "that's all" or "bye"; never for a question or a concern.
        Never for asking to talk to a person; that's ask_for_owner. Say nothing yourself; the application says goodbye."""
        return self.flow.end_call(reason)


class ServiceRequestTask(IntakeTask):
    def __init__(self, flow, task, chat_ctx, editing: bool = False):
        super().__init__(flow, 'service_request', task, chat_ctx, editing)

    @function_tool()
    async def record_details(
        self, context: RunContext,
        name: Annotated[str, Field(description="The contact's name as they said it, or as they spelled it: the caller's own, or "
                                               "the person they want the manager to follow up with.")] = '',
        phone: Annotated[str, Field(description='Phone number digits as heard.')] = '',
        email: Annotated[str, Field(description='Email address as heard.')] = '',
        service: Annotated[str, Field(description='What they need done and the key details they gave about it, such as where, how bad and since when, in one short sentence.')] = '',
        city: Annotated[str, Field(description="City or town of the job. If what they said isn't a real place name, such "
                                               "as \"Sounds\", it was misheard: leave this empty and ask them to say the city "
                                               "again.")] = '',
        state: Annotated[str, Field(description='State of that city, only if the caller said it.')] = '',
        phone_confirmed: Annotated[bool, Field(description='True when the caller says yes to the number you read back.')] = False,
        calling_for: Annotated[str, Field(description="Name of the person they are calling for, if it's someone else, as they spelled it if they did.")] = '',
        property_name: Annotated[str, Field(description="The property's name or street address, if they said it, word for word as heard even when a word seems wrong, since the street is checked against real streets, or as they spelled it if they did.")] = '',
        available: Annotated[str, Field(description="The day or time they said works best for someone to come out, in their words, such as 'weekday mornings'. Never a yes or no.")] = '',
        urgent: Annotated[bool, Field(description='True only when they said they need it right away, or described one of the urgent signs in the situation notes. Something broken or not working is not urgent by itself.')] = False,
    ) -> str | None:
        """Record request details. Call it first, before you reply, on every caller turn that contains any detail, even a
        name on its own or a detail mixed into a question; a detail you do not record is lost if the call drops. Pass only
        what is new in this turn, in the caller's words, and leave the rest empty. Not for small talk. The result says what
        was recorded and the next step. When the request is complete it is saved automatically."""
        return await self._record(context, {'callerName': name, 'contactPhone': phone, 'contactEmail': email, 'serviceNeed': service,
                                   'propertyCity': city, 'propertyState': state, 'phoneConfirmed': phone_confirmed,
                                   'notes': {'person': calling_for, 'property': property_name, 'available': available},
                                   'urgent': urgent})


class ComplaintTask(IntakeTask):
    def __init__(self, flow, task, chat_ctx):
        super().__init__(flow, 'complaint', task, chat_ctx)

    @function_tool()
    async def record_details(
        self, context: RunContext,
        complaint: Annotated[str, Field(description='What went wrong, in one or two sentences.')] = '',
        name: Annotated[str, Field(description="The caller's name as they said it.")] = '',
        phone: Annotated[str, Field(description='Phone number digits as heard.')] = '',
        email: Annotated[str, Field(description='Email address as heard.')] = '',
        no_contact: Annotated[bool, Field(description='True when the caller would rather not give a way to reach them.')] = False,
        phone_confirmed: Annotated[bool, Field(description='True when the caller says yes to the number you read back.')] = False,
    ) -> str | None:
        """Record complaint details. Call it first, before you reply, on every caller turn that contains any detail. Pass only
        what is new in this turn. The result says what was recorded and the next step. Once the complaint and a confirmed way
        to reach them (or no_contact) are in, it is saved."""
        return await self._record(context, {'summary': complaint, 'callerName': name, 'contactPhone': phone, 'contactEmail': email,
                                   'noContact': no_contact, 'phoneConfirmed': phone_confirmed})


class AppointmentTask(IntakeTask):
    def __init__(self, flow, task, chat_ctx):
        super().__init__(flow, 'appointment_lookup', task, chat_ctx)

    @function_tool()
    async def record_details(
        self, context: RunContext,
        name: Annotated[str, Field(description='The name the appointment is under.')] = '',
        change: Annotated[Literal['', 'cancel', 'reschedule'], Field(description='Whether they want to cancel or change it.')] = '',
    ) -> str | None:
        """Record appointment details. Call it first, before you reply, on every caller turn that contains the name or the
        change. Once both are in, the appointment is looked up and the result comes back to you."""
        return await self._record(context, {'callerName': name, 'appointmentAction': change})


TASKS = {'service_request': ServiceRequestTask, 'complaint': ComplaintTask, 'appointment_lookup': AppointmentTask}
