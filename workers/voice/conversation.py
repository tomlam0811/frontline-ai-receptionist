"""Bob v2: a front desk agent plus LiveKit intake tasks, with state owned by the backend (docs/voice-agent-v2-spec.md)."""
from __future__ import annotations

import asyncio
import json
import logging
import re
import time
import uuid
from typing import Literal

from livekit.agents import Agent, ModelSettings, RunContext, ToolResult, function_tool
from agent import (VoiceOrchestrator, _text, _operation_id, receptionist_name, spoken_business_name, MAX_TTS_CHARACTERS)
from runtime import BUSINESS_MODES, RuntimeContractError, RuntimeHttpError, disabled_task_kinds
from intake import (TASKS, WANTS_IT_SOON, note_parts, notes_text, said_digits, service_area_state, spelled_turn, spelling_line,
                    wants_it_soon)
from pacing import SpeechPacingMeter
from prompts import front_desk_instructions
from business_hours import open_for
from speech import (THANKS, follow_up_line, follow_up_window, is_filler_only, is_spare_thanks, said_urgent,
                    strip_filler_opener, strip_thanks_opener)

logger = logging.getLogger('frontline.voice')
ARCHITECTURE = 'bob-task-v1'
END_REASONS = ('human_preference', 'safety_emergency', 'urgency', 'blocking_unknown', 'caller_ended')

# A goodbye is a turn made only of closing clauses ("no thanks", "that's all", "bye"), at least one of which is more than
# an "okay" or a "thanks". Anything else in the turn, such as "but how do you clean", means the caller is not done, and a
# caller_ended for it is a misreading, such as a concern about past work taken for a goodbye.
_SOFT = (r"(?:no|nope|nah|okay|ok|alright|all right|yeah|yes|yep|well|oh|um|uh|so|great|perfect|cool|very cool|awesome|thanks|"
         r"thank you|sounds good|sounds great|i guess|i think|like)")
_DONE_CORE = (r"(?:that's all|that is all|that'll be all|that's it|that is it|that's about it|that's about all|that's everything|"
              r"that's okay|that's ok|"
              r"i'm good|i am good|i'm all good|i'm done|i am done|i'm all set|we're good|we're all set|all set|all good|"
              r"nothing else|i don't think so|not really|no thanks|no thank you|bye|bye-bye|goodbye|good-bye|"
              r"(?:(?:hopefully|i hope) )?(?:you )?have a (?:good|great|nice|wonderful) (?:rest of (?:your|the) )?(?:one|day|night|evening|afternoon|weekend)|"
              r"you too|take care|talk (?:to you )?(?:later|soon)|"
              r"no|nope|nah)")
_TAIL = r"(?:thanks|thank you|bye|for now|for today|i needed|i need|i wanted|to know|to ask|then|so much|very much|again|for your help)"
_DONE_CLAUSE = re.compile(rf"(?:{_SOFT}\s+)*{_DONE_CORE}(?:\s+{_TAIL})*", re.I)
_SOFT_CLAUSE = re.compile(rf"{_SOFT}(?:\s+(?:{_SOFT}|{_TAIL}))*", re.I)
NOT_DONE = ('end_call did not run because the caller did not say they are done. Next: reply to what they just said. If it is '
            'a concern or worry about past work, acknowledge it in one sentence and offer to pass it to the manager.')


def caller_is_done(text: str, name: str = '') -> bool:
    """True when the caller's latest words clearly end the call: "no thanks", "that's all", "bye". A question never does.
    The receptionist's name, as in "thank you, Bob", is left out."""
    text = (text or '').replace('’', "'").lower()
    if name.strip():
        text = re.sub(rf"\b{re.escape(name.strip().lower())}\b", '', text)
    clauses = [clause.strip() for clause in re.split(r'[.!,;:]+|\s+-\s+', text) if clause.strip()]
    if '?' in text or not clauses:
        return False
    if not all(_DONE_CLAUSE.fullmatch(clause) or _SOFT_CLAUSE.fullmatch(clause) for clause in clauses):
        return False
    # A "no" to "anything else?" is a goodbye; an "okay" or a "thanks" on its own is not.
    return any(re.match(r'(?:no|nope|nah)\b', clause) or not _SOFT_CLAUSE.fullmatch(clause) for clause in clauses)

_CLAIM_ALWAYS = re.compile(
    r"\b(?:i(?:'ve| have)?|we(?:'ve| have)?)\s+(?:successfully\s+)?(?:booked|scheduled|cancelled|canceled|rescheduled|notified|sent|transferred)\b"
    r"|\b(?:you're|you are|your appointment is|your appointment's)\s+(?:all\s+)?(?:booked|scheduled|confirmed)\b"
    r"|\b(?:i am|i'm)\s+(?:transferring|connecting)\s+you\b", re.I)
# Claims that the request itself was saved or passed on. "I've noted that you're in Irvine" is not one of them.
_CLAIM_SAVED = re.compile(
    r"\b(?:i(?:'ve| have)?|we(?:'ve| have)?)\s+(?:\w+\s+){0,3}?(?:saved|submitted|logged)\b"
    r"|\b(?:i(?:'ve| have)?|we(?:'ve| have)?)\s+(?:\w+\s+){0,2}?(?:recorded|noted)\s+(?:your|the|this|that)\s+(?:request|complaint|details|info|information)\b"
    r"|\b(?:i(?:'ve| have)?|we(?:'ve| have)?)\s+(?:already\s+)?passed\s+(?:it|this|that|your\s+\w+|the\s+\w+)\s+along\b"
    r"|\b(?:i(?:'ve| have)?|we(?:'ve| have)?|it's|it has|it was|that's|that was)\s+(?:already\s+)?(?:been\s+)?passed\s+along\b"
    r"|\b(?:i'm|i am)\s+(?:now\s+)?(?:passing|sending|submitting|forwarding)\s+(?:it|this|that|your\s+\w+|the\s+\w+)\b"
    r"|\byou(?:'re| are) all set\b", re.I)
# Tom's call, 2026-10-03: "The manager will follow up with you soon" when the request was never saved. A follow-up is
# promised only with a receipt, or as what happens after Bob passes the request on ("I'll pass it along, and they'll...").
# It applies while a request is being taken; explaining how the business works ("First, the manager will follow up")
# before any request is fine.
_CLAIM_FOLLOW_UP = re.compile(r"\b(?:the manager|the owner|they|someone)(?:'ll| will)\s+(?:\w+\s+){0,2}?(?:follow up|get back to "
                              r"you|call you|reach out|contact you|be in touch)\b", re.I)
_FUTURE_PASS = re.compile(r"\b(?:i'll|i will|i'm going to|let me|once|after|when|if)\b", re.I)
SENTENCE = re.compile(r'[^.!?]+[.!?]*')
_GOODBYE = re.compile(r"\b(?:bye|goodbye|take care|thanks for calling|thank you for calling|have a (?:great|good|nice|wonderful|"
                      r"lovely) (?:day|one|evening|night|weekend|afternoon))\b", re.I)
# The end of a finished sentence in streamed text: closing punctuation followed by a space.
SENTENCE_END = re.compile(r'[.!?]+["\')]?\s+')
NO_REPLY_LEFT = 'Let me get the rest of your details first.'


def is_unconfirmed_claim(sentence: str, *, has_receipt: bool = False, request_open: bool = False) -> bool:
    sentence = sentence.replace('’', "'")
    if has_receipt:
        return bool(_CLAIM_ALWAYS.search(sentence))
    return bool(_CLAIM_ALWAYS.search(sentence) or _CLAIM_SAVED.search(sentence)
                or (request_open and _CLAIM_FOLLOW_UP.search(sentence) and not _FUTURE_PASS.search(sentence)))


def guarded_reply(text: str, *, has_receipt: bool = False, request_open: bool = False) -> str:
    """Drops sentences that claim an action the application has not confirmed, and keeps the rest of the reply."""
    normalized = text.replace('’', "'")
    kept, blocked = [], False
    for sentence in SENTENCE.findall(normalized):
        if is_unconfirmed_claim(sentence, has_receipt=has_receipt, request_open=request_open):
            blocked = True
            continue
        kept.append(sentence)
    if not blocked:
        return text
    logger.warning('claim_blocked architecture=%s', ARCHITECTURE)
    return ''.join(kept).strip() or NO_REPLY_LEFT


# A saved request stays open to changes until the call ends. A second request for the same need would only give the
# owner a duplicate, so code turns it into a change to the saved one. Another property is its own request.
NO_SAVED_REQUEST = ("change_request did not run: no request has been passed along on this call yet. Next: if they want "
                    "something passed along, offer to take it down.")
CHANGED = ("The saved request is updated with that change, and the manager will see it. Tell the caller in a few words, then ask "
           "if there's anything else, unless they already said they're done.")
UNCHANGED = "Nothing on the saved request was changed. Ask if there's anything else."
SAVED_THIS_TURN = ("change_request did not run: what the caller just said is already in the request saved this turn. Next: "
                   "follow the earlier result and tell them it's passed along.")
_ANOTHER_PLACE = re.compile(r"\b(?:another|second|different|other|separate|new)\s+(?:\w+\s+)?(?:property|properties|place|"
                            r"location|site|plaza|building|house|home|lot|address|store|shop|office|unit|complex|center)\b", re.I)


def names_another_property(texts: list[str]) -> bool:
    """True when the caller talks about another property, such as "my other plaza" or "a second location"."""
    return any(_ANOTHER_PLACE.search(text or '') for text in texts)


