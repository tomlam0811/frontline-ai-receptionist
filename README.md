# Frontline

Frontline is an AI voice receptionist for appointment-based local service businesses (HVAC, cleaning, power washing and similar trades). A business owner enters their website. Frontline reads the site, builds a profile of the business's services, hours, service area and policies, and then lets the owner talk to a receptionist that answers callers' questions from that profile and takes down service requests.

## How it works

1. **Website research.** The API crawls the business's site with Exa search, splits pages into passages, and uses an OpenAI model to extract structured facts (services, hours, contact details, service area). Every fact keeps a link to the passage it came from, so the receptionist only states what the website supports.
2. **Voice call.** The browser joins a LiveKit room. A Python worker built on LiveKit Agents runs the call: streaming speech-to-text, GPT-4.1 mini for the conversation, and Cartesia Sonic-3 for the voice, with OpenAI text-to-speech as a fallback.
3. **Tools, not free text.** The model works through function-calling tools: look up a business fact, list services, start a service request, reschedule or cancel, report a complaint, ask for the owner, and end the call. Caller details (name, phone, address) are read back and confirmed before they are recorded.
4. **Owner view.** After a call, the owner sees a summary, the captured request, and a suggested next step, and can correct the receptionist's knowledge.

## Evaluation

- `workers/voice/bob_eval_fixtures.json` holds scripted call scenarios. The model's routing decisions (answer, take a request, hand off, end the call) are scored against expected outcomes.
- `workers/voice/test_v2_harness.py` runs full simulated calls against the real model when API keys are present. It is skipped otherwise.
- Unit tests cover phone and address parsing, name spelling, business hours, pacing, and the API's request lifecycle.

## Stack

| Part | Technology |
| --- | --- |
| Web app | React, TypeScript, Vite |
| API | Node.js, PostgreSQL |
| Voice worker | Python, LiveKit Agents, OpenAI (GPT-4.1 mini, realtime transcription), Cartesia |
| Research | Exa search, OpenAI structured extraction |
| Shared contracts | JSON schemas with generated JS and Python types (`contracts/v1`) |
| Deployment | Docker images for the API and voice worker, static web build |

## Repository layout

```
src/            React web app (landing page, call screen, owner views)
server/         Node API, research pipeline, LiveKit adapter
workers/voice/  Python voice agent, prompts, intake logic, evals
contracts/v1/   Shared request and response contracts
migrations/     PostgreSQL migrations
tests/          JavaScript tests (Vitest)
```

## Running locally

Requirements: Node 22, Python 3.12, PostgreSQL, and accounts for OpenAI, LiveKit, Cartesia and Exa.

```bash
npm install
npm run dev   # UI preview, no keys needed
```

For the full research and voice path, set the variables listed in `.env.example` in your shell, then run `npm run dev:server`.

Voice worker:

```bash
python3 -m venv .venv && .venv/bin/pip install -r workers/voice/requirements.txt
.venv/bin/python workers/voice/agent.py dev
```

Tests:

```bash
npm test
.venv/bin/python -m unittest discover -s workers/voice -p "test_*.py"
```

## Notes

This repository is a cleaned snapshot of a personal project built in 2026. Internal planning documents and deployment settings were removed, and example contact details are placeholders.
