# Frontline design system

## Experience principle

Frontline is **human-centered operational intelligence**: a calm customer-care surface where work, source boundaries, and the next safe action are clearer than the technology underneath. The system uses crisp white and bone-neutral operational layers, restrained pine green, warm dark-neutral type, selective depth, and state-driven motion. It does not use AI spectacle, glowing orbs, false activity, abstract gradients, or “growth at all costs” visual language.

Every product state answers three questions in order:

1. **Where am I?** A plain-language heading and a stable journey cue.
2. **What is Frontline doing?** A truthful state, including uncertainty and simulation boundaries.
3. **What can I safely do next?** One primary action, with recovery beside it when needed.

The public landing page introduces the customer-care promise. The connected preview progressively earns trust: public website → preparation → private conversation → actual captured result → exact-agent save → owner-controlled activation → focused home.

## Visual foundation

### Color roles

Confirmed by Tom on 2026-09-28 in the brand identity review. Pine is the one anchor color; coral and amber were both proposed and explicitly rejected. `--pine-soft` and `--ink-soft`/`--line`/`--mint` are functional tints derived from the three anchor colors for real UI needs (selection, secondary text, borders, quiet panels) — not separate brand-identity decisions of their own. The canvas was revised the same day after seeing it applied to real screens: the warm cream read as ugly in the actual product, so the page background moved to a bone-neutral gray, keeping pine as the only strong color.

| Role | Token | Value | Use |
| --- | --- | --- | --- |
| Primary action, brand, links | `--pine` | `#1F4D3A` | Primary buttons, links, labels, selected controls, strong product status |
| Selected surface | `--pine-soft` | `#DCE7E0` | Bounded selection and agent identity |
| Quiet surface | `--mint` | `#EDF4F1` | Supporting panels and notices |
| Canvas | `--canvas` | `#F6F4F1` | Page background |
| Surface | `--white` | `#FFFFFF` | Cards and form fields |
| Primary text | `--ink` | `#2A2119` | Headings and body copy |
| Secondary text | `--ink-soft` | `#6B6259` | Explanations and metadata |
| Border | `--line` | `#E2DCD3` | Dividers and boundaries |
| Danger | `--danger` | `#A23A32` | Errors plus icon and label |
| Warning | `--warning` | `#795B14` | Partial/limited state plus text |

Color never carries status alone. A label, symbol, and explanatory sentence accompany every warning, error, online, paused, and progress treatment. Pine is an action signal rather than a generic page wash. There is deliberately no separate decorative “AI color.”

### Typography

Confirmed by Tom on 2026-09-28 in the same brand-identity definition page. Four roles, one typeface family doing most of the work:

- **Inter, Bold, 24px** — Display: real page-title size (not a marketing-page hero size).
- **Inter, Semibold, 18px** — Heading: section headings.
- **Inter, Regular, 16px** — Body: default paragraph size, UI labels, forms, transcript, tabular operational details.
- **Fraunces, Italic Medium, 23px** — Voice/Accent: reserved for mood language and direct quotes, used sparingly, never for structural UI.
- **IBM Plex Mono, Semibold, 13px** — Label: structural labels and operational meta-text (call status, timers).
- System fallbacks remain usable if web fonts do not load. The implementation should self-host fonts before production; the review build uses a remote font request as a reversible prototype assumption.
- Headings use tight line height (1.02–1.15) and modest negative tracking. Body text uses 1.5–1.65 line height and avoids widths above 70 characters.

### Space, shape, and depth

- Base spacing increments are 4, 8, 12, 16, 20, 24, 32, 40, 56, and 72px.
- Controls use 9–10px radii. Operational cards use 12–18px radii. No pill is used as a container substitute.
- Shadows are rare and mark a focused task or sticky save surface, never every card.
- Desktop content maxes out at 1120px; focused forms max out at 790px.

## Components

**Owner top bar.** Signed-in owner screens show the Frontline mark (link to Home), Home and Knowledge, and an account menu on the right (a rounded square with a person icon, opening two items: "Account", a link to a small Account page with the first name and Sign out, and "Sign out" in the danger color). No Settings item. On phones (640px and below) Home, Knowledge and the account section move behind one hamburger menu button. Guest screens show the mark only.