# Asking for a person keeps the call going: no one can be connected, so the owner gets a note to follow up instead.
OWNER_AWAY = ("Tell the caller, in your own words, that nobody can come to the phone right now, that you'll let the manager "
              "know they asked, and that they'll follow up as soon as possible, and say sorry for the inconvenience.")
OWNER_NOTED = f"{OWNER_AWAY} The manager will see they asked for them. Then ask if there's anything else."
OWNER_NEEDS_CONTACT = (f"{OWNER_AWAY} So the manager can follow up, offer to take their name and number; when they say yes, call "
                       "start_service_request.")
_ASKS_FOR_PERSON = re.compile(r"\b(?:owner|manager|boss|person|human|someone|somebody|representative|agent|operator|"
                              r"talk to|speak (?:to|with))\b", re.I)
NO_PERSON_ASKED = "ask_for_owner did not run: the caller didn't ask for the owner or a person. Next: answer what they asked."
# Magnus's call, 2026-10-06: the caller began the address with "It'll", and the model ended the call as blocking_unknown,
# saying the request was saved though it was not. That ending needs the caller to have said they won't go on.
_WONT_GO_ON = re.compile(r"\b(?:no|not|don't|do not|won't|can't|cannot|never ?mind|forget it|need to know|have to know|"
                         r"unless|go elsewhere|someone else|another company)\b", re.I)
KEEP_GOING = ("end_call did not run because the caller has not said they won't go on. Next: reply to what they just said. "
              "If it was cut off, ask them to go ahead.")


def wont_go_on(text: str) -> bool:
    """True when the caller's words could refuse to go on, which a blocking_unknown ending needs."""
    return bool(_WONT_GO_ON.search(text or ''))


PERSON_KEEPS_CALL = ("end_call did not run: asking for a person doesn't end the call. Next: call ask_for_owner, which says what "
                     "to tell them.")
_ANOTHER_NEED = re.compile(r"\b(?:another|also|different|second|separate|one more|other|too|as well|new)\b", re.I)
_GENERIC_NEED_WORDS = {'clean', 'cleaning', 'cleaned', 'wash', 'washing', 'washed', 'pressure', 'power', 'service', 'services',
                       'need', 'needs', 'want', 'wants', 'help', 'with', 'that', 'this', 'their', 'they', 'some', 'around',
                       'each', 'within', 'also', 'request', 'owner', 'manager', 'pass', 'along', 'caller', 'customer', 'friend', 'info',
                       'information', 'details', 'property', 'work', 'done', 'have', 'like', 'from', 'about', 'just', 'give',
                       'job', 'wants', 'passed', 'want', 'over'}


def _need_words(text: str) -> set[str]:
    words = {word.rstrip('s') for word in re.findall(r"[a-z]{4,}", (text or '').lower())}
    return words - {word.rstrip('s') for word in _GENERIC_NEED_WORDS}


# "Yes, that's right." answers Bob's question. It never asks for a new job, whatever summary the model writes for it.
_BARE_ANSWER = re.compile(r"^\W*(?:(?:yes|yeah|yep|yup|correct|right|exactly|sure|okay|ok|uh-huh|mm-hmm|no|nope)\b[\s,.!]*)+"
                          r"(?:(?:that's|that is|it's|it is) (?:right|correct|it)\b)?\W*$", re.I)


def is_bare_answer(text: str) -> bool:
    """True for a plain yes or no, such as "Yes, that's right.", with nothing else asked for."""
    return bool(_BARE_ANSWER.match(text or ''))


def is_same_need(saved: dict, summary: str) -> bool:
    """True when a new service request would repeat the saved one: the summary names nothing specific, such as "pass the
    caller's details to the manager", or shares a specific word with what was saved."""
    before = _need_words(' '.join(filter(None, [(saved.get('fields') or {}).get('serviceNeed', ''), saved.get('goal', '')])))
    after = _need_words(summary)
    return not after or bool(before & after)


# "Can you help me with that?" asks whether the business does the work. It is not yet a yes to passing details along.
_ASKS_IF_WE_HELP = re.compile(r"\b(?:can|could|do|would|will) (?:you|y'all)(?: guys| all)?\b[^?]*\b(?:help|do|handle|clean|wash|"
                              r"offer|take care|work on)\b[^?]*\?", re.I)
_SAYS_YES = re.compile(r"\b(?:yes|yeah|yep|sure|okay|ok|please|go ahead|pass (?:it|that|my)|take (?:my|down)|sign me up|"
                       r"book|quote|my name is|my number)\b", re.I)
# Tom's 2026-10-06 call: asked for the address, he said "Give me a second" twice, and Blake asked for the address after
# each one. A caller who asks to wait gets one short "take your time", then quiet until they speak or HOLD_SECONDS pass.
_WAIT = re.compile(r"\b(?:give|gimme)\W+(?:me\W+)?(?:a|one|just a)\W+(?:sec|second|moment|minute|min|bit)s?\b|"
                   r"\b(?:wait|just|one)\W+(?:a\W+)?(?:sec|second|moment|minute)s?\b|\b(?:hold on|hang on|hold up|one sec)\b|"
                   r"\bbe right back\b|\breal quick\b|"
                   r"\b(?:(?:let me|lemme|i'm gonna|i am gonna|i'm going to|i am going to)\W+(?:go\W+)?|"
                   r"(?:i gotta|i have to|i need to)\W+go\W+)(?:check|find|look|grab|pull|dig)\b", re.I)
# Words that carry nothing to record, such as "Uh, for the address," or "That's what I was saying."
_HOLD_FILLER = set("uh um okay ok yeah yes yep no sorry so well hmm oh right alright sure actually that's that what i'm i "
                   "was am saying said for the address number it hey can could would you me please mind if is a just sec "
                   "second moment minute go to find look check grab real quick my this gonna going let lemme up".split())
HOLD_SECONDS = 20
HOLD_REPLY = 'Sure, take your time.'
HOLD_AGAIN = 'Sure.'
HOLD_OVER = "No rush, I'm here whenever you're ready."


# Tom's 2026-10-06 test: after "give me a second, I'm gonna go find the address", the caller gave it, and Blake said "No
# worries, the manager can get the exact address when they follow up". That is said only when the caller defers.
_GET_IT_LATER = re.compile(r"\bmanager (?:can|will) (?:get|grab|collect|confirm)\b[^.?!]*\b(?:follow|later|call)", re.I)
_DEFERS = re.compile(r"\b(?:later|after (?:the|this) call|don't (?:have|know)|do not (?:have|know)|not sure|no idea|"
                     r"(?:text|email|send) (?:it|you|that))\b", re.I)


def hold_kind(text: str) -> str:
    """'only' when the caller's whole turn asks Blake to wait, such as "Can you give me a second? I'm gonna go find the
    address real quick." 'mixed' when it asks to wait and also says something else, such as their name, which is still
    recorded. '' otherwise. A number or a question about anything else is never a wait."""
    sentences = [sentence.strip() for sentence in SENTENCE.findall(text or '') if sentence.strip()]
    waits = [sentence for sentence in sentences if _WAIT.search(sentence)]
    if not waits or re.search(r'\d', text) or len(said_digits(text)) >= 2:
        return ''
    def only_filler(sentence: str) -> bool:
        return set(re.findall(r"[a-z']+", _WAIT.sub(' ', sentence).lower())) <= _HOLD_FILLER
    # "Can you hold on a second?" asks to wait; "Hold on, how much does it cost?" asks something else.
    if any(sentence.endswith('?') and not only_filler(sentence) for sentence in sentences):
        return ''
    return 'only' if all(only_filler(sentence) for sentence in sentences) else 'mixed'


def asks_to_wait(text: str) -> bool:
    return hold_kind(text) == 'only'


# Tom's 2026-10-06 call: Blake said "I'll get a service request started. Can I have your name and phone number?" without
# starting it, so nothing was checked or saved. The number was read back wrong, the address was never asked, Blake said the
# request was passed along, and once the request did start it asked for the number again. Details are taken only by the
# request step, so a caller giving them, or a reply asking for them, starts the request instead.
_GIVES_CONTACT = re.compile(r"\b(?:my|the) name(?:'s| is)\b|\bname is\b|\b(?:my|the) (?:phone |cell )?number(?:'s| is)\b", re.I)
_ASKS_CONTACT = re.compile(r"\b(?:your|a|the)\s+(?:full\s+|first\s+|last\s+)?name\b|\b(?:phone|contact|callback)\s+number\b|"
                           r"\bnumber (?:to|where|we|I|they|the manager)\b|\b(?:your|the)\s+(?:street\s+)?address\b", re.I)
CONTACT_STARTS = ("Details are taken only by the request step. Call start_service_request now, in this reply, with what they "
                  "need; it records what they already said and asks for the rest.")


def gives_contact(text: str) -> bool:
    """True when the caller starts giving their name or number: "My name is Sarah", or seven or more digits."""
    return bool(_GIVES_CONTACT.search(text or '')) or len(said_digits(text or '')) >= 7


def asks_contact(reply: str) -> bool:
    """True when a reply asks the caller for their name, number or address."""
    sentences = SENTENCE.findall((reply or '').replace('’', "'"))
    return any(sentence.rstrip().endswith('?') and _ASKS_CONTACT.search(sentence) for sentence in sentences)


# Tom (2026-10-01): "dumpster pads and corrals" meant nothing to him. A service is named the way the caller would say it.
PLAIN_NAMES = ("Describe each one in plain everyday words close to how the caller put it, for example \"pressure washing in "
               "front of the stores, plus cleaning around the trash area\". Never say the list's own names or trade terms, "
               "not even after the plain words.")
OFFER_FIRST = ('start_service_request did not run because the caller only asked whether you can help. Next: name the matching '
               f"services the business offers, without repeating their need back to them, and ask if that would work for them. {PLAIN_NAMES}")


