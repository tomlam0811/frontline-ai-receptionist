"""Checks a street address the caller gave against the streets that really exist in their city.

Tom's recordings (2026-10-05) showed every transcriber hears unusual street names as common words: Senter Road as
"Center Road", Blacow Road as "Blockhouse Road". The house number and city usually come through, so the streets in that
city whose house numbers include it are few, and the one that sounds most like what was heard is usually the right one.
With GOOGLE_MAP_API set, Google's Address Validation API checks the street first (5,000 free lookups a month).
Without it, or when Google can't confirm the street, the free Census address ranges in streets/bay_area.jsonl.gz decide
(see streets/build_index.py). Outside those counties, or for a place without a house number, nothing is checked.
"""
from __future__ import annotations

import gzip
import json
import logging
import os
import re
import urllib.request
from dataclasses import dataclass
from difflib import SequenceMatcher
from functools import lru_cache
from pathlib import Path

import jellyfish

logger = logging.getLogger('frontline.voice')

INDEX = Path(__file__).resolve().parent / 'streets' / 'bay_area.jsonl.gz'
GOOGLE_URL = 'https://addressvalidation.googleapis.com/v1:validateAddress'
# Below this, the closest real street sounds too little like what was heard to offer it.
SUGGEST_AT = 0.65
# A street that has the house number and sounds nearly the same outranks a same-named street that lacks the number.
SURE_AT = 0.9

_TYPES = {'avenue': 'ave', 'av': 'ave', 'road': 'rd', 'boulevard': 'blvd', 'parkway': 'pkwy', 'drive': 'dr', 'street': 'st',
          'lane': 'ln', 'court': 'ct', 'way': 'way', 'expressway': 'expy', 'place': 'pl', 'circle': 'cir', 'terrace': 'ter',
          'highway': 'hwy', 'square': 'sq', 'loop': 'loop', 'trail': 'trl', 'commons': 'cmns', 'plaza': 'plz'}
_SAID_TYPES = {'ave': 'Avenue', 'rd': 'Road', 'blvd': 'Boulevard', 'pkwy': 'Parkway', 'dr': 'Drive', 'st': 'Street',
               'ln': 'Lane', 'ct': 'Court', 'way': 'Way', 'expy': 'Expressway', 'pl': 'Place', 'cir': 'Circle',
               'ter': 'Terrace', 'hwy': 'Highway', 'sq': 'Square', 'loop': 'Loop', 'trl': 'Trail', 'cmns': 'Commons',
               'plz': 'Plaza'}
_DIRECTIONS = {'north': 'n', 'south': 's', 'east': 'e', 'west': 'w'}
_SAID_DIRECTIONS = {'n': 'North', 's': 'South', 'e': 'East', 'w': 'West'}
# "2201 Senter Road Suite 200": the unit after the street is kept as the caller said it.
# Tom's 2026-10-06 call: Google confirmed "5150 E Coast Highway" in Long Beach as "East California 1", the route number for
# Pacific Coast Highway, and Blake read that back. A route number is never offered as the street unless the caller said one.
_ROUTE_NUMBER = re.compile(r'^(?:(?:north|south|east|west|[nsew])\s+)?(?:california|ca|state route|sr|route|us|u\.s\.|'
                           r'interstate|i|highway|hwy)[\s-]*\d+\b', re.I)
_PLACE = re.compile(r'^\s*(?P<number>\d{1,6})\s+(?P<street>.+?)(?P<unit>[\s,]+(?:suite|ste|apt|apartment|unit|building|bldg|floor|#).*)?\s*$',
                    re.I)


@dataclass(frozen=True)
class AddressCheck:
    """`match`: the street exists in the city as heard. `suggest`: the heard street does not, and `address` is the real
    street with that house number that sounds most like it. `unchecked`: no house number, or no street data there."""
    verdict: str
    address: str = ''
    source: str = 'census'


def _words(name: str) -> list[str]:
    words = [word for word in re.findall(r"[a-z0-9]+", name.lower().replace("'", ''))]
    if words and words[0] in _DIRECTIONS:
        words[0] = _DIRECTIONS[words[0]]
    if words and words[-1] in _TYPES:
        words[-1] = _TYPES[words[-1]]
    return words


def _base(name: str) -> tuple[str, str]:
    """The street's name without its type, and the type, such as ("senter", "rd")."""
    words = _words(name)
    kind = words[-1] if words and words[-1] in _SAID_TYPES else ''
    return ' '.join(words[:-1] if kind else words), kind


def _sounds_like(heard: str, real: str) -> float:
    heard, real = heard.replace(' ', ''), real.replace(' ', '')
    return (SequenceMatcher(None, heard, real).ratio()
            + SequenceMatcher(None, jellyfish.metaphone(heard), jellyfish.metaphone(real)).ratio()) / 2


def said_street(name: str) -> str:
    """A Census street name the way a person says it: "W Taylor St" is "West Taylor Street"."""
    words = name.split()
    if len(words) > 1 and words[0].lower() in _SAID_DIRECTIONS:
        words[0] = _SAID_DIRECTIONS[words[0].lower()]
    if len(words) > 1 and words[-1].lower() in _SAID_TYPES:
        words[-1] = _SAID_TYPES[words[-1].lower()]
    return ' '.join(words)


@lru_cache(maxsize=32)
def city_streets(city: str) -> dict[str, list[list[int]]]:
    """Every street in the city with its ranges of house numbers, read from the index only for the city asked about."""
    prefix = json.dumps({'city': city.strip().lower()}, separators=(',', ':'))[:-1] + ','
    try:
        with gzip.open(INDEX, 'rt', encoding='utf-8') as lines:
            for line in lines:
                if line.startswith(prefix):
                    return json.loads(line)['streets']
    except OSError:
        pass
    return {}


