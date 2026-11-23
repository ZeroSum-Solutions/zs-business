# OS1 study: the reference for the business companion

Ticket: ZSB-82. Studied 2026-11-22 for Devin, who named this product "extremely close to what I
want to build, only directed at creating businesses".

## 1. What was studied, and from where

No outside code was copied or ported. These are behaviour notes, in our own words.

| Source | Pinned at | Licence |
|---|---|---|
| `github.com/nickvasilescu/os1-her` (README, `docs/architecture.md`, `docs/os1-generative-ui-architecture.md`, the onboarding script, the phrase matcher, the card catalog, the director and the action bus) | `a3a7bc4`, 2026-11-22 | MIT |
| Build video by the same author, "I Built Samantha From 'Her'" (YouTube `1p4VB9uC2_w`, 39 min, 2026-11-22), read from its captions | 2026-11-22 | video; notes only |

OS1 is a personal assistant on a desktop (Electron), modelled on the film *Her*. It is one
day old, has one user and runs on the author's own cloud computer. Read it as a demonstration of
how the product should feel. It is not a production design for many tenants.

## 2. What the product does

1. **The voice is the interface.** There is no chat log and no keyboard. The screen stays calm,
   with a breathing shape, while the owner talks. Cards and screens appear only when seeing
   something helps, and they leave when the conversation moves on.
2. **First run is an interview.** A scripted operator voice asks three short questions, then hands
   over to the companion. The companion wakes, names itself and asks what the owner wants to do
   first. The interview answers become its first memory.
3. **One companion; many workers behind it.** The owner talks to one voice. Real work goes to
   background runs on a stronger model. The companion says "I'm on it" in one line and tells the
   owner the result later. A "swarm" screen shows every run that is working.
4. **Generative UI from a fixed catalog.** A fast judging model (TypeSafe Jev, about 100 ms)
   decides *whether* to show something and *which* screen fits. The worker model fills cards from
   a small typed catalog: a comparison, a choice between two things, a quick decision, a draft
   preview, a timeline, a read-back confirmation. Each card is checked against its schema before it
   shows. Code adds hysteresis so screens do not flicker mid-sentence.