# Appended to the front desk's service list before any request, where the caller hears what fits and is asked if they're
# interested instead of having their need repeated back and being offered a hand-off straight away (Tom, 2026-10-01).
OFFER_SERVICES = ("Next, if a service on this list fits what they need: if they said it's urgent, first say you can't promise any "
                  "timing but you'll make sure the manager knows. Then name only the services that fit, at most two, without "
                  f"repeating their need back, and ask if that would work for them, not whether they want to hear more. "
                  f"{PLAIN_NAMES} Don't offer to pass anything along yet.")


def offer_first(spoken: str) -> str:
    """The refusal for an early start. When Bob already answered in this turn, it quotes that answer so the next reply
    only offers, instead of saying the same thing twice."""
    if not spoken.strip():
        return OFFER_FIRST
    return (f'start_service_request did not run because the caller only asked whether you can help. You already said: '
            f'"{spoken.strip()}". Next: in one short sentence, only ask if that would work for them.')


# "Uh, yes. So what does the process look like?" agrees to the offer and asks something in the same breath.
_YES_FIRST = re.compile(r"^\W*(?:(?:uh|um|so|oh|well|okay|ok)\W+)*(?:yes|yeah|yep|yup|sure|definitely|absolutely)\b", re.I)
FACTS_ONLY = ("Answer only from these facts. If none of them answers the question, say the manager can go over that when "
              "they follow up, and don't say what the business does or doesn't do.")
YES_THEN_START = ("They also said yes to your offer. Answer their question from these facts in one or two short sentences, then "
                  "call start_service_request in this same reply. Don't ask whether that sounds good.")
# Bob's question that offered a service or to pass the request on: "Would that work for your friend?".
_OFFERED = re.compile(r"\b(?:would (?:that|this|those|these|it)|does (?:that|this) (?:work|sound|help)|work for|interested|"
                      r"sounds? good|want (?:me|us) to|like (?:me|us) to|should I|shall I)\b", re.I)
# Tom's sixth 2026-10-01 call: "Yeah, that'd be great. What's the next step?" got the offer again instead of the request.
YES_START = ("The caller just said yes to what you offered. Call start_service_request now, in this reply, and let it say "
             "the next step. Don't ask again whether to pass it along or start a request.")


# The caller's own words about an existing appointment. Since Bob asks when works best (2026-10-03), the model sometimes
# reached for check_appointment right after a request was saved, so the lookup needs the caller to have asked for it.
_ABOUT_AN_APPOINTMENT = re.compile(r"\b(?:appointments?|bookings?|booked|visits?|cancel\w*|reschedul\w*|postpone|push (?:it|my)|"
                                   r"move (?:it|my)|change (?:it|my)|scheduled)\b", re.I)


def asks_about_an_appointment(caller_texts: list[str]) -> bool:
    return any(_ABOUT_AN_APPOINTMENT.search(text) for text in caller_texts[-2:])


def only_asks_if_we_help(text: str) -> bool:
    """True when the caller's latest words ask whether the business can do the work, without agreeing to pass details on."""
    return bool(_ASKS_IF_WE_HELP.search(text or '')) and not _SAYS_YES.search(text or '')


# An offer to pass something to the owner. Once the request is saved, only a new concern is worth offering.
_OFFER_TO_PASS = re.compile(r"\b(?:pass|send|forward|give|share)\b.*\b(?:along|owner|manager|on to)\b", re.I)
# "We offer repair and maintenance for air conditioning units." Tom's 2026-10-04 call: after "I'll mark this as urgent",
# that sentence only repeated the caller's problem as a service, though the instructions say not to.
_NAMES_SERVICES = re.compile(r"^\W*(?:we|our team)(?: also| can| do)? (?:offer|do|handle|provide|specialize|take care of|"
                             r"can (?:do|help with|handle|take care of))\b", re.I)
# An offer to pass a complaint along. Narrower than _CONCERN: "pass this issue to the manager" is still a service request.
_COMPLAINT_OFFER = re.compile(r"\b(?:concern|complain\w*|feedback)\b", re.I)
_CONCERN = re.compile(r"\b(?:concern|complain\w*|feedback|worr\w*|issue|problem|not happy|unhappy|missed|ensure|guarantee|"
                      r"make sure|not well received)\b", re.I)
ALREADY_WITH_OWNER = "It's already with the manager."

# How the work is done: each group of words is one kind of method claim. A claim is spoken only when the business
# profile, its facts or a knowledge result on this call uses the same kind of words.
METHOD_CLAIMS = tuple(re.compile(pattern, re.I) for pattern in (
    # Heat as a cleaning method only: "a heat pump" or "this heat" is how an HVAC caller talks, not a method claim.
    r"\b(?:high[- ]temperature|hot[- ](?:water|pressure|wash\w*)|heat(?:ed)?[- ](?:water|wash\w*|clean\w*|treat\w*))\b",
    r"\bsteam\w*", r"\bsoft[- ]?wash\w*",
    r"\blow[- ]pressure\b",
    r"\b(?:eco[- ]friendly|biodegradable|environmentally|non[- ]toxic)\b", r"\bdegreas\w*", r"\b(?:chemical|detergent|bleach)\w*",
    r"\bseal(?:ant|er|ing)\w*", r"\b(?:saniti[sz]|disinfect)\w*",
    r"\b(?:reclaim\w*|water recovery|recycl\w* (?:the |our |all )?(?:waste ?)?water)",
    # Tom's 2026-10-04 call: "they handle everything from diagnosing the problem to fixing it, and they keep you informed
    # through the process" was in no source.
    r"\bkeep (?:you|them) (?:informed|updated|posted|in the loop)\b", r"\bhandle everything\b"))
OWNER_EXPLAINS = "I'm not sure about that part, but the manager can walk you through it when they follow up."


LOOKUP_CHARS = 6000


def for_the_model(result) -> str:
    """A knowledge result the model reads only the start of. Every fact goes first as its id, group and value, and the
    source passages fill what room is left, so a fact such as the owner's own answer is never cut off behind long
    website passages and bookkeeping fields."""
    if not isinstance(result, dict) or not isinstance(result.get('facts'), list):
        return json.dumps(result)
    facts = [{key: fact[key] for key in ('factId', 'group', 'value', 'predicate') if key in fact}
             for fact in result['facts'] if isinstance(fact, dict)]
    compact = {key: value for key, value in result.items() if key not in ('facts', 'passages')} | {'facts': facts}
    text = json.dumps(compact)
    passages = [passage.get('text', '') for passage in result.get('passages') or [] if isinstance(passage, dict)]
    room = LOOKUP_CHARS - len(text) - 20
    if passages and room > 200:
        text = text[:-1] + ', "passages": ' + json.dumps(passages)[:room] + '}'
    return text


# "How does the process look?", "how are you guys gonna clean this?": answered from the business's own knowledge, so the
# lookup runs before Bob says anything (the 2026-10-01 call answered "I'm not sure" without looking).
_ASKS_HOW_IT_WORKS = re.compile(
    r"\bprocess\b|\bwalk me through\b|\bwhat (?:are )?the steps\b"
    r"|\bhow (?:do|does|will|would|are|can) (?:you|y'all|they|the crew|your crew|your team)(?: guys| all)? "
    r"(?:usually |normally |typically |generally |actually |even )?(?:gonna |going to )?"
    r"(?:clean|wash|do|handle|work|go about|approach|take care)", re.I)
LOOKUP_FIRST = ModelSettings(tool_choice={'type': 'function', 'function': {'name': 'lookup_business_fact'}})
# Tom's call, 2026-10-03: "Yeah, can you get someone here ASAP?" to Blake's offer got the offer again. A yes to the offer
# starts the request in code; the request step says it is urgent and what happens next.
START_REQUEST = ModelSettings(tool_choice={'type': 'function', 'function': {'name': 'start_service_request'}})


def asks_how_it_works(text: str) -> bool:
    """True when the caller asks how the work is done or what the process is."""
    return bool(_ASKS_HOW_IT_WORKS.search(text or ''))


def unsourced_method(sentence: str, sourced: str) -> bool:
    """True when the sentence says how the work is done in words no business source on this call supports."""
    return any(claim.search(sentence) and not claim.search(sourced) for claim in METHOD_CLAIMS)


def _log_query(query: str) -> str:
    """A lookup query for the log, with digits and email addresses masked so no caller contact detail is kept."""
    return json.dumps(re.sub(r'\d', '#', re.sub(r'\S+@\S+', '[email]', query or ''))[:120])


# The stock closing question. It is held back when the caller trailed off, and not repeated within three replies
# unless it follows an answer to something the caller asked.
_CLOSING = re.compile(r"\b(?:anything|something) else\b|\bwhat else\b|\banything more\b", re.I)
_QUESTION_START = re.compile(r"^\W*(?:what|how|why|when|where|who|which|can|could|do|does|did|is|are|will|would|should)\b", re.I)
_TRAILING_OFF = re.compile(r"(?:\b(?:like|and|so|um|uh|but|because|or)|,)\W*$", re.I)


def is_closing_question(sentence: str) -> bool:
    return sentence.rstrip().endswith('?') and bool(_CLOSING.search(sentence))


# Said after an answer that would otherwise leave the caller to lead the call.
CHECK_INS = ("Let me know if you have any other questions.", "Is there anything else I can help with?")
_INVITES = re.compile(r"\b(?:other questions|anything else|something else|what else|let me know)\b", re.I)


_NOTED = re.compile(r"\b(?:got it|gotcha|i see|makes sense|that makes sense|understood|right|good|nice)\b", re.I)