**Owner page headings.** Page `h1` is 28px on desktop and 24px on phones. The line under it is one plain description (15px regular, muted), never an instruction; an instruction is shown as a small tip with an icon. Section headings stay 18 to 20px semibold, so a description always reads lighter than a section heading.

**Overflow menu and dialogs for secondary actions.** A three-dot button opens a short list of secondary actions (Share and Give feedback on the receptionist page). Actions that need a moment of focus, such as Share, open a small dialog instead of a page.

**Top bar (onboarding preview).** Persistent brand exit, explicit “Interactive product preview / Simulation” label, and a dark Review mode trigger. Review mode is visually separate from product controls and announced as reviewer-only.

**Buttons.** Pine primary for the one recommended next action; white bordered secondary for reversible alternatives; text buttons for tertiary navigation. In the signed-in owner app buttons are compact: 40px high with 14px text, and 36px for the small variant used inside cards. Text buttons and links keep a 44px hit area through padding. Focus is a 3px translucent pine outline, and disabled state remains legible. Links carry no underline; color and weight mark them.

**Inputs.** Visible labels always precede fields. Errors sit directly below their field and preserve the entered value. Inputs use 16px mobile-friendly padding and never rely on placeholder text as a label.

**Notice.** Icon + short title + corrective sentence. Informational, warning, and error variants use form, words, and bounded color together.

**State cards.** A state icon anchors a direct heading and concrete explanation. Progress avoids fake percentages. Skeleton lines indicate activity only while work is represented as pending.

**Save bar.** Sticky on wide screens, in flow on small screens. It names unsaved/saved state and keeps the next action near the edit context.

**Transcript and results.** Speaker names remain visible; captions are on by default. The result shows the actual simulated facts captured and missing fields rather than generic counts. Simulation disclosure is adjacent, not buried in legal copy.

## Motion

Motion reveals causality. The microphone meter, listening surface, and factual preparation lines may animate with opacity or transform only. Transitions are 120–220ms. No parallax, scroll-jacking, looping ambient backgrounds, or attention-seeking bounce is permitted. `prefers-reduced-motion: reduce` removes all animation and smooth scrolling without hiding state. The one loading spinner is the exception: it slows to a turn every 2.6 seconds so a wait still reads as a wait.

## Responsive behavior

- At 900px, two-column voice, result, setup, and home layouts become single-column; headings align left and sticky save controls enter normal flow.
- At 520px, cards tighten, actions become full width, and the wordmark contracts to its recognizable initial.
- Review mode becomes a full-width overlay below the top bar on narrow screens.
- Product controls never require hover. Touch targets are at least 44px and consequential actions remain reachable without horizontal scrolling.

## Accessibility contract

- Semantic headings follow page order; forms use explicit labels; field errors use `aria-invalid`; asynchronous notices use `status`, and failures use `alert`.
- Keyboard focus is always visible. A skip link targets the product content. Review mode exposes `aria-expanded` and an explicit close control.
- Text and controls target WCAG AA contrast. Secondary text is reserved for non-essential information at readable sizes.
- Captions default on. Voice states have text equivalents. Microphone denial and unsupported browsers retain a text-preview route.
- Reduced motion preserves useful state communication through static labels and highlights.

## Journey and state inventory

Matches the approved screen list in the journey design as of 2026-09-28. Retired IDs are kept, struck through, so a missing number reads as a decision rather than an omission.

| Screen | Purpose | Required states represented in review implementation |
| --- | --- | --- |
| S1 | Landing CTA and website-first intake | Empty, validation error, back with preserved context, no-website fallback, ambiguous identity confirmation |
| S2 | Truthful preparation | Thank-you plus cycling plain-language status, partial crawl, total error, resumed session |
| S3 | Generated agent preview | Complete ready state; no classification, workflow, or fact-count diagnostics before the demo |
| ~~S4~~ | **Not a distinct screen.** The browser's own native permission prompt handles microphone access; no custom states. | — |
| S5 | Live voice demo and close | Listening, thinking, speaking, reconnecting, honest uncertainty, spoken close (folds the former S6) |
| ~~S6~~ | **Not a distinct screen.** Folded into S5 as its spoken close. | — |
| S7 | Call result and feedback | Complete, incomplete, ended early, optional feedback submitted |
| S8 | Sign up (Google only) | Popup, redirect, saving, claim conflict, expired |
| ~~S9~~ | **Removed from this pass.** No use-case confirmation, capability review, or phone provisioning; a later pass designs activation. | — |
| ~~S11~~ / ~~S12~~ | **Not distinct screens.** Google supplies the owner's name at S8. | — |
| S13 | Additional business info | Empty, dictating, text entered, URL entered, file uploaded, skipped |
| ~~S14~~ | **Never assigned in this pass.** | — |
| S10 | Receptionist home | Active, draft, paused, changed since last test |
| S15 | Receptionist detail | Renaming, sources loading, link active, link revoked, link limit reached |

