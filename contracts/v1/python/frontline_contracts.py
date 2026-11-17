"""Dependency-free runtime boundary validation; wire_types mirrors canonical schemas.

Use only server-loaded current state for authorization helpers. This module cannot
verify worker authentication, ownership, database atomicity or model semantics.
"""
import json
import math
import re
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse
if __package__:
    from .wire_types import *  # noqa: F403,F401 -- public generated wire types
else:
    from wire_types import *  # noqa: F403,F401 -- standalone worker/tests

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW_CONTRACT = json.loads((ROOT / 'workflows.json').read_text())
DEADLINES_SECONDS = WORKFLOW_CONTRACT['deadlinesSeconds']
WORKFLOW_IDS = tuple(item['id'] for item in WORKFLOW_CONTRACT['workflows'])
TOOLS = {item['id']: set(item['allowedTools']) for item in WORKFLOW_CONTRACT['workflows']}
SCHEMAS = {p.name: json.loads(p.read_text()) for p in (ROOT / 'schemas').glob('*.json')}

def resolve(reference, base='boundary.schema.json'):
    file, _, fragment = reference.partition('#')
    name = file.rsplit('/', 1)[-1] if file else base
    schema = SCHEMAS[name]
    for key in filter(None, fragment.split('/')):
        schema = schema[key.replace('~1', '/').replace('~0', '~')]
    return schema, name

def check(schema, value, file, path='$'):
    def fail(message): raise ValueError(f'{path}: {message}')
    if '$ref' in schema:
        target, name = resolve(schema['$ref'], file)
        check(target, value, name, path)
    for keyword in ('oneOf', 'anyOf'):
        if keyword not in schema: continue
        count = 0
        for branch in schema[keyword]:
            try:
                check(branch, value, file, path)
                count += 1
            except ValueError: pass
        if count == 0 or (keyword == 'oneOf' and count != 1): fail(keyword+' failed')
    def same(a, b): return type(a) is type(b) and a == b
    if 'const' in schema and not same(value, schema['const']): fail('invalid constant')
    if 'enum' in schema and not any(same(value, item) for item in schema['enum']): fail('invalid enum')
    actual = ('null' if value is None else 'boolean' if isinstance(value, bool) else 'number' if isinstance(value, (int,float)) else 'string' if isinstance(value,str) else 'array' if isinstance(value,list) else 'object' if isinstance(value,dict) else 'invalid')
    types = schema.get('type', [])
    if isinstance(types, str): types = [types]
    if types and not any(t == actual or (t == 'integer' and type(value) is int and abs(value) <= 9007199254740991) for t in types): fail('wrong type')
    if actual == 'number':
        if not math.isfinite(value) or value < schema.get('minimum', -math.inf) or value > schema.get('maximum', math.inf): fail('number out of range')
    if actual == 'string':
        if len(value) < schema.get('minLength', 0) or len(value) > schema.get('maxLength', math.inf): fail('string length')
        if 'pattern' in schema and not re.search(schema['pattern'], value): fail('pattern mismatch')
        if schema.get('format') == 'uuid' and not re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}', value, re.I): fail('invalid UUID')
        if schema.get('format') == 'date-time':
            if not re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)', value): fail('invalid timestamp')
            try: datetime.fromisoformat(value.replace('Z','+00:00'))
            except ValueError: fail('invalid timestamp')
        if schema.get('format') == 'uri' and not urlparse(value).scheme: fail('invalid URI')
    if actual == 'array':
        if len(value) < schema.get('minItems',0) or len(value) > schema.get('maxItems',math.inf): fail('array length')
        if schema.get('uniqueItems') and len({json.dumps(item,sort_keys=True) for item in value}) != len(value): fail('duplicate items')
        if 'items' in schema:
            for i,item in enumerate(value): check(schema['items'],item,file,f'{path}[{i}]')
    if actual == 'object':
        for key in schema.get('required',[]):
            if key not in value: fail(f'{key} is required')
        for key,item in value.items():
            if key in schema.get('properties',{}): check(schema['properties'][key],item,file,f'{path}.{key}')
            elif schema.get('additionalProperties') is False: fail(f'unknown property {key}')
            elif isinstance(schema.get('additionalProperties'),dict): check(schema['additionalProperties'],item,file,f'{path}.{key}')

def validate_contract(reference, value):
    schema, name = resolve(reference)
    check(schema, value, name)
    return value

def confirmation_authorizes_write(binding, current):
    try:
        validate_contract('confirmation.schema.json',binding)
        validate_contract('boundary.schema.json#/$defs/confirmationState',current)
    except ValueError: return False
    return (binding['dialogueAct'] == 'affirm' and current['latestCallerDialogueAct'] == 'affirm'
        and current['latestCallerClassificationStatus'] == 'classified'
        and binding['workflowInstanceId'] == current['workflowInstanceId']
        and binding['callerTurnId'] == current['latestCallerTurnId']
        and binding['callerTurnSequence'] == current['latestCallerTurnSequence']
        and binding['callerTurnSequence'] > current['readbackAfterCallerTurnSequence']
        and binding['fieldRevision'] == current['fieldRevision']
        and binding['readbackRevision'] == current['readbackRevision']
        and binding['readbackPayloadHash'] == current['readbackPayloadHash'])

def assert_session_mutable(session):
    try: validate_contract('boundary.schema.json#/$defs/sessionGuard',session)
    except ValueError as error: raise ValueError('terminal_session_immutable') from error
    return session

def validate_workflow_state(value):
    validate_contract('workflow.schema.json#/$defs/state', value)
    if not set(value['allowedToolIds']) <= TOOLS[value['workflowId']]: raise ValueError('Tool is not allowed for workflow')
    if value['phase'] in ('ending','terminal') and not set(value['allowedToolIds']) <= {'record_escalation','end_session'}: raise ValueError('Ending workflow cannot allow mutable intake tools')
    return value

def validate_profile_revision(value):
    validate_contract('profile-capability.schema.json',value)
    if len({item['workflowId'] for item in value['capabilities']}) != len(WORKFLOW_IDS): raise ValueError('Exactly one capability per workflow is required')
    for item in value['capabilities']:
        if not set(item['allowedToolIds']) <= TOOLS[item['workflowId']] or (not item['enabled'] and item['allowedToolIds']): raise ValueError('Tool is not allowed for workflow')
    return value

def validate_retrieval_result(value):
    validate_contract('boundary.schema.json#/$defs/retrievalResult',value)
    ids = {p['passageId'] for p in value['passages']}
    if value['status'] == 'supported':
        if not value['facts'] or any(f['eligibility'] != 'eligible' or not set(f['passageIds']) <= ids for f in value['facts']): raise ValueError('Unsupported retrieval evidence')
    elif value['facts']: raise ValueError('Unsupported retrieval evidence')
    return value
