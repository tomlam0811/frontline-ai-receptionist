"""What a good front desk asks in each trade, so Blake understands the caller's situation before passing a request on.

Tom, 2026-10-03, after his stepdad's test call to a plumber: Blake took "a leak" and asked nothing about it. A front desk
for plumbing, HVAC or auto repair asks what is happening, where, since when and how bad, and knows the signs of an urgent
job. The background lines help Blake understand the caller. They are never a diagnosis, a promise or a price.
"""
from __future__ import annotations

import re

from agent import spoken_business_name

TRADE_GUIDES = [
    {
        'trade': 'plumbing',
        'match': r'plumb|repipe|drain|sewer|water heater|rooter',
        'learn': 'what is happening, such as a leak, a clog, no hot water or a running toilet; where it is, such as the '
                 'kitchen, a bathroom or the yard; when they first noticed it; whether water is still running or spreading; '
                 'and whether they have been able to turn the water off',
        'urgent': 'water spreading or a burst pipe, sewage backing up, or no water at all',
        'danger': 'a gas smell near the water heater, or water reaching outlets or the electrical panel',
        'background': 'Leaks under sinks and around toilets are common and usually quick to fix. A water heater leaking '
                      'from the tank itself often means it needs replacing. Slow or backed-up drains are usually clogs.',
        'while_waiting': 'if it is safe to reach, turning off the small valve under the sink or toilet, or the main water '
                         'shutoff, stops the water until someone gets there',
        'tip_said': r"\bvalve\b|\bshut ?off\b|\b(?:turn|shut)(?:ing)? (?:off )?(?:the|your) water\b",
    },
    {
        'trade': 'heating and air conditioning',
        'match': r'hvac|heating|air condition|\bac\b|furnace|heat pump|cooling|mini.?split',
        'learn': 'what is happening, such as no heat, no cooling, a strange noise, a smell or water dripping; what kind of '
                 'system they have, such as a furnace, a central AC or a heat pump; when it started; and whether the '
                 'thermostat shows anything unusual',
        'urgent': 'no heat in freezing weather, or no cooling in extreme heat, above all with babies, older people or '
                  'anyone unwell in the home',
        'danger': 'a gas smell, a burning smell, smoke, or a carbon monoxide alarm going off',
        'background': 'Systems that stop working often have a tripped breaker, a dirty filter or a failed part. Ice on the '
                      'AC lines or water around the indoor unit usually means it needs service soon.',
        'while_waiting': 'if the indoor unit is iced up or dripping water, switching the system off can prevent more damage',
        'tip_said': r"\b(?:switch|turn|shut)(?:ing)?\b[^.?!]{0,30}\boff\b",
    },
    {
        'trade': 'auto repair',
        'match': r'auto|car\b|cars\b|vehicle|mechanic|brake|transmission|tire|smog|oil change|collision',
        'learn': "the car's year, make and model; what is happening, such as a noise, a warning light, a leak or it won't "
                 'start; when it happens, such as when braking, turning or starting; when it began; and whether the car '
                 'can still be driven or needs a tow',
        'urgent': 'brakes that feel wrong, a car that will not start, or a car they need for work right away',
        'danger': 'smoke or flames, a strong fuel smell, or brakes that stopped working while driving',
        'background': 'A squeal when braking often means worn brake pads. A blinking check engine light is more serious '
                      'than a steady one. Fluid under the car can be oil, coolant or transmission fluid.',
        'while_waiting': 'if the brakes feel wrong or a warning light is flashing, it is safest not to drive the car',
        'tip_said': r"\b(?:not|n't|avoid|stop) (?:to )?driv",
    },
    {
        'trade': 'exterior cleaning',
        'match': r'pressure wash|power wash|steam clean|soft wash|window wash|gutter',
        'learn': 'what needs cleaning, such as a driveway, a storefront walkway, a dumpster area or a building; whether it '
                 'is a home or a business; roughly how big the area is; and what is on it, such as oil, gum, graffiti or '
                 'grime',
        'urgent': 'an upcoming inspection, an event or a tenant complaint they need handled soon',
        'danger': '',
        'background': 'Oil and gum need hot water and take longer than general grime. Businesses usually want the work '
                      'done early in the morning or after closing, so customers are not disturbed.',
    },
]

GENERAL_GUIDE = {
    'trade': 'home and property services',
    'learn': 'what is going on or what they want done, where it is, when it started or when they need it, and how big '
             'the job is',
    'urgent': 'damage that is getting worse, or something unsafe to leave',
    'danger': 'fire, smoke, a gas smell, sparking or someone hurt',
    'background': '',
}


def _business_words(bundle: dict) -> str:
    profile = bundle.get('profile') or {}
    services = ' '.join(str(service.get('name', '')) for service in profile.get('services') or [] if isinstance(service, dict))
    return ' '.join([str(bundle.get('businessType') or ''), spoken_business_name(bundle) or '', services]).lower()


def trade_guide(bundle: dict) -> dict:
    """The guide whose trade the business's type, name or services name, or the general one."""
    words = _business_words(bundle)
    return next((guide for guide in TRADE_GUIDES if re.search(guide['match'], words)), GENERAL_GUIDE)


def tip_given(guide: dict, replies: list[str]) -> bool:
    """True when Blake already gave the guide's tip for while they wait, such as turning off the valve under the sink."""
    return bool(guide.get('tip_said')) and any(re.search(guide['tip_said'], reply, re.I) for reply in replies)


def situation_block(bundle: dict) -> str:
    guide = trade_guide(bundle)
    lines = [f"## Understanding the caller's situation ({guide['trade']})",
             # Tom's 2026-10-06 call: with five things listed and no limit here, Blake asked a third and fourth question
             # (one-time or regular) instead of offering, though the job rules allow two.
             f"Things the manager will want to know, of which you ask at most two, only what they haven't said; the manager "
             f"asks the rest: {guide['learn']}.",
             f"Urgent signs: {guide['urgent']}."]
    if guide['danger']:
        lines.append(f"Immediate danger: {guide['danger']}. That is a safety emergency.")
    if guide.get('while_waiting'):
        lines.append(f"While they wait: when it fits what they described, the problem is still happening and they "
                     f"haven't done this, suggest it once, "
                     f"briefly: {guide['while_waiting']}. Suggest nothing else to fix or check.")
    if guide['background']:
        lines.append(f"Background, only to help you understand the caller and ask good questions, never to tell them "
                     f"what's wrong or what it costs. Don't say you're unsure about the cause; just ask your question: {guide['background']}")
    return '\n'.join(lines)
