# zs-business

One phone app that runs a small company. The owner talks to one companion, approves exact actions with a tap, and agents do the work behind it.

## People and tenants

**Owner**:
The person who runs a business on the platform and alone approves its outward actions.
_Avoid_: User, customer (when you mean the owner), client

**Tenant**:
One business on the platform, with its own records, connections and plan.
_Avoid_: Account, workspace, org

**Tenant zero**:
Zero Sum's own business, run as an ordinary tenant in the same app.
_Avoid_: Internal instance, dogfood env

**Cohort**:
A launch group of outside owners who share a first job: service sellers who take bookings, or makers and e-commerce sellers who take orders.
_Avoid_: Segment, persona

**Maker**:
An owner who makes and sells physical goods, usually found through Instagram and sold through a store.
_Avoid_: Creator, merchant

**Tester**:
An outside owner who uses the app alone, without help from us, on a tester grant.
_Avoid_: Beta user, pilot (a pilot is a paid agency client)

## The companion

**Companion**:
The one conversation the owner talks or types to; it prepares actions as cards and hands tasks to agents.
_Avoid_: Assistant, chatbot, CEO agent

**Card**:
A typed piece of the conversation from a fixed catalog (choice, draft preview, form, connect, plan, go live) that shows one thing or prepares one action.
_Avoid_: Widget, generative UI block

**Tap**:
The owner's approval of one exact action on its card; voice never counts as a tap.
_Avoid_: Confirm, OK, voice approval

**First run**:
The companion's guided start for a new tenant, from sign-up to the first agent switched on.
_Avoid_: Onboarding wizard, guided setup, setup flow

**Undo**:
The owner's reversal of a private change the companion made at once, offered on the card for 60 seconds and then in the activity log.
_Avoid_: Rollback, revert (for outward actions, which need a tap instead)

**Go live**:
The one card and tap that publishes a tenant's bound release (booking page, site and AEO files) all at once.
_Avoid_: Publish button, launch

## Agents and work

**Agent**:
A worker that does one task type for a tenant and never approves its own or another agent's work.
_Avoid_: Bot, employee agent

**Task type**:
One kind of job an agent does, such as an inquiry follow-up or an order reply; autonomy is earned per task type.
_Avoid_: Skill, workflow, "hundreds of agents"

**Stack**:
A sold bundle of task types for one area of the business, such as marketing or SEO.
_Avoid_: Agent team, enterprise

**Order reply**:
The e-commerce first job: an agent reads an order the requester placed and drafts a reply for one tap.
_Avoid_: WISMO bot, order tracking

## Money

**Plan**:
A priced tier defined in `plans.ts`, the one price source.
_Avoid_: Package, subscription tier (outside plans.ts)

**Tester grant**:
A 14-day Solo plan given by a single-use invite code bound to one email, with no card.
_Avoid_: Comp, free trial

**Trial**:
The 14-day card-required start of a paid plan, once per tenant (once per shop for Shopify installs).
_Avoid_: Tester grant, free plan

**Standalone service**:
One finished feature sold on its own (such as the site audit) through the same app, login and records.
_Avoid_: Side product, one-off