def adds_something(text: str) -> bool:
    """True when the caller's turn says more than "okay", "got it" or "I see, thanks", such as "ideally before eight AM"."""
    if acknowledges_only(text):
        return False
    rest = _NOTED.sub('', text or '')
    return bool(re.search(r"\w", rest)) and not acknowledges_only(rest)


def acknowledges_only(text: str) -> bool:
    """True for a turn that only acknowledges or thanks, such as "Okay, sounds good. Thank you.", with nothing to answer."""
    text = (text or '').replace('’', "'").lower()
    clauses = [clause.strip() for clause in re.split(r'[.!,;:]+|\s+-\s+', text) if clause.strip()]
    return bool(clauses) and '?' not in text and all(_SOFT_CLAUSE.fullmatch(clause) for clause in clauses)


# Tom (2026-10-01): a caller who says "sounds good, thank you" once the request is passed along gets a warm wrap-up that
# leaves the door open, instead of a bare "Take care!".
WRAP_UP = ("The caller is acknowledging what you said and seems to be wrapping up. Close warmly in your own words, in one "
           "or two short sentences: say you're welcome if they thanked you, tell them to let you know if they have any "
           "other questions, and if not, wish them a good rest of their day{follow_up}. Don't ask anything else and don't "
           "repeat details.")
FOLLOW_UP_SOON = " and say the manager will be in touch soon"
_OWNER_WORD = re.compile(r"\b(the|The|our|Our|my|My|your|Your) ([Oo]wner)('s)?\b")
# The front-desk tool that starts each kind of task.
TASK_TOOLS = {'service_request': 'start_service_request', 'complaint': 'report_complaint',
              'appointment_lookup': 'check_appointment'}
# The request step was cut off when the caller kept talking as it opened. The backend keeps the open task, so starting it
# again carries on with it.
TASK_INTERRUPTED = ("{tool} did not finish because the caller kept talking while it opened. Nothing went "
                    "wrong; don't apologize or mention it. Next: reply to what they just said, and if they still want "
                    "it, call {tool} again.")


def caller_asked(text: str) -> bool:
    """True when the caller's latest words ask something."""
    return '?' in (text or '') or bool(_QUESTION_START.match(text or ''))


def caller_mid_topic(text: str) -> bool:
    """True when the caller's latest words trail off mid-thought, so a closing question would cut them short. A question
    mark means they finished asking, even when the transcript ends on a filler such as "...look like?"."""
    return '?' not in (text or '') and bool(_TRAILING_OFF.search(text or ''))


def tell_then_ask(passed: str) -> str:
    return ("Reply in this order: respond to what they just said in one sentence, if it needs a response; then say plainly "
            f"that their request is passed along to the manager, for example \"{passed}\"; then ask if there's anything "
            "else, unless they already said they're done. Never skip the middle part.")


TELL_THEN_ASK = tell_then_ask("I've passed your request along to the manager.")


def result_line(kind: str, task: dict, closing_policy: str, business_name: str, urgent_said: bool = False,
                open_now: bool = True, open_an_hour: bool = True) -> str:
    """What the front desk tells the caller once a task finishes, as plain facts for the model to put in its own words.
    `urgent_said` is whether Blake already told the caller it is urgent, so the save does not say it again. `open_now`
    and `open_an_hour` say whether the business is open now and for the next hour, which sets the follow-up window."""
    if task.get('status') == 'stopped':
        return 'The request was stopped and nothing was passed along. Ask if there is anything else.'
    if kind == 'service_request' and task.get('receipt'):
        fields = task.get('fields') or {}
        urgent = WANTS_IT_SOON in str(fields.get('notes') or '')
        # Tom, 2026-10-03: the caller hears when to expect a call back, softened with "usually" or "or so" because nobody
        # can promise an exact time. The window is in the example sentence because Bob tends to say the example.
        # Tom (2026-10-04): no "Thanks for your patience" when the caller was not kept waiting.
        window = follow_up_window(urgent, open_now, open_an_hour)
        if urgent and urgent_said:
            passed = f"I've passed your request along to the manager, so they'll try to get back to you {window}."
        elif urgent:
            passed = (f"I've passed your request along to the manager and marked it urgent, so they'll try to get back to "
                      f"you {window}.")
        else:
            passed = f"I've passed your request along to the manager, and they'll usually get back to you {window}."
        if closing_policy == 'signup_pitch':
            fact = f"The request is saved. {follow_up_line(business_name, fields, urgent, open_now, open_an_hour)}"
        else:
            # Owner calls and shared links get the same answer a real caller gets: Bob is never framed as a test.
            fact = "The request is saved and passed along for the manager to review" + (", marked urgent." if urgent else ".")
        again = " You already told them it's urgent, so don't say urgent again." if urgent and urgent_said else ''
        # Tom's 2026-10-06 call, replayed: the caller's last words were the address, and Blake said "the manager can get
        # the exact address when they follow up". Naming what was saved keeps the reply from contradicting it.
        place = note_parts(str(fields.get('notes') or '')).get('property', '')
        where = ', '.join(part for part in (place, fields.get('propertyCity')) if part)
        if where:
            fact += f" The address they gave, {where}, is saved with it."
        return (f"{fact} {tell_then_ask(passed)} Keep the timing words, including \"usually\" or \"or so\", since it "
                f"isn't a promise.{again} Don't offer to pass it along again later in the call.")
    if kind == 'complaint' and task.get('receipt'):
        return ('The complaint is recorded for the manager to review. Tell the caller without promising a fix or a call back. '
                "Then ask if there's anything else, unless they already said they're done.")
    lookup = task.get('lookup') or {}
    if lookup.get('kind') == 'not_found':
        return "No appointment was found under that name. Tell the caller, and offer to take a new service request instead."
    if lookup:
        return "Appointments can't be checked right now. Tell the caller you don't know whether one exists, then ask if there is anything else."
    return "That didn't go through, so nothing was passed along. Tell the caller you couldn't take it down right now, then ask if there is anything else."


class FrontDesk(Agent):
    """Finds the need, answers questions, and starts an intake task when the caller wants a follow-up."""

    def __init__(self, runtime, bundle):
        super().__init__(instructions=front_desk_instructions(bundle))
        self.runtime, self.bundle, self.mode = runtime, bundle, bundle.get('mode')
        self.disabled_kinds = disabled_task_kinds(bundle.get('enabledWorkflows'))
        self.revision = int(bundle.get('workflowRevision', 1))
        self.caller_turn_id = ''
        self.allowed = set()
        self.orchestrator: CallFlow | None = None

    async def on_user_turn_completed(self, turn_ctx, new_message):
        if self.orchestrator:
            await self.orchestrator.record_caller_turn(new_message)
            if self.orchestrator.saved_request:
                # change_request appears once a request is saved, from the next caller turn on.
                await self.configure_tools()

    async def llm_node(self, chat_ctx, tools, model_settings):
        # The orchestrator exists from the greeting on; before that the session has nothing to guard.
        node = (self.orchestrator.guarded_llm_node(self, chat_ctx, tools, model_settings) if self.orchestrator
                else Agent.default.llm_node(self, chat_ctx, tools, model_settings))
        async for chunk in node:
            yield chunk

    async def tts_node(self, text, model_settings):
        node = (self.orchestrator.paced_tts_node(self, text, model_settings) if self.orchestrator
                else Agent.default.tts_node(self, text, model_settings))
        async for frame in node:
            yield frame

    async def configure_tools(self):
        """Keep only the tools this call may use: Q&A has product facts only, and turned-off request kinds are hidden.
        change_request is offered only once a request is saved, so it is never used to repeat what was just saved."""
        if not hasattr(self, '_all_tools'):
            self._all_tools = list(self.tools)
        names = {'end_call'}
        if self.mode == 'frontline_qa':
            names.add('lookup_frontline_fact')
        else:
            names |= {'lookup_business_fact', 'list_services', 'get_service_details'}
            names.add('ask_for_owner')
            names |= {tool for kind, tool in TASK_TOOLS.items() if kind not in self.disabled_kinds}
            saved = self.orchestrator and self.orchestrator.saved_request
            if 'service_request' not in self.disabled_kinds and saved and self.orchestrator.saved_turn_id != self.caller_turn_id:
                names.add('change_request')
        await self.update_tools([tool for tool in self._all_tools if getattr(getattr(tool, 'info', None), 'name', None) in names])

    async def _start(self, context, kind, goal):
        if kind in self.disabled_kinds or self.mode not in BUSINESS_MODES:
            return ('That did not run: this business has turned it off. Next: tell the caller you can\'t do that here and offer '
                    'to help with something else.')
        return await self.orchestrator.run_task(self, kind, goal)

    @function_tool()
    async def start_service_request(self, context: RunContext, summary: str) -> str:
        """Start taking down a service request for the manager. Call it as soon as the caller says yes to passing it along
        (even just "sure" or "okay"), asks for a quote or booking, or starts giving their name or number. summary: what
        they need, in one sentence. Not when they have only asked whether you can help; offer first. Never ask for a name,
        phone number or any other detail before calling it; the request step records what they already said and asks for
        the rest."""
        return await self._start(context, 'service_request', summary)

    @function_tool()
    async def change_request(self, context: RunContext, change: str) -> str:
        """The caller wants to change or add a detail on the request already passed along on this call, such as a different
        city, the exact address, a better number or who it's for. Call it right away, without asking for the detail first.
        change: what they want changed, in one sentence. Only for something the caller says after the request was passed
        along, never to repeat details it already has. Not for another property or a different job; that's a new request."""
        if self.mode not in BUSINESS_MODES or 'service_request' in self.disabled_kinds:
            return "That did not run: this business has turned it off."
        return await self.orchestrator.run_change(self, change)

    @function_tool()
    async def ask_for_owner(self, context: RunContext) -> str:
        """The caller asks to talk to the owner, a manager or a real person. Call it right away. The call stays open; the
        result says what to tell them."""
        return await self.orchestrator.ask_for_owner()

    @function_tool()
    async def report_complaint(self, context: RunContext, summary: str) -> str:
        """Start taking down a complaint about the business or its work. Call it right away when the caller wants to complain,
        describes a problem with work that was done, or says yes to passing a concern to the manager, without asking for
        details first; the complaint step asks for them. Feedback about how you talk is ordinary conversation, not a complaint. summary: what went wrong, in one
        sentence."""
        return await self._start(context, 'complaint', summary)

    @function_tool()
    async def check_appointment(self, context: RunContext, action: Literal['cancel', 'reschedule']) -> str:
        """The caller wants to cancel or change an existing appointment. Call it right away, without asking their name
        first; the appointment step asks for it."""
        return await self._start(context, 'appointment_lookup', f"{'Cancel' if action == 'cancel' else 'Change'} the caller's appointment")

    @function_tool()
    async def lookup_business_fact(self, context: RunContext, query: str) -> str:
        """Look up a sourced fact about the business, such as its phone number, email or address, hours, area served or
        pricing policy. When the caller asks how to reach the business, look up its contact details and read them out."""
        facts = await self.orchestrator.lookup_business_fact(query)
        if 'service_request' not in self.disabled_kinds and self.orchestrator.said_yes_to_offer():
            # 2026-10-01 call: Bob answered "what's the process?" and offered again, though the caller had said yes.
            return f'{facts}\n{YES_THEN_START}'
        return facts

    @function_tool()
    async def list_services(self, context: RunContext) -> str:
        """List the services the business offers."""
        services = await self.orchestrator.list_services()
        if self.orchestrator.saved_request or (self.orchestrator.current_task or {}).get('status') == 'running':
            return services
        return f'{services}\n{OFFER_SERVICES}'

    @function_tool()
    async def get_service_details(self, context: RunContext, service_id: str) -> str:
        """Read the sourced details of one listed service."""
        return await self.orchestrator.get_service_details(service_id)

    @function_tool()
    async def lookup_frontline_fact(self, context: RunContext, query: str) -> str:
        """Look up an approved fact about Frontline itself."""
        return await self.orchestrator.lookup_frontline_fact(query)

    @function_tool()
    async def end_call(self, context: RunContext, reason: Literal['safety_emergency', 'urgency', 'blocking_unknown', 'caller_ended']):
        """End the call now. safety_emergency: immediate danger. urgency: they refuse a noted request and insist on someone
        right now, after you said you can't promise that. blocking_unknown: they won't go on without a fact you don't have.
        caller_ended: they say they are done, such as "no thanks", "that's all" or "bye"; never for a question or a concern.
        Never for asking to talk to a person; that's ask_for_owner. Say nothing yourself; the application says goodbye."""
        return self.orchestrator.end_call(reason)