## Content and behavioral rules

Copy follows the specimens in the Writing section of the brand identity guide and the Writing rules in this file.

- Voice is that of an experienced service coordinator: warm, direct, and specific. It never guesses to preserve conversational flow.
- “Receptionist,” “preview,” and “request” are preferred to anthropomorphic or workforce-replacement language. Owner-facing text does not use “agent”.
- No interface may imply a customer request was sent, a booking completed, a technician dispatched, or a number activated until the corresponding real service confirms it.
- Before activation, every phone number or customer record must be clearly sample or masked data.
- Owner configuration remains editable, and recovery keeps all valid prior work.

### Writing

These rules replace any older "agent" wording in this file.

- Vocabulary: the product is the "AI receptionist" (short label "Receptionist"). Owners can name it after onboarding; the default name is Blake. Screens use the chosen name, or "your receptionist" when no name fits. Stored information is "Knowledge". Owner notes to the team are "Feedback". Calls use the approved journey's labels (Voice demo, Call result). One name per thing.
- Avoid in owner-facing text: agent, assistant, front desk, workspace, provisioning, inbound number, business context, resource, API, HTTPS, job, revision, version, scope, workflow, handoff, capture, grounded, compile, source of truth.
- Labels are plain nouns. Buttons are a verb plus the thing ("Remove website").
- People scan in an F shape and read less as they go down and across. Front-load: sentences start with the word that matters, not "you" or "your". The biggest or boldest text comes first, and small text can be skipped without losing the point.
- Read-aloud test: read the screen in order of visual weight (title, centre, bold, small) as if describing it to a colleague. It has to make sense.
- Coffee test: would it be said to a friend over coffee?
- Delete-the-first-line test: if the screen still works without the first line, delete it.
- Errors: say what happened in plain words, then what to do next. Mention kept input only when the owner typed into a form that is still on screen ("The text is still in the box."), never as reassurance. No codes, no blame, no jokes.
- Removing: say it is removed. Say nothing about timing, jobs, backups or "everywhere".
- Describe the product by its job: it answers customers' calls and questions when the owner can't, and passes along what the owner needs to know. Never write a sentence that only defines AI or assumes owners know what an AI receptionist is.
- AI disclosure: say "AI receptionist" once, plainly, where the owner first meets it, together with the job.
- Promises: never claim what did not happen. No "booked", "sent", "verified" or "every call". Say only what actually happens, for example "Sent to the team."
- No contrast constructions in copy ("X, not Y", "more than just X"). Say what the thing is.
- Energy: lively on the landing page and in the receptionist's spoken voice on calls. Calm everywhere else, with at most one warm line on a first success.
- Everyday words, contractions, short sentences. Reading grade 6 to 8 is a guardrail. Test with real owners.

## Decisions and rejected alternatives

Pine, warm ink, and warm cream were selected because they support calm action hierarchy and customer-care trust while keeping semantic colors functional. Orange, violet, copper/evergreen, beige, sand, coral, and amber directions are all rejected — coral and amber were proposed as part of this same 2026-09-28 pass and explicitly turned down by Tom, not carried forward as secondary accents. Crisp operational layers beat heavy documentary layouts because product proof stays primary; sparse service imagery can add context on the landing page. Quiet functional motion beats cinematic motion because users should never wait for decoration. A focused workspace beats a generic sidebar dashboard because S10 should prioritize the agent state, requests needing attention, and one next improvement.

These choices advance the vision by making Frontline feel accountable before it feels clever: the interface identifies unknowns, protects continuity, and keeps a human owner in control.
