# The companion delegates to agents through durable tasks

The companion acts as the CEO agent: it hands work to agents as typed, durable tasks that survive retries and can be stopped. Every outward step still needs its own tap, and no agent approves another agent's work. This reverses the no-delegation rule in `docs/requirements/agents.md`. By 2027-01-14 only the delegation the first two jobs need is built (booking replies and order replies). Decided 2026-11-24 in ZSB-81 (Plaud round 1).