def _words(text: str) -> str:
    """Lowercase words only, so a transcript can be found inside a turn whatever the punctuation."""
    return ' '.join(re.findall(r"[a-z0-9']+", text.lower()))


class CallFlow(VoiceOrchestrator):
    """Records caller turns, runs intake tasks against the backend, and owns ending the call."""

    def __init__(self, session, bob, runtime, room, bundle):
        super().__init__(session, bob, runtime, room, bundle)
        self.bundle = bundle
        self.current_task = bundle.get('currentTask')
        self.ending_requested = False
        self.idle_checkin_sent = False
        self.hold_until = 0.0
        self.holding = False
        self.pacing_sequence = 0
        self.business_name = spoken_business_name(bundle)
        self.turn_text = ''
        self.caller_texts: list[str] = []
        # Every final transcript since the last caller turn. LiveKit drops a turn that ends while Bob's reply cannot be
        # interrupted (during a save), so words heard but never in a turn are added to the next one.
        self.finals: list[str] = []
        self._service_state: asyncio.Task | None = None
        # Everything the business sources said on this call, so a method claim can be checked against it.
        self.sourced_text = json.dumps([bundle.get('profile'), bundle.get('facts')])
        # The last three replies spoken, so a closing question is not repeated.
        self.recent_replies: list[str] = []
        # Thank-yous the caller has heard, counted from what was actually spoken, not from discarded drafts.
        self.thanks_heard = 0
        # The service request saved on this call, if any. It cannot be changed, and a second one for the same need is refused.
        self.saved_request: dict | None = None
        # The caller asked for the owner: a request taken later on this call carries a note saying so.
        self.asked_for_owner = False
        self.saved_turn_id = ''
        # What Bob already said since the caller last spoke, so a tool result can tell the model not to say it again.
        self.spoken_this_turn = ''
        # Everything Bob said on the call, so a tip he already gave is not given again.
        self.replies: list[str] = []
        # A word the caller just spelled letter by letter, until a reply has been told to read it back.
        self.spelling = ''
        # The caller turn Bob gave the warm wrap-up to. Another "okay, thanks" after it ends the call.
        self.wrapped_up_at = 0

    # Caller turns

    def on_final_transcript(self, event) -> None:
        if event.is_final and (text := _text(event.transcript, 4000)):
            self.finals.append(text)

    def _with_unheard_words(self, message, text: str) -> str:
        """The turn's text, led by any earlier words that never reached a turn. The turn is made of the latest finals,
        so finals before the last one it holds were dropped, and finals after it wait for the next turn."""
        heard, said = self.finals, _words(text)
        last = max((i for i, final in enumerate(heard) if _words(final) in said), default=-1)
        missed = [final for final in heard[:last] if _words(final) not in said]
        self.finals = heard[last + 1:] if last >= 0 else []
        if not missed:
            return text
        logger.info('caller_words_recovered words=%d', sum(len(final.split()) for final in missed))
        text = _text(' '.join([*missed, text]), 4000)
        message.content = [text]
        return text

    async def record_caller_turn(self, message) -> None:
        """Persist the finished caller turn before the reply, so every tool can bind to it. A failure is logged, not fatal."""
        text = _text(message.text_content, 4000)
        if self.terminal or not text:
            return
        text = self._with_unheard_words(message, text)
        self.turn_started_at = time.monotonic()
        self.caller_texts.append(text)
        self.spoken_this_turn = ''
        self.spelling = spelling_line(spelled_turn(self.caller_texts))
        client_turn_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f'frontline:turn:{self.runtime.dispatch.demo_id}:{message.id}'))
        for attempt in range(2):
            try:
                turn = await asyncio.wait_for(self.runtime.caller_turn(client_turn_id, text), 3)
                self.bob.caller_turn_id, self.turn_text = turn['callerTurnId'], text
                self.workflow_revision = max(self.workflow_revision, int(turn['workflowRevision']))
                logger.info('caller_turn_recorded turn_id=%s architecture=%s', turn['callerTurnId'], ARCHITECTURE)
                await self.note_wants_it_soon()
                return
            except (asyncio.TimeoutError, RuntimeHttpError, RuntimeContractError):
                logger.warning('caller_turn_failed attempt=%d', attempt + 1, exc_info=True)

    def on_user_state_changed(self, event):
        if event.new_state == 'speaking':
            self.idle_checkin_sent = False
            return
        if event.new_state != 'away' or self.idle_checkin_sent or self.terminal or self.ending_requested:
            return
        self.idle_checkin_sent = True
        self.track(self._idle_checkin())

    async def _idle_checkin(self):
        if self.holding and (wait := self.hold_until - time.monotonic()) > 0:
            # The caller asked for a moment: no nudge until it has passed, and then a patient one.
            await asyncio.sleep(wait)
            if self.session.user_state == 'away' and not (self.terminal or self.ending_requested):
                await self.say_exact(HOLD_OVER)
            return
        if self.session.user_state == 'away' and not (self.terminal or self.ending_requested):
            await self.say_exact('Still there?')

    def track(self, awaitable):
        job = asyncio.create_task(awaitable)
        self.tasks.add(job)
        def done(result):
            self.tasks.discard(result)
            if not result.cancelled() and result.exception():
                logger.warning('background_job_failed architecture=%s', ARCHITECTURE, exc_info=result.exception())
        job.add_done_callback(done)
        return job

    # Reads

    async def _read(self, call, business=True, tool='', query=''):
        if business and self.bob.mode not in BUSINESS_MODES:
            return 'That did not run: business knowledge is unavailable on this call.'
        try:
            result = await call
        except (RuntimeHttpError, RuntimeContractError):
            if business:
                logger.info('business_lookup tool=%s query=%s found=false status=failed', tool, _log_query(query))
            return 'The lookup failed, so you do not know. Say so plainly.'
        text = json.dumps(result)
        if business:
            # One line per lookup, so every claim on a call can be checked against what the business sources returned.
            found = isinstance(result, dict) and result.get('status', 'supported') == 'supported' and bool(
                result.get('facts') or result.get('services') or result.get('service'))
            logger.info('business_lookup tool=%s query=%s found=%s status=%s', tool, _log_query(query), str(found).lower(),
                        result.get('status', '-') if isinstance(result, dict) else '-')
            self.sourced_text += ' ' + text
            text = for_the_model(result)
        return text[:6000]

    async def lookup_business_fact(self, query):
        query = _text(query, 320)
        facts = await self._read(self.runtime.lookup_business_fact(query), tool='lookup_business_fact', query=query)
        # Tom's 2026-10-06 call, replayed: with no pricing fact, Blake said "Usually, estimates are done after seeing the
        # property in person". The rule rides on every lookup result, whichever tool path the model took to get here.
        return f'{facts}\n{FACTS_ONLY}'



    async def list_services(self):
        return await self._read(self.runtime.list_services(), tool='list_services')

    async def get_service_details(self, service_id):
        service_id = _text(service_id, 128)
        return await self._read(self.runtime.get_service_details(service_id), tool='get_service_details', query=service_id)

    async def service_area_state(self) -> str | None:
        """The one US state the business's address and service area name, looked up once per call. None when the
        knowledge names no state or several, or the lookup is slow or fails."""
        if self.bob.mode not in BUSINESS_MODES:
            return None
        if self._service_state is None:
            self._service_state = asyncio.ensure_future(self._find_service_state())
        try:
            return await asyncio.wait_for(asyncio.shield(self._service_state), 2)
        except Exception:
            return None

    async def _find_service_state(self) -> str | None:
        profile = json.dumps(self.bundle.get('profile') or {})
        try:
            found = json.dumps(await self.runtime.lookup_business_fact('location and service area'))
        except (RuntimeHttpError, RuntimeContractError):
            logger.warning('service_area_lookup_failed architecture=%s', ARCHITECTURE)
            found = ''
        state = service_area_state(profile + ' ' + found)
        logger.info('service_area_state found=%s architecture=%s', bool(state), ARCHITECTURE)
        return state

    async def lookup_frontline_fact(self, query):
        if self.bob.mode != 'frontline_qa':
            return 'That did not run: use the business knowledge tools on this call.'
        return await self._read(self.runtime.lookup_frontline_fact(_text(query, 320)), business=False)

    # Tasks

    def _command(self, action, **extra):
        task_id = (self.current_task or {}).get('taskId', '')
        # The same command in the same caller turn gets the same id, so a retried write is applied once.
        key = f"{action}:{task_id}:{json.dumps(extra, sort_keys=True)}"
        return {'action': action, 'taskId': task_id, 'callerTurnId': self.bob.caller_turn_id,
                'operationId': _operation_id(self.runtime.dispatch.demo_id, self.bob.caller_turn_id, key), **extra}

    async def _send(self, command):
        # An unknown outcome (timeout, dropped connection, server error) is retried once with the same operation id,
        # which the backend replays instead of applying twice. A definite rejection is not retried.
        try:
            response = await self.runtime.task(command)
        except RuntimeHttpError as exc:
            if exc.status < 500:
                raise
            response = await self.runtime.task(command)
        except RuntimeContractError:
            response = await self.runtime.task(command)
        self.workflow_revision = max(self.workflow_revision, int(response['workflowRevision']))
        self.current_task = response['task']
        if (receipt := self.current_task.get('receipt')):
            self.receipts[receipt.get('operationId', receipt.get('receiptId'))] = receipt
        return response

    def answers_a_check(self) -> bool:
        """True when the caller's turn is a plain yes or no to something other than Bob offering to pass a job along, such
        as "Yes, that's right." to "Is that D-A, V-I-E-N?"."""
        last_reply = self.replies[-1] if self.replies else ''
        return is_bare_answer(self.caller_texts[-1] if self.caller_texts else '') and not _OFFER_TO_PASS.search(last_reply)

    async def run_task(self, front_desk, kind, goal) -> str:
        if not self.bob.caller_turn_id:
            return "That did not run: the caller's words were not recorded yet. Next: ask them to say that once more."
        if (kind == 'service_request' and self.saved_request
                and (is_same_need(self.saved_request, goal) or self.answers_a_check())
                and not names_another_property([goal, *self.caller_texts[-2:]])):
            # The same job again is a change to the saved request, never a duplicate for the owner. So is a plain "yes" to
            # a read-back after the save, which once started a second request described by the property's name.
            logger.info('duplicate_request_as_change architecture=%s', ARCHITECTURE)
            return await self.run_change(front_desk, goal)
        if kind == 'appointment_lookup' and not asks_about_an_appointment(self.caller_texts):
            logger.warning('appointment_lookup_refused architecture=%s', ARCHITECTURE)
            return ("check_appointment did not run: the caller didn't ask to cancel or change an appointment. Next: reply to "
                    "what they just said.")
        if kind == 'service_request' and only_asks_if_we_help(self.caller_texts[-1] if self.caller_texts else ''):
            logger.warning('early_start_refused architecture=%s', ARCHITECTURE)
            return offer_first(self.spoken_this_turn)
        try:
            response = await self.start_task(kind, goal)
        except (RuntimeHttpError, RuntimeContractError):
            logger.warning('task_start_failed kind=%s', kind, exc_info=True)
            return result_line(kind, {}, self.closing_policy, self.business_name)
        logger.info('task_started task_id=%s kind=%s', response['task']['taskId'], kind)
        if kind in ('complaint', 'service_request') and self.saved_request:
            response = await self._carry_contact(response)
        chat_ctx = front_desk.chat_ctx.copy(exclude_function_call=True, exclude_handoff=True, exclude_instructions=True)
        try:
            task = await TASKS[kind](self, response['task'], chat_ctx)
        except RuntimeError:
            # LiveKit refuses to run the task when the speech that called it was already interrupted.
            logger.warning('task_interrupted kind=%s architecture=%s', kind, ARCHITECTURE, exc_info=True)
            return TASK_INTERRUPTED.format(tool=TASK_TOOLS[kind])
        logger.info('task_result kind=%s status=%s', kind, task.get('status'))
        if kind == 'service_request' and task.get('receipt'):
            self.saved_request, self.saved_turn_id = task, self.bob.caller_turn_id
        line = result_line(kind, task, self.closing_policy, self.business_name, said_urgent(self.replies),
                           open_for(self.bundle), open_for(self.bundle, 60))
        if (spelled := self.take_spelling()):
            return f'{line} But first: {spelled}'
        return line

    async def run_change(self, front_desk, change) -> str:
        """Reopens the request saved on this call so the caller can change or add a detail. The backend accepts changes to
        it until the call ends."""
        if not self.saved_request:
            return NO_SAVED_REQUEST
        if self.bob.caller_turn_id == self.saved_turn_id:
            # The turn that completed the request has nothing left to change; a change needs a later caller turn.
            logger.warning('change_refused reason=saved_this_turn architecture=%s', ARCHITECTURE)
            return SAVED_THIS_TURN
        self.current_task = self.saved_request
        logger.info('task_change task_id=%s', self.saved_request.get('taskId', ''))
        chat_ctx = front_desk.chat_ctx.copy(exclude_function_call=True, exclude_handoff=True, exclude_instructions=True)
        task = await TASKS['service_request'](self, self.saved_request, chat_ctx, editing=True)
        logger.info('task_change_result status=%s', task.get('status'))
        if task.get('status') == 'unchanged':
            return UNCHANGED
        if task.get('receipt'):
            self.saved_request = task
            return CHANGED
        return "That change didn't go through. Tell the caller you couldn't update it right now, then ask if there's anything else."

    async def ask_for_owner(self, intake=None) -> str:
        """The caller asked for the manager. The call goes on, and the request they are on, or the one already saved, gets a
        note so the manager calls them back. Returns what to tell the caller."""
        if not _ASKS_FOR_PERSON.search(self.caller_texts[-1] if self.caller_texts else ''):
            # The model sometimes reaches for this on a question the owner could answer; only the caller's own ask counts.
            logger.warning('owner_request_refused architecture=%s', ARCHITECTURE)
            return NO_PERSON_ASKED
        self.asked_for_owner = True
        logger.info('owner_requested intake=%s saved=%s', bool(intake), bool(self.saved_request))
        if intake is not None:
            target, parts = {'fields': intake.fields}, dict(intake.someone)
        elif self.saved_request:
            self.current_task = self.saved_request
            target, parts = self.saved_request, note_parts((self.saved_request.get('fields') or {}).get('notes', ''))
        else:
            return OWNER_NEEDS_CONTACT
        if not parts.get('owner'):
            try:
                response = await self.record({'notes': notes_text(parts | {'owner': 'yes'})})
            except (RuntimeHttpError, RuntimeContractError):
                logger.warning('owner_note_failed', exc_info=True)
                return OWNER_NEEDS_CONTACT if intake is None else OWNER_AWAY
            if intake is not None:
                intake.noted_owner(response['task'])
            elif response['task'].get('receipt'):
                self.saved_request = response['task']
        has_contact = (target.get('fields') or {}).get('contactPhone') or (target.get('fields') or {}).get('contactEmail')
        return OWNER_NOTED if intake is None and has_contact else OWNER_AWAY

    async def note_wants_it_soon(self) -> None:
        """A caller who says after the save that they need the work soon gets that noted on the saved request, before Bob
        replies, so his "I'll make sure the manager knows" is true. A request still being taken notes it on its next write."""
        if not self.saved_request or not wants_it_soon(self.caller_texts[-1:]):
            return
        if (self.current_task or {}).get('status') == 'running':
            # Another request is being taken; this write would point it at the saved one.
            return
        parts = note_parts((self.saved_request.get('fields') or {}).get('notes', ''))
        if parts.get('soon'):
            return
        self.current_task = self.saved_request
        try:
            response = await self.record({'notes': notes_text(parts | {'soon': 'yes'})})
        except (RuntimeHttpError, RuntimeContractError):
            logger.warning('soon_note_failed', exc_info=True)
            return
        if response['task'].get('receipt'):
            self.saved_request = response['task']
        logger.info('soon_noted architecture=%s', ARCHITECTURE)

    async def _carry_contact(self, response):
        """A complaint or a request for another property after a saved request starts with the name and the number the
        caller already confirmed on this call, so they are not asked for them again."""
        saved = (self.saved_request or {}).get('fields') or {}
        fields = {key: saved[key] for key in ('callerName', 'contactEmail') if saved.get(key)}
        if saved.get('contactPhone') and saved.get('phoneConfirmed'):
            fields.update(contactPhone=saved['contactPhone'], phoneConfirmed=True)
        if not fields:
            return response
        try:
            return await self.record(fields)
        except (RuntimeHttpError, RuntimeContractError):
            logger.warning('contact_carry_failed kind=complaint', exc_info=True)
            return response

    async def start_task(self, kind, goal):
        """Opens a task bound to the current caller turn. If one of this kind is already open, the backend returns it."""
        task_id = _operation_id(self.runtime.dispatch.demo_id, self.bob.caller_turn_id, 'task:' + kind)
        return await self._send({'action': 'start', 'taskId': task_id, 'kind': kind,
                                 'callerTurnId': self.bob.caller_turn_id, 'goal': _text(goal, 1000) or kind})

    async def record(self, fields):
        return await self._send(self._command('record', fields=fields))

    async def finish(self):
        return await self._send(self._command('finish'))

    async def cancel(self):
        return await self._send(self._command('cancel'))

    # Speech

    @property
    def has_receipt(self):
        return bool(self.receipts) or bool((self.current_task or {}).get('receipt'))

    async def guarded_llm_node(self, agent, chat_ctx, tools, model_settings):
        # A reply to a tool result is spoken a sentence at a time, as soon as each is written: that reply is almost always
        # text, and it is where callers waited longest. A reply to the caller is held to the end, because text written
        # next to a tool call is never spoken; the tool result leads to the real reply. Either way, a claim the
        # application has not confirmed is dropped before it reaches the caller or the transcript.
        last = chat_ctx.items[-1] if chat_ctx is not None and chat_ctx.items else None
        stream = getattr(last, 'type', None) == 'function_call_output'
        if getattr(last, 'type', None) == 'message' and getattr(last, 'role', None) == 'user':
            hold = hold_kind(getattr(last, 'text_content', '') or '')
            again = time.monotonic() < self.hold_until
            self.hold_until = time.monotonic() + HOLD_SECONDS if hold else 0.0
            # Tom's 2026-10-06 call: "Can you give me a second? I'm gonna go find the address" got "Take your time.
            # Meanwhile, could you please tell me the street...?". A turn that also says something else is still recorded,
            # but this reply asks nothing.
            self.holding = bool(hold)
            if hold == 'only':
                logger.info('caller_hold again=%s architecture=%s', again, ARCHITECTURE)
                yield HOLD_AGAIN if again else HOLD_REPLY
                return
            if hold:
                logger.info('caller_hold mixed=True architecture=%s', ARCHITECTURE)
        pending, spoken, has_tools, blocked, filler, asked = '', [], False, False, '', False
        repeat_offer, unsourced, closing, held_question = False, False, '', False

        def release(sentence: str) -> str:
            nonlocal blocked, filler, asked, repeat_offer, unsourced, closing, held_question
            # One question per reply: anything after the first question would ask the caller a second thing.
            if asked:
                return ''
            if self.holding and sentence.rstrip().endswith('?'):
                held_question = True
                return ''
            if _GET_IT_LATER.search(sentence) and not _DEFERS.search(self.caller_texts[-1] if self.caller_texts else ''):
                logger.info('later_claim_dropped architecture=%s', ARCHITECTURE)
                return ''
            if is_unconfirmed_claim(sentence, has_receipt=self.has_receipt,
                                    request_open=(self.current_task or {}).get('status') == 'running'):
                blocked = True
                return ''
            if self.offers_to_pass_again(sentence):
                repeat_offer = True
                return ''
            if is_closing_question(sentence) and self.skip_closing():
                # Held back, and spoken only if the reply would otherwise be empty.
                closing = closing or (sentence if not spoken else ' ')
                return ''
            if self.bob.mode in BUSINESS_MODES and unsourced_method(sentence, self.sourced_text):
                # A method no business source names is replaced, once, by the owner explaining their approach.
                if unsourced:
                    return ''
                unsourced, sentence = True, OWNER_EXPLAINS + ' '
            # Tom (2026-10-01): the person who follows up is "the manager", even when a business note says owner.
            sentence = _OWNER_WORD.sub(lambda m: f"{m.group(1)} {'Manager' if m.group(2)[0] == 'O' else 'manager'}{m.group(3) or ''}", sentence)
            if _NAMES_SERVICES.match(sentence) and said_urgent(spoken):
                logger.info('services_after_urgent_dropped architecture=%s', ARCHITECTURE)
                return ''
            if not spoken and is_spare_thanks(sentence, bool(self.thanks_heard)):
                return ''
            if not spoken and self.thanks_heard and not (sentence := strip_thanks_opener(sentence)):
                return ''
            if not spoken:
                # An opener such as "Absolutely." is held back and spoken only if nothing else follows it.
                if is_filler_only(sentence):
                    filler = filler or sentence
                    return ''
                sentence = strip_filler_opener(sentence)
            spoken.append(sentence)
            asked = sentence.rstrip().endswith('?')
            return sentence

        if (not stream and getattr(last, 'type', None) == 'message' and getattr(last, 'role', None) == 'user'
                and self.bob.mode in BUSINESS_MODES and asks_how_it_works(getattr(last, 'text_content', ''))
                and any(tool.info.name == 'lookup_business_fact' for tool in tools or [])):
            logger.info('lookup_first reason=how_it_works architecture=%s', ARCHITECTURE)
            model_settings = LOOKUP_FIRST
        can_start = (isinstance(agent, FrontDesk) and self.bob.mode in BUSINESS_MODES and not self.saved_request
                     and (self.current_task or {}).get('status') != 'running'
                     and any(tool.info.name == 'start_service_request' for tool in tools or [])
                     and not any(_COMPLAINT_OFFER.search(reply) for reply in self.recent_replies[-1:]))
        if (not stream and can_start and getattr(last, 'type', None) == 'message' and getattr(last, 'role', None) == 'user'
                and gives_contact(getattr(last, 'text_content', '') or '')):
            logger.info('contact_starts_request reason=caller_gave architecture=%s', ARCHITECTURE)
            chat_ctx = chat_ctx.copy()
            chat_ctx.add_message(role='system', content=CONTACT_STARTS)
            model_settings = START_REQUEST
        elif (not stream and isinstance(agent, FrontDesk) and getattr(last, 'type', None) == 'message'
                and getattr(last, 'role', None) == 'user' and (hint := self.turn_hint(last))):
            # For this reply only: the hint is not kept in the conversation.
            logger.info('turn_hint kind=%s architecture=%s', 'wrap_up' if hint.startswith('The caller is') else
                        'start' if hint == YES_START else 'spelling', ARCHITECTURE)
            chat_ctx = chat_ctx.copy()
            chat_ctx.add_message(role='system', content=hint)
            if hint == YES_START and any(tool.info.name == 'start_service_request' for tool in tools or []):
                logger.info('yes_starts_request architecture=%s', ARCHITECTURE)
                model_settings = START_REQUEST
        async for chunk in Agent.default.llm_node(agent, chat_ctx, tools, model_settings):
            if isinstance(chunk, str):
                text = chunk
            else:
                delta = getattr(chunk, 'delta', None)
                text = (delta.content or '') if delta else ''
                if delta:
                    has_tools = has_tools or bool(delta.tool_calls)
                    chunk = chunk.model_copy(update={'delta': delta.model_copy(update={'content': None})})
                yield chunk
            if has_tools:
                continue
            pending += text
            while stream and (end := SENTENCE_END.search(pending)):
                sentence, pending = pending[:end.end()], pending[end.end():]
                if (out := release(sentence)):
                    yield out
        if not stream and not has_tools and not self.ending_requested and self.goodbye_to_a_done_caller(pending):
            # The caller is done and the reply is only a goodbye: the application ends the call and says goodbye, as it
            # would after end_call, instead of leaving the line open after Bob's own goodbye. Once the call is ending,
            # the goodbye is that closing line and is spoken (2026-10-01: it was dropped and the call ended silently).
            logger.info('goodbye_ends_call architecture=%s', ARCHITECTURE)
            self.end_call('caller_ended')
            return
        if not stream and not has_tools and can_start and model_settings is not START_REQUEST and asks_contact(pending):
            # The reply asked for details itself. It is never spoken; the request starts and asks for them instead.
            logger.warning('contact_starts_request reason=reply_asked architecture=%s', ARCHITECTURE)
            chat_ctx = chat_ctx.copy()
            chat_ctx.add_message(role='system', content=CONTACT_STARTS)
            async for chunk in Agent.default.llm_node(agent, chat_ctx, tools, START_REQUEST):
                if not isinstance(chunk, str):
                    delta = getattr(chunk, 'delta', None)
                    yield chunk.model_copy(update={'delta': delta.model_copy(update={'content': None})}) if delta else chunk
            return
        if not has_tools:
            while (end := SENTENCE_END.search(pending)):
                sentence, pending = pending[:end.end()], pending[end.end():]
                if (out := release(sentence)):
                    yield out
            if pending.strip() and (out := release(pending)):
                yield out
        if blocked:
            logger.warning('claim_blocked architecture=%s', ARCHITECTURE)
        if repeat_offer:
            logger.warning('repeat_offer_dropped architecture=%s', ARCHITECTURE)
        if unsourced:
            logger.warning('method_claim_replaced architecture=%s', ARCHITECTURE)
        if closing and spoken:
            logger.info('closing_question_skipped architecture=%s', ARCHITECTURE)
        if not spoken and not has_tools and held_question:
            filler = HOLD_REPLY
        if not spoken and not has_tools and (blocked or filler or repeat_offer or closing.strip()):
            last = NO_REPLY_LEFT if blocked else filler.strip() or closing.strip() or ALREADY_WITH_OWNER
            spoken.append(last)
            yield last
        if spoken and not has_tools and not asked and not closing and (tail := self.check_in(''.join(spoken))):
            logger.info('check_in_added architecture=%s', ARCHITECTURE)
            spoken.append(' ' + tail if not spoken[-1].endswith(' ') else tail)
            yield spoken[-1]
        if not spoken:
            return
        reply = ''.join(spoken)
        self.spoken_this_turn += reply
        self.replies.append(reply)
        self.tts_characters += len(reply)
        logger.info('bob_reply_profile words=%d chars=%d questions=%d architecture=%s',
                    len(re.findall(r"\b[\w']+\b", reply)), len(reply), reply.count('?'), ARCHITECTURE)
        if self.tts_characters >= MAX_TTS_CHARACTERS and not self.terminal:
            logger.warning('voice_budget_exhausted spoken_chars=%d architecture=%s', self.tts_characters, ARCHITECTURE)
            self.track(self.escalate('provider_failure', ''))

    def asked_how_it_works(self) -> bool:
        return self.bob.mode in BUSINESS_MODES and asks_how_it_works(self.caller_texts[-1] if self.caller_texts else '')

    def said_yes_to_offer(self) -> bool:
        """True when the caller's latest words start with a yes to a question Bob asked, before any request is open."""
        if self.saved_request or (self.current_task or {}).get('status') == 'running' or not self.recent_replies:
            return False
        return self.recent_replies[-1].rstrip().endswith('?') and bool(_YES_FIRST.match(self.caller_texts[-1] if self.caller_texts else ''))

    def take_spelling(self) -> str:
        """The read-back instruction for what the caller just spelled, handed out once."""
        spelled, self.spelling = self.spelling, ''
        return spelled

    def turn_hint(self, last) -> str:
        """A one-turn instruction for a front-desk reply to the caller: read back a spelling, or wrap up warmly."""
        if (self.current_task or {}).get('status') == 'running':
            return ''
        if (spelled := self.take_spelling()):
            return spelled
        text = getattr(last, 'text_content', '') or ''
        offer = SENTENCE.findall(self.recent_replies[-1])[-1] if self.recent_replies else ''
        # A yes to passing a concern along is a complaint, not a service request (harness, 2026-10-04).
        if (self.bob.mode in BUSINESS_MODES and self.said_yes_to_offer() and _OFFERED.search(offer)
                and not _COMPLAINT_OFFER.search(offer)):
            return YES_START
        if self.wrapped_up_at:
            # One wrap-up per call: the next acknowledgement is a goodbye.
            return ''
        if acknowledges_only(text) and not caller_is_done(text) and (self.saved_request or self.has_receipt):
            self.wrapped_up_at = len(self.caller_texts)
            return WRAP_UP.format(follow_up=FOLLOW_UP_SOON if self.saved_request else '')
        return ''

    def on_item_added(self, event) -> None:
        """Keeps Bob's last three replies as the caller heard them. A reply the caller talked over before it played is not
        here, so a closing question in it does not count as asked."""
        item = getattr(event, 'item', None)
        if getattr(item, 'role', None) == 'assistant' and (text := getattr(item, 'text_content', None) or ''):
            self.recent_replies = (self.recent_replies + [text])[-3:]
            self.thanks_heard += len(THANKS.findall(text))

    def skip_closing(self) -> bool:
        """True when a closing question would cut the caller short or repeat one heard in the last three replies.
        Tom (2026-10-02): after answering something the caller asked, Blake checks in instead of going quiet, so the
        question is kept then even if one was asked recently."""
        last = self.caller_texts[-1] if self.caller_texts else ''
        if caller_mid_topic(last):
            return True
        if caller_asked(last) or adds_something(last):
            # Tom (2026-10-04): after the caller adds something, such as "ideally before eight AM", Blake went quiet.
            return False
        return any(is_closing_question(sentence) for reply in self.recent_replies for sentence in SENTENCE.findall(reply))

    def check_in(self, reply: str) -> str:
        """A check-in for an answer to the caller's question that ended without one, once no request is being taken.
        Tom's 2026-10-04 call: asked what to do in the meantime, Blake gave the tip and stopped, so the caller had to
        lead the call."""
        last = self.caller_texts[-1] if self.caller_texts else ''
        if (self.terminal or self.ending_requested or not caller_asked(last) or caller_mid_topic(last)
                or self.caller_is_finished() or (self.current_task or {}).get('status') == 'running' or _INVITES.search(reply)):
            return ''
        recent = ' '.join(self.recent_replies)
        return next((line for line in CHECK_INS if line not in recent), CHECK_INS[0])

    def goodbye_to_a_done_caller(self, reply: str) -> bool:
        """True when the caller said they are done and the reply is nothing but a goodbye."""
        return bool(reply.strip()) and '?' not in reply and bool(_GOODBYE.search(reply)) and self.caller_is_finished()

    def caller_is_finished(self) -> bool:
        """True when the caller's latest words end the call: a clear goodbye, or an "okay, thanks" after Bob's wrap-up."""
        last = self.caller_texts[-1] if self.caller_texts else ''
        return caller_is_done(last, receptionist_name(self.bundle)) or (0 < self.wrapped_up_at < len(self.caller_texts) and acknowledges_only(last))

    def offers_to_pass_again(self, sentence: str) -> bool:
        """True for an offer to pass something along once the request is already with the manager, unless it is about a
        concern, which is new information for a complaint."""
        if not self.saved_request or (self.current_task or {}).get('status') == 'running':
            return False
        if not sentence.rstrip().endswith('?') or not _OFFER_TO_PASS.search(sentence):
            return False
        # A concern goes to a complaint, and another job the caller just named is a new request: both are worth offering.
        recent = ' '.join(self.caller_texts[-2:])
        return not (_CONCERN.search(sentence) or _CONCERN.search(self.caller_texts[-1] if self.caller_texts else '')
                    or _ANOTHER_NEED.search(recent))

    async def paced_tts_node(self, agent, text, model_settings):
        meter = SpeechPacingMeter()
        self.pacing_sequence += 1
        sequence, complete, first_frame = self.pacing_sequence, False, True

        async def observed_text():
            async for part in text:
                meter.add_text(part)
                yield part
        try:
            async for frame in Agent.default.tts_node(agent, observed_text(), model_settings):
                if first_frame and self.turn_started_at is not None:
                    logger.info('voice_first_audio sequence=%d ms_since_caller_turn=%d', sequence,
                                (time.monotonic() - self.turn_started_at) * 1000)
                first_frame = False
                meter.add_audio(frame)
                yield frame
            complete = True
        finally:
            measured = meter.summary()
            if measured:
                logger.info('voice_pacing demo_id=%s sequence=%d source=tts_synthesis complete=%s words=%d audio_ms=%d effective_wpm=%.1f',
                            self.runtime.dispatch.demo_id, sequence, str(complete).lower(), measured.get('words', 0),
                            measured['audio_ms'], measured.get('effective_wpm', 0.0))

    async def speak(self, instructions, *, close=False, compose=False):
        # escalate() composes its goodbye through this; everything else is spoken by LiveKit's own reply flow.
        if close and not compose:
            return await self.say_exact(instructions, close=True)
        handle = self.session.generate_reply(instructions=_text(instructions, 4000), allow_interruptions=not close,
                                             tool_choice='none')
        await handle.wait_for_playout()
        return handle.exception() is None and not handle.interrupted

    # Ending

    def end_call(self, reason):
        if reason not in END_REASONS:
            raise RuntimeContractError('Unsupported ending reason')
        if reason == 'human_preference':
            # Nobody can be connected, so a request for a person becomes a note for the owner and the call goes on.
            logger.warning('end_call_refused reason=human_preference architecture=%s', ARCHITECTURE)
            return PERSON_KEEPS_CALL
        if reason == 'blocking_unknown' and not wont_go_on(self.caller_texts[-1] if self.caller_texts else ''):
            logger.warning('end_call_refused reason=blocking_unknown architecture=%s', ARCHITECTURE)
            return KEEP_GOING
        if reason == 'caller_ended' and not self.caller_is_finished():
            # A goodbye must come from the caller's own words, never from a forced or mistaken tool call.
            logger.warning('end_call_refused reason=caller_ended architecture=%s', ARCHITECTURE)
            return NOT_DONE
        if not self.ending_requested:
            self.ending_requested = True
            self.track(self.end_for_turn(reason))
        return ToolResult('The application is ending the call. Do not add a reply.', reply_required=False)

    async def end_for_turn(self, reason):
        if self.terminal:
            return
        for attempt in range(2):
            try:
                result = await self.runtime.task_end(self.bob.caller_turn_id, self.workflow_revision, self.state_revision, reason)
                self.workflow_revision = max(self.workflow_revision, int(result['workflowRevision']))
                self.state_revision = max(self.state_revision, int(result['stateRevision']))
                break
            except RuntimeHttpError as exc:
                if exc.workflow_revision: self.workflow_revision = max(self.workflow_revision, exc.workflow_revision)
                if exc.state_revision: self.state_revision = max(self.state_revision, exc.state_revision)
                if attempt or exc.code not in {'stale_workflow', 'stale_state', 'stale_task_end'}: break
            except RuntimeContractError:
                break
        await self.escalate(reason, self.turn_text)