5. **Everything on screen can be said.** Each button carries a phrase ("the 1:45", "open number
   seven", "undo that"). A plain text match resolves spoken phrases with no model call, so it is
   fast and predictable. A tap on the same chip takes the same path.
6. **A bottom bar of screens** (talk, home, inbox, cloud, my computer, swarm, canvas, memory,
   apps, voice) lets the owner switch screens by hand or by voice.
7. **Confirmation scales with risk.** A low-stakes action runs at once with a 60-second "undo
   that". Anything other people will see asks once. Money and forgetting need a read-back and a
   two-word answer. Every confirmation from any source goes through one queue.
8. **Connections are spoken.** "Connect my calendar" opens the provider's own consent page through
   Composio. Each app has a policy (full access, ask before writing, read only, ask every time).
   The owner hears it as a sentence ("Mail asks before sending"), not as a toggle.
9. **Memory the owner can see and delete.** A ledger shows what the companion remembers in plain
   categories. "Forget that" deletes it everywhere.
10. **Its own computer.** The companion works on an always-on cloud machine. The owner can watch
    that screen. It reaches the owner's own computer only as a last resort, inside a fenced list
    of apps and folders, with a kill switch.

## 3. What the video showed

- **The magic moment is speed and calm.** The author's reaction is to screens that appear "before
  I touched anything", and to a voice that sounds human.
- **It failed in visible ways on the first run.** The companion said it had started a task when it
  had only meant to ask. It said the inbox was open while the mail account was not connected.
  Screens and speech disagreed ("there seems to be a discrepancy between what you're saying and
  what I see"). It invented the owner's name, then admitted it. It drifted into a flirtatious tone
  the owner had to correct.
- **Lesson:** the companion must never say a thing happened until the system says it happened.
  This is our rule "nothing says booked until the row commits", applied to speech.
- **Build method:** design first in a design tool, two models designing in parallel and the better
  parts merged, then a plan written by each model and cross-reviewed. This matches how we already
  work.

## 4. How it maps to zs-business

| OS1 pattern | zs-business today | Verdict |
|---|---|---|
| One companion voice, workers behind it | Chief of Staff seat (`direction.md` §3); one drafting agent; no task record, no command entry | **Keep.** The companion is the Chief of Staff's face. "Hundreds of agents" are the task types behind it |
| Background runs plus a swarm screen | Agent runs, switches and cost exist (`packages/core/src/agents`) | **Keep.** The swarm view becomes "your team at work": the owner's employee agents, each with a status and a stop |
| Fixed card catalog, schema-checked | V-05 already says "a fixed set of typed cards, never free HTML" | **Keep, and widen.** Add form cards that ask for missing fields (business name, hours, service list, prices), a connect card and a plan-step card. Every card has a phrase and a tap |
| Fast judge picks when and which card | Jev is in Devin's tool set; nothing in this repo uses it | **Research (ZSB-75).** Judges only. It never acts and never approves |
| Spoken phrase match, no model | No command entry (`direction.md` §4, gap 3) | **Keep.** Cheapest, most predictable path for navigation and simple commands |
| Swipe to screens | PWA with six areas at 390x844 (`apps/dashboard`) | **Keep.** Talk is home. Swipe left to canvas and tools: calendar, customers, inbox, site, team (employee agents) |
| Low-stakes acts at once with undo | Agents may read, sort, label and draft alone (`direction.md` trust table) | **Keep, inside our table.** Undo covers internal reversible changes only. It never covers a send, a publish or money |
| Money and forgetting by spoken read-back | Rule 5: voice can ask, draft and pause; it cannot approve a recipient, an amount or a term | **Our rule wins.** Voice prepares the card. The approval is a tap on the exact action on screen |
| Spoken connection with per-app policy | Composio managed OAuth; credentials stay in the adapter (V-27) | **Keep.** "Connect my calendar" opens the consent card. Policy is a sentence. One owner tap per connection stays (trust table) |
| Interview first run, answers to memory | Setup picks one of four templates; ZSB-70 plans a question graph | **Keep.** The first run is the business interview (V-01 to V-07), spoken, with form cards for the facts it needs |
| Memory ledger with real delete | Company facts with who set each (ZSB-43); export and delete (B13, B14) | **Keep.** Facts show their source; "forget that" maps to delete with a receipt |
| Its own cloud computer, reaches the owner's computer | V-30: parked after the OpenMausBot pilot failed on approvals | **Still deferred.** The business companion works through connections and the action path, not by driving a desktop |
| Single user, keys on one machine | Multi-tenant, RLS, one action path | **Do not copy.** Every OS1 shortcut that assumes one user is out |
| Cloned film voice | — | **Drop.** Use a licensed or original voice with rights for commercial use (`docs/licenses.md`) |

## 5. What it adds to the vision

These become V-32 to V-38 in `docs/vision.md`:

- **V-32** The business companion is the home screen: a voice-first presence, not a chat log.
- **V-33** Generative UI: a typed card catalog with form cards that ask for missing information
  when needed.
- **V-34** Every control can be said; a phrase match runs before any model.
- **V-35** Swipe navigation: talk is home; canvas, tools, schedule and the team are a swipe away.
- **V-36** Employee agents the owner can see, assign, pause and stop from the phone.
- **V-37** The companion sets up the environment: it opens accounts, connections and the site in
  the right order, so setup feels like one conversation.
- **V-38** The companion's words match the system: it never says done, open or connected until the
  record says so.

## 6. Work it opens

- **ZSB-83** Contract `companion.md`: the companion shell (talk home, swipe screens), the card
  catalog with form cards, the phrase match, the run and team view, and the rule that speech
  matches the records. It sits on the action path and the trust table; it adds no new powers.
- **ZSB-75** (widened): add speech out, a fast judge for card timing (Jev), a latency budget,
  cost per active hour and voice rights to the phone device spike. D-4 still waits on it.