def check_address(place: str, city: str) -> AddressCheck:
    """Checks "2201 Center Road" in San Jose: the street that exists with that number is "2201 Senter Road"."""
    parts = _PLACE.match(place or '')
    streets = city_streets(city) if parts and city else {}
    if not streets:
        return AddressCheck('unchecked')
    number, unit = int(parts['number']), parts['unit'] or ''
    heard, heard_kind = _base(parts['street'])
    if not heard:
        return AddressCheck('unchecked')
    best, best_score, same_name = '', 0.0, ''
    for name, ranges in streets.items():
        base, kind = _base(name)
        has_number = any(low <= number <= high for low, high in ranges)
        if base == heard and (not heard_kind or kind == heard_kind):
            if has_number:
                return AddressCheck('match', f'{number} {said_street(name)}{unit}')
            same_name = name
            continue
        if not has_number:
            continue
        score = _sounds_like(heard, base) + (0.1 if heard_kind and kind == heard_kind else 0)
        if score > best_score:
            best, best_score = name, score
    if same_name and best_score < SURE_AT:
        # The street exists as heard but its ranges lack the number. The Census ranges miss some real house numbers
        # (1250 Mowry Avenue), so it stands unless a street that has the number sounds nearly the same ("Center Road"
        # is in San Jose too, but 2201 is on Senter Road).
        return AddressCheck('match', f'{number} {said_street(same_name)}{unit}')
    if best and best_score >= SUGGEST_AT:
        return AddressCheck('suggest', f'{number} {said_street(best)}{unit}')
    return AddressCheck('unchecked')


_ONES = 'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen'.split()
_TENS = 'twenty thirty forty fifty sixty seventy eighty ninety'.split()


def _pair(digits: str) -> str:
    """Two digits the way they are said in an address: "01" is "oh one", "50" is "fifty"."""
    value = int(digits)
    if digits[0] == '0':
        return f'oh {_ONES[value]}'
    if value < 20:
        return _ONES[value]
    return _TENS[value // 10 - 2] + ('' if value % 10 == 0 else f'-{_ONES[value % 10]}')


def spoken_house_number(number: str) -> str:
    """A house number the way people say it: 2201 is "twenty-two oh one", 41039 is "forty-one oh thirty-nine"."""
    if not number.isdigit():
        return number
    if len(number) <= 2:
        return _pair(number) if len(number) == 2 else _ONES[int(number)]
    if len(number) == 3:
        return f'{_ONES[int(number[0])]} {"hundred" if number[1:] == "00" else _pair(number[1:])}'
    if len(number) == 4:
        return f'{_pair(number[:2])} {"hundred" if number[2:] == "00" else _pair(number[2:])}'
    if len(number) == 5:
        rest = number[2:]
        return f'{_pair(number[:2])} ' + (f'oh {_pair(rest[1:])}' if rest[0] == '0' else spoken_house_number(rest))
    return ' '.join(_ONES[int(digit)] for digit in number)


def spoken_address(address: str, city: str) -> str:
    number, _, rest = address.partition(' ')
    return f'{spoken_house_number(number)} {rest}, {city}'


def _validate_with_google(body: dict, key: str) -> dict:
    request = urllib.request.Request(GOOGLE_URL, data=json.dumps(body).encode(), method='POST',
                                     headers={'Content-Type': 'application/json', 'X-Goog-Api-Key': key})
    with urllib.request.urlopen(request, timeout=4) as response:
        return json.load(response)


def google_check(place: str, city: str, state: str, key: str) -> AddressCheck | None:
    """Google's answer for the street, or None when it can't vouch for one, so the Census check decides instead."""
    parts = _PLACE.match(place or '')
    if not parts or not city:
        return None
    body = {'address': {'regionCode': 'US', 'addressLines': [f"{parts['number']} {parts['street']}"], 'locality': city,
                        **({'administrativeArea': state} if state else {})}}
    components = {item.get('componentType'): item for item in
                  (_validate_with_google(body, key).get('result') or {}).get('address', {}).get('addressComponents', [])}
    route, number = components.get('route'), components.get('street_number')
    if (not route or route.get('inferred') or route.get('confirmationLevel') != 'CONFIRMED'
            or (number and number.get('componentName', {}).get('text') != parts['number'])):
        # Only a street Google confirms with that house number counts. On Tom's recordings every misheard street
        # ("Blockhouse Road", "Tooley Road") came back UNCONFIRMED_BUT_PLAUSIBLE, so those go to the Census check.
        return None
    street = route['componentName']['text']
    if _ROUTE_NUMBER.match(street) and not re.search(r'\d', parts['street']):
        return None
    # Google swaps "Center Road" for "Senter Road" without always flagging it, so any other street name is read back.
    corrected = _base(street) != _base(parts['street'])
    return AddressCheck('suggest' if corrected else 'match', f"{parts['number']} {street}{parts['unit'] or ''}", 'google')


def validate_address(place: str, city: str, state: str = '') -> AddressCheck:
    """Google first when a key is set, then the free Census street ranges."""
    if key := os.environ.get('GOOGLE_MAP_API', '').strip():
        try:
            if found := google_check(place, city, state, key):
                return found
        except Exception as error:
            logger.warning('google_address_failed error=%s', type(error).__name__)
    return check_address(place, city)
