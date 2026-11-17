"""Builds the street index Blake checks addresses against, from free US Census TIGER/Line address ranges.

Each line of the output is one city: {"city": "san jose", "streets": {"Senter Rd": [[low, high], ...]}}, where every pair is a
range of house numbers that exists on that street. Run from workers/voice to rebuild or add counties:
    python streets/build_index.py 06001 06013 ...    (state and county FIPS codes)
Downloads are cached in streets/.cache, which is not committed.
"""
from __future__ import annotations

import csv
import gzip
import io
import json
import re
import struct
import sys
import urllib.request
import zipfile
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
CACHE = HERE / '.cache'
YEAR = 2024
# The nine Bay Area counties: Alameda, Contra Costa, Marin, Napa, San Francisco, San Mateo, Santa Clara, Solano, Sonoma.
BAY_AREA = ['06001', '06013', '06041', '06055', '06075', '06081', '06085', '06095', '06097']
RELATIONSHIP = 'https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/tab20_zcta520_place20_natl.txt'


def fetch(url: str) -> bytes:
    CACHE.mkdir(exist_ok=True)
    path = CACHE / url.rsplit('/', 1)[1]
    if not path.exists():
        with urllib.request.urlopen(url, timeout=300) as response:
            path.write_bytes(response.read())
    return path.read_bytes()


def dbf_rows(data: bytes, wanted: tuple[str, ...]):
    """The wanted text fields of each record in a dBase file, so no shapefile library is needed."""
    count, header, record = struct.unpack('<xxxxIHH', data[:12])
    fields, offset = {}, 1
    for start in range(32, header - 1, 32):
        name = data[start:start + 11].split(b'\0')[0].decode()
        length = data[start + 16]
        fields[name] = (offset, length)
        offset += length
    for index in range(count):
        row = data[header + index * record: header + (index + 1) * record]
        if row[:1] == b'*':
            continue
        yield [row[fields[name][0]: fields[name][0] + fields[name][1]].decode('latin-1').strip() for name in wanted]


def zip_cities(state: str) -> dict[str, set[str]]:
    cities: dict[str, set[str]] = defaultdict(set)
    text = fetch(RELATIONSHIP).decode('utf-8-sig')
    for row in csv.DictReader(io.StringIO(text), delimiter='|'):
        if row['GEOID_ZCTA5_20'] and row['GEOID_PLACE_20'].startswith(state):
            cities[row['GEOID_ZCTA5_20']].add(re.sub(r'\s+(city|town|CDP)$', '', row['NAMELSAD_PLACE_20']).lower())
    return cities


def merged(ranges: list[list[int]]) -> list[list[int]]:
    out: list[list[int]] = []
    for low, high in sorted(ranges):
        if out and low <= out[-1][1] + 2:
            out[-1][1] = max(out[-1][1], high)
        else:
            out.append([low, high])
    return out


def build(counties: list[str]) -> dict[str, dict[str, list[list[int]]]]:
    by_zip = zip_cities(counties[0][:2])
    index: dict[str, dict[str, list[list[int]]]] = defaultdict(lambda: defaultdict(list))
    for county in counties:
        archive = zipfile.ZipFile(io.BytesIO(fetch(
            f'https://www2.census.gov/geo/tiger/TIGER{YEAR}/ADDRFEAT/tl_{YEAR}_{county}_addrfeat.zip')))
        dbf = archive.read(next(name for name in archive.namelist() if name.endswith('.dbf')))
        for name, *sides in dbf_rows(dbf, ('FULLNAME', 'LFROMHN', 'LTOHN', 'ZIPL', 'RFROMHN', 'RTOHN', 'ZIPR')):
            for low, high, code in (sides[:3], sides[3:]):
                if name and low.isdigit() and high.isdigit():
                    for city in by_zip.get(code, ()):
                        index[city][name].append(sorted((int(low), int(high))))
    return {city: {name: merged(ranges) for name, ranges in streets.items()} for city, streets in index.items()}


if __name__ == '__main__':
    counties = sys.argv[1:] or BAY_AREA
    index = build(counties)
    with gzip.open(HERE / 'bay_area.jsonl.gz', 'wt', encoding='utf-8') as out:
        for city in sorted(index):
            out.write(json.dumps({'city': city, 'streets': index[city]}, separators=(',', ':')) + '\n')
    print(f'{len(index)} cities from {len(counties)} counties')
