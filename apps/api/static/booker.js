// Zero Sum hosted booker (public-intake.md P-14). Original code; the cal.diy Booker (MIT) was a
// behaviour reference only: date, then time, then details, then confirmation, with slots
// refetched on focus and every few minutes and a "no longer available" state.
// It talks only to /public/v1 on its own origin and renders visitor text with textContent.
(() => {
  "use strict";
  const root = document.getElementById("booker");
  const match = /^\/book\/(zsb1_[A-Za-z0-9_-]{64})\/?$/.exec(location.pathname);
  const params = new URLSearchParams(location.search);
  const embedded = params.get("embed") === "1" && window.parent !== window;
  const channel = params.get("channel") === "widget" ? "widget" : "booking_page";
  // Times show in the business's zone (the resource's), so a Chicago gym never shows 4:00 AM to a
  // visitor on a Pacific laptop. The visitor's own time is added only where it differs.
  const visitorZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const RANGE_DAYS = 14;
  const REFRESH_MS = 3 * 60 * 1000;

  // Theming (public-intake.md P-16). The embedding page passes its look as query parameters
  // (embed.js reads them from --zs-booking-* custom properties). A value is kept only when it
  // passes a strict grammar, is a real opaque colour (or font list, or radius) to the browser,
  // and keeps every text colour readable; it is only ever set as a custom property through the
  // CSSOM, so it can not close a rule, load a URL or run script. Nothing set: today's look.
  const COLOR = /^(#[0-9a-f]{3}|#[0-9a-f]{4}|#[0-9a-f]{6}|#[0-9a-f]{8}|(rgba?|hsla?)\([0-9.%deg\s,/+-]{1,60}\)|[a-z]{3,24})$/i;
  const NOT_A_COLOUR = /^(inherit|initial|unset|revert|revert-layer|transparent|currentcolor|none)$/i;
  const RADIUS = /^(0|(\d{1,2}(\.\d{1,2})?)(px|rem|em))$/;
  const FAMILY = /^("[A-Za-z0-9 _-]{1,40}"|'[A-Za-z0-9 _-]{1,40}'|-?[A-Za-z][A-Za-z0-9 _-]{0,39})$/;
  // Unquoted, these are keywords or system fonts, not families.
  const NOT_A_FAMILY = /^(inherit|initial|unset|revert|revert-layer|default|none|caption|icon|menu|message-box|small-caption|status-bar)$/i;
  const MIN_CONTRAST = 4.5;

  const hex = (css) => {
    const digits = css.slice(1);
    return { css, c: { r: Number.parseInt(digits.slice(0, 2), 16), g: Number.parseInt(digits.slice(2, 4), 16), b: Number.parseInt(digits.slice(4, 6), 16) } };
  };
  // booker.css defaults, plus the fallbacks tried when a theme makes a default unreadable.
  const DEFAULT = {
    bg: hex("#ffffff"), surface: hex("#ffffff"), text: hex("#1d232a"), muted: hex("#5b6672"),
    accent: hex("#24577a"), accentText: hex("#ffffff"), error: hex("#a3271f"),
  };
  const LIGHT_MUTED = hex("#a1a1aa");
  const LIGHT_ERROR = hex("#ff8a80");
  const INKS = [hex("#000000"), hex("#ffffff")];

  function isFont(value) {
    if (value.length > 200 || (typeof CSS !== "undefined" && !CSS.supports("font-family", value))) return false;
    return value.split(",").every((part) => {
      const name = part.trim();
      return FAMILY.test(name) && !NOT_A_FAMILY.test(name);
    });
  }
  const isRadius = (value) => RADIUS.test(value) && Number.parseFloat(value) <= (value.endsWith("px") ? 48 : 3);

  /** { css, c: {r,g,b} } for a value the browser itself reads as an opaque colour, else null. */
  function resolveColour(value) {
    if (!value || value.length > 200 || !COLOR.test(value) || NOT_A_COLOUR.test(value)) return null;
    if (typeof CSS === "undefined" || !CSS.supports("color", value)) return null;
    const probe = document.createElement("span");
    probe.style.color = value;
    (document.body || document.documentElement).append(probe);
    const computed = getComputedStyle(probe).color;
    probe.remove();
    const parts = /^rgba?\(([^)]*)\)$/.exec(computed || "");
    if (!parts) return null;
    const n = parts[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    if (n.length < 3 || n.some((x) => !Number.isFinite(x))) return null;
    if (n.length > 3 && n[3] < 1) return null;
    return { css: value, c: { r: n[0], g: n[1], b: n[2] } };
  }

  function luminance({ r, g, b }) {
    const [lr, lg, lb] = [r, g, b].map((v) => {
      const channel = v / 255;
      return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
  }

  function contrast(a, b) {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  }

  /** color-mix(in srgb, a share, b). */
  const mix = (a, b, share) => ({ r: a.r * share + b.r * (1 - share), g: a.g * share + b.g * (1 - share), b: a.b * share + b.b * (1 - share) });

  /** The colours to set: { cssVar: value }. Empty when nothing usable was passed. */
  function themeFrom(search) {
    const colour = (name) => resolveColour((search.get(name) || "").trim());
    const bgIn = colour("bg");
    const surfaceIn = colour("surface");
    const accent = colour("accent") || DEFAULT.accent;
    // One of bg and surface alone: the other follows it, so a dark page never keeps white buttons.
    let bg = bgIn || surfaceIn || DEFAULT.bg;
    let surface = surfaceIn || bgIn || DEFAULT.surface;
    // Text sits on the page, on buttons and on a selected button (8% accent over the surface).
    const grounds = () => [bg.c, surface.c, mix(accent.c, surface.c, 0.08)];
    const reads = (fg, on) => fg && on.every((ground) => contrast(fg.c, ground) >= MIN_CONTRAST);
    const someInkReads = () => INKS.some((ink) => reads(ink, grounds()));
    // No ink reads on both: the surface follows the page; failing that, both keep the defaults.
    if (!someInkReads()) surface = bg;
    if (!someInkReads()) { bg = DEFAULT.bg; surface = DEFAULT.surface; }
    const pick = (candidates, on = grounds()) => candidates.find((candidate) => reads(candidate, on))
      || INKS.slice().sort((x, y) => Math.min(...on.map((g) => contrast(y.c, g))) - Math.min(...on.map((g) => contrast(x.c, g))))[0];
    const text = pick([colour("text"), DEFAULT.text, ...INKS]);
    const muted = pick([colour("muted"), DEFAULT.muted, LIGHT_MUTED, text]);
    const error = pick([colour("error"), DEFAULT.error, LIGHT_ERROR, text]);
    const link = pick([colour("link"), accent, DEFAULT.accent, text]);
    const accentText = pick([colour("accent-text"), DEFAULT.accentText, ...INKS], [accent.c]);
    const border = colour("border");

    const out = {};
    const set = (cssVar, value, fallback) => { if (value !== fallback) out[cssVar] = value.css; };
    set("--zs-bg", bg, DEFAULT.bg);
    set("--zs-surface", surface, DEFAULT.surface);
    set("--zs-ink", text, DEFAULT.text);
    set("--zs-muted", muted, DEFAULT.muted);
    set("--zs-accent", accent, DEFAULT.accent);
    set("--zs-accent-ink", accentText, DEFAULT.accentText);
    set("--zs-danger", error, DEFAULT.error);
    set("--zs-link", link, accent);
    if (border) out["--zs-line"] = border.css;
    const radius = (search.get("radius") || "").trim();
    if (radius && isRadius(radius)) out["--zs-radius"] = radius;
    const font = (search.get("font") || "").trim();
    if (font && isFont(font)) out["--zs-font"] = font;
    // Fields follow a themed page; otherwise they keep the browser's own colours.
    if (bg !== DEFAULT.bg || surface !== DEFAULT.surface) {
      out["--zs-field-bg"] = surface.css;
      out["--zs-field-ink"] = text.css;
    }
    if (accent !== DEFAULT.accent) out["--zs-check"] = accent.css;
    // A dark page gets dark scrollbars and controls; the value is ours, never the input.
    if (luminance(bg.c) < 0.18) out["color-scheme"] = "dark";
    return out;
  }

  function applyTheme() {
    const theme = themeFrom(params);
    const style = document.documentElement.style;
    for (const [property, value] of Object.entries(theme)) style.setProperty(property, value);
    // A host page that shows its own title may hide the booker's; a page opened on its own
    // always shows it.
    if (embedded && params.get("header") === "0") document.documentElement.setAttribute("data-header", "hidden");
  }

  const state = {
    page: null,
    resourceId: null,
    slots: [],
    day: null,
    slot: null,
    step: "date",
    notice: "",
    errors: {},
    form: { name: "", email: "", phone: "", notes: "", consentEmail: false, consentSms: false, website: "" },
    // The request in flight or unconfirmed: { key, json, fields, slot, uncertain }. Key and body
    // are frozen together, so every resend is byte for byte the request the server may have saved.
    attempt: null,
    submitting: false,
    result: null,
  };

  const formats = new Map();

  /** Formatters for one zone, built once. An unknown zone falls back to the visitor's. */
  function formatsFor(zoneId) {
    if (formats.has(zoneId)) return formats.get(zoneId);
    let set;
    try {
      set = {
        zone: zoneId,
        dayKey: new Intl.DateTimeFormat("en-CA", { timeZone: zoneId, year: "numeric", month: "2-digit", day: "2-digit" }),
        dayLabel: new Intl.DateTimeFormat(undefined, { timeZone: zoneId, weekday: "short", month: "short", day: "numeric" }),
        longDay: new Intl.DateTimeFormat(undefined, { timeZone: zoneId, weekday: "long", month: "long", day: "numeric" }),
        timeLabel: new Intl.DateTimeFormat(undefined, { timeZone: zoneId, hour: "numeric", minute: "2-digit" }),
        offsetLabel: new Intl.DateTimeFormat(undefined, { timeZone: zoneId, hour: "numeric", minute: "2-digit", timeZoneName: "short" }),
        name: zoneName(zoneId),
      };
    } catch {
      set = zoneId === visitorZone ? null : formatsFor(visitorZone);
    }
    formats.set(zoneId, set);
    return set;
  }

  /** "Pacific Time (Los Angeles)" for America/Los_Angeles; "UTC" for UTC. */
  function zoneName(zoneId) {
    const city = zoneId.includes("/") ? zoneId.split("/").pop().replace(/_/g, " ") : zoneId;
    let generic = "";
    try {
      const part = new Intl.DateTimeFormat(undefined, { timeZone: zoneId, timeZoneName: "longGeneric" })
        .formatToParts(new Date()).find((item) => item.type === "timeZoneName");
      generic = part ? part.value : "";
    } catch {
      generic = "";
    }
    // Zones with no common name format as an offset ("GMT+00:00"); the city reads better.
    if (!generic) return city;
    // Etc/GMT+8 means UTC-08:00, so its own name reads backwards; Intl's offset is right.
    // Old aliases (US/Pacific, Canada/Central) already read as a name; their last part is not a city.
    if (/^(Etc|US|Canada)\//i.test(zoneId) || !zoneId.includes("/")) return generic;
    if (/^(GMT|UTC)/.test(generic)) return city;
    return zoneId.includes("/") ? `${generic} (${city})` : generic;
  }

  /** A clock time; in the repeated hour when clocks go back, the zone abbreviation tells the two apart. */
  function clock(f, date) {
    const label = f.timeLabel.format(date);
    const hour = 3600000;
    const repeated = f.timeLabel.format(new Date(date.getTime() - hour)) === label || f.timeLabel.format(new Date(date.getTime() + hour)) === label;
    return repeated ? f.offsetLabel.format(date) : label;
  }

  /** The business's zone: the chosen resource's, else the visitor's. */
  function biz() {
    const resource = state.page && state.page.resources.find((item) => item.id === state.resourceId);
    return formatsFor(resource && resource.timeZone ? resource.timeZone : visitorZone);
  }

  function mine() {
    return formatsFor(visitorZone);
  }

  /** The visitor's own clock time for an instant, or null when it reads the same as the business's. */
  function visitorTime(iso) {
    const at = new Date(iso);
    const ours = biz();
    const theirs = mine();
    if (ours.zone === theirs.zone) return null;
    const same = ours.timeLabel.format(at) === theirs.timeLabel.format(at) && ours.dayKey.format(at) === theirs.dayKey.format(at);
    if (same) return null;
    const sameDay = ours.dayKey.format(at) === theirs.dayKey.format(at);
    return sameDay ? `${clock(theirs, at)} your time` : `${theirs.dayLabel.format(at)}, ${clock(theirs, at)} your time`;
  }

  /** "10:00 AM – 11:00 AM Pacific Time (Los Angeles)". */
  function rangeLine(startsAt, endsAt) {
    const f = biz();
    return `${clock(f, new Date(startsAt))} – ${clock(f, new Date(endsAt))} ${f.name}`;
  }

  /** The visitor's own time on a line of its own, or null when it reads the same. */
  function yoursLine(startsAt) {
    const yours = visitorTime(startsAt);
    return yours ? h("div", { class: "booker-hint" }, yours.charAt(0).toUpperCase() + yours.slice(1)) : null;
  }

  /** A time button's text: the business's time, and the visitor's under it when it differs, read out as one phrase. */
  function timeChoice(f, iso) {
    const time = clock(f, new Date(iso));
    const yours = visitorTime(iso);
    if (!yours) return [time];
    return [h("span", { "aria-hidden": "true" }, time), h("small", { "aria-hidden": "true" }, yours), h("span", { class: "booker-sr" }, `${time} ${f.name}, ${yours}`)];
  }

  /** Build an element; strings become text nodes, never markup. */
  function h(tag, attrs, ...children) {
    const element = document.createElement(tag);
    for (const [name, value] of Object.entries(attrs || {})) {
      if (value === false || value === null || value === undefined) continue;
      if (name.startsWith("on")) element.addEventListener(name.slice(2), value);
      else if (name === "value" || name === "checked") element[name] = value;
      else element.setAttribute(name, value === true ? "" : String(value));
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      element.append(typeof child === "string" ? document.createTextNode(child) : child);
    }
    return element;
  }

  // A focus move on the first paint would pull the host page's focus into the frame; headings
  // take focus only after the visitor has acted.
  let acted = false;
  const markActed = () => { acted = true; };
  // Focus moves only when the view changes, never on a re-render of the same view (slot refreshes).
  let shownView = null;

  /** A control's identity across re-renders: its id, else its tag and text. */
  const focusId = (node) => node.id ? `#${node.id}` : `${node.tagName}|${node.textContent}`;

  function viewKey() {
    if (!state.page) return "status";
    if (state.attempt && state.attempt.uncertain) return "unconfirmed";
    if (state.step === "details" && !stillAvailable()) return "details:gone";
    return state.step === "time" ? `time:${state.day}` : state.step;
  }

  function postHeight() {
    if (!embedded) return;
    // The body's own height, not the document's scroll height: that never drops below the
    // frame's current height, so the frame could grow but never shrink back.
    const height = Math.ceil(document.body.getBoundingClientRect().height);
    window.parent.postMessage({ type: "zs-booking:height", height }, "*");
  }

  /** A read that never throws: no connection answers status 0, so callers always reach render(). */
  async function getJson(path) {
    try {
      const response = await fetch(path, { headers: { Accept: "application/json" }, credentials: "omit" });
      const body = await response.json().catch(() => null);
      return { status: response.status, body, retryAfter: response.headers.get("Retry-After") };
    } catch {
      return { status: 0, body: null, retryAfter: null };
    }
  }

  const OFFLINE = "We could not reach the booking service. Check your connection and try again.";

  /** True while a request is in flight or unconfirmed: the slot and step must hold still. */
  function locked() {
    return state.submitting || Boolean(state.attempt);
  }

  /** A navigation handler that does nothing while locked. */
  function go(action) {
    return (event) => { if (!locked()) action(event); };
  }

  function render() {
    // An unconfirmed attempt may hold the slot, so its recovery panel wins over any step.
    const view = !state.page ? h("p", { class: "booker-status" }, state.notice || "Loading…")
      : state.attempt && state.attempt.uncertain ? unconfirmedView() : viewFor(state.step);
    const active = typeof root.contains === "function" && root.contains(document.activeElement) ? document.activeElement : null;
    const held = active ? focusId(active) : null;
    // Views are arrays with optional parts (null when absent); replaceChildren would print "null".
    root.replaceChildren(...(Array.isArray(view) ? view : [view]).filter((node) => node !== null && node !== undefined && node !== false));
    const key = viewKey();
    const moved = key !== shownView;
    shownView = key;
    const heading = root.querySelector("[data-focus]");
    if (moved) {
      if (heading && acted) heading.focus({ preventScroll: true });
    } else if (held) {
      // Same view drawn again: focus stays on the same control, or on the heading if it is gone.
      const same = [...root.querySelectorAll("button, input, textarea, [tabindex]")].find((node) => focusId(node) === held);
      if (same) same.focus({ preventScroll: true });
      else if (heading) heading.focus({ preventScroll: true });
    }
    postHeight();
  }

  function header() {
    const page = state.page;
    return [
      h("h1", { tabindex: "-1", "data-focus": state.step === "date" ? true : null }, page.title),
      h("p", { class: "booker-sub" }, page.businessName),
      page.description ? h("p", { class: "booker-sub booker-desc" }, page.description) : null,
    ];
  }

  function resourcePicker() {
    const resources = state.page.resources;
    if (resources.length < 2) return null;
    return h("div", {},
      h("h2", {}, "Choose a service"),
      h("div", { class: "booker-grid" }, resources.map((resource) => h("button", {
        type: "button",
        class: "booker-choice",
        "aria-pressed": String(resource.id === state.resourceId),
        disabled: locked(),
        onclick: go(() => { state.resourceId = resource.id; state.slots = []; state.day = null; state.slot = null; loadSlots(); }),
      }, resource.name || "Appointment", h("small", {}, `${resource.slotLengthMinutes} min`)))));
  }

  function slotsByDay() {
    const days = new Map();
    for (const slot of state.slots) {
      const key = biz().dayKey.format(new Date(slot.startsAt));
      if (!days.has(key)) days.set(key, []);
      days.get(key).push(slot);
    }
    return days;
  }

  function viewFor(step) {
    if (step === "done") return doneView();
    if (step === "details") return detailsView();
    if (step === "time") return timeView();
    return dateView();
  }

  function noticeLine() {
    return state.notice ? h("p", { class: "booker-error", role: "alert" }, state.notice) : null;
  }

  /** Names the zone; on the times step, also says the visitor's own time is under each one. */
  function zoneHint(slots) {
    const f = biz();
    const differs = Boolean(slots) && slots.some((slot) => visitorTime(slot.startsAt) !== null);
    const where = state.page.businessName ? ` local time for ${state.page.businessName}` : " the business's local time";
    return h("p", { class: "booker-hint" }, differs
      ? `Times are in ${f.name},${where}. Your time is shown under each one.`
      : `Times are in ${f.name},${where}.`);
  }

  function dateView() {
    const days = slotsByDay();
    const f = biz();
    return [
      ...header(),
      resourcePicker(),
      h("h2", {}, "Pick a day"),
      noticeLine(),
      days.size === 0
        ? h("p", { class: "booker-status" }, `No times are free in the next ${RANGE_DAYS} days.`)
        : h("div", { class: "booker-grid" }, [...days].map(([key, slots]) => h("button", {
          type: "button",
          class: "booker-choice",
          disabled: locked(),
          onclick: go(() => { state.day = key; state.notice = ""; state.step = "time"; render(); }),
        }, f.dayLabel.format(new Date(slots[0].startsAt)), h("small", {}, `${slots.length} ${slots.length === 1 ? "time" : "times"}`)))),
      days.size === 0 ? null : zoneHint(),
    ];
  }

  function timeView() {
    const slots = slotsByDay().get(state.day) || [];
    const f = biz();
    return [
      h("h2", { tabindex: "-1", "data-focus": true }, slots[0] ? f.longDay.format(new Date(slots[0].startsAt)) : "Pick a time"),
      noticeLine(),
      slots.length === 0
        ? h("p", { class: "booker-status" }, "No times are left on this day.")
        : h("div", { class: "booker-grid" }, slots.map((slot) => h("button", {
          type: "button",
          class: "booker-choice",
          disabled: locked(),
          onclick: go(() => { state.slot = slot; state.notice = ""; state.errors = {}; state.step = "details"; render(); }),
        }, ...timeChoice(f, slot.startsAt)))),
      slots.length === 0 ? null : zoneHint(slots),
      h("button", { type: "button", class: "booker-link", disabled: locked(), onclick: go(() => { state.step = "date"; state.notice = ""; render(); }) }, "Back to days"),
    ];
  }

  function stillAvailable() {
    return state.slot && state.slots.some((slot) => slot.startsAt === state.slot.startsAt);
  }

  function field(name, label, input, hint) {
    const error = state.errors[name];
    return h("div", { class: "booker-field" },
      h("label", { for: `booker-${name}` }, label),
      input,
      hint ? h("span", { class: "booker-hint", id: `booker-${name}-hint` }, hint) : null,
      error ? h("span", { class: "booker-error", id: `booker-${name}-error` }, error) : null);
  }

  function input(name, attrs) {
    return h(attrs.multiline ? "textarea" : "input", {
      id: `booker-${name}`,
      name,
      value: state.form[name],
      "aria-invalid": state.errors[name] ? "true" : null,
      "aria-describedby": [attrs.hinted ? `booker-${name}-hint` : null, state.errors[name] ? `booker-${name}-error` : null].filter(Boolean).join(" ") || null,
      oninput: (event) => { state.form[name] = event.target.value; },
      ...attrs,
      multiline: null,
      hinted: null,
    });
  }

  function slotSummary(slot) {
    return h("div", { class: "booker-summary" },
      h("strong", {}, biz().longDay.format(new Date(slot.startsAt))),
      h("div", {}, rangeLine(slot.startsAt, slot.endsAt)),
      yoursLine(slot.startsAt));
  }

  /** No answer we can trust: show what was sent and offer only the same request again. */
  function unconfirmedView() {
    const { fields, slot } = state.attempt;
    const updates = [fields.consent.email ? "email" : null, fields.consent.sms ? "text" : null].filter(Boolean);
    return [
      h("h2", { tabindex: "-1", "data-focus": true }, "We could not confirm your booking"),
      slotSummary(slot),
      h("p", { class: "booker-error", role: "alert" },
        `${state.notice} Your booking may already have gone through. Trying again will not book you twice.`),
      h("div", { class: "booker-summary" },
        h("strong", {}, "Details as submitted"),
        h("div", {}, `Name: ${fields.name}`),
        h("div", {}, `Email: ${fields.email}`),
        fields.phone ? h("div", {}, `Phone: ${fields.phone}`) : null,
        fields.notes ? h("div", {}, `Notes: ${fields.notes}`) : null,
        h("div", {}, `Updates: ${updates.length ? updates.join(" and ") : "none"}`)),
      h("button", { type: "button", class: "booker-primary", disabled: state.submitting, onclick: send },
        state.submitting ? "Checking…" : "Try again"),
    ];
  }

  function detailsView() {
    const slot = state.slot;
    const page = state.page;
    if (!stillAvailable()) {
      return [
        h("h2", { tabindex: "-1", "data-focus": true }, "That time is no longer available"),
        h("p", { class: "booker-status" }, "Someone else booked it first. Please pick another time."),
        h("button", { type: "button", class: "booker-primary", disabled: locked(), onclick: go(() => { state.slot = null; state.step = "date"; render(); }) }, "See free times"),
      ];
    }
    const checkbox = (name, label) => h("label", { class: "booker-check" },
      h("input", {
        type: "checkbox", name, checked: state.form[name],
        onchange: (event) => { state.form[name] = event.target.checked; },
      }), label);
    return [
      h("h2", { tabindex: "-1", "data-focus": true }, "Your details"),
      slotSummary(slot),
      noticeLine(),
      h("form", { novalidate: true, onsubmit: submit },
        field("name", "Name", input("name", { autocomplete: "name", required: true, maxlength: "200" })),
        field("email", "Email", input("email", { type: "email", autocomplete: "email", required: true, maxlength: "254" })),
        field("phone", "Phone (optional)", input("phone", { type: "tel", autocomplete: "tel", maxlength: "20", hinted: true }),
          northAmerican() ? "For example (555) 555-0123. Outside the US or Canada, start with + and your country code."
            : "Start with + and your country code."),
        field("notes", "Notes (optional)", input("notes", { multiline: true, rows: "3", maxlength: "1000" })),
        h("fieldset", { class: "booker-consent" },
          h("legend", {}, "Updates"),
          h("p", {}, page.disclosure.text),
          checkbox("consentEmail", "Email me updates"),
          checkbox("consentSms", "Text me updates")),
        h("div", { class: "booker-trap", "aria-hidden": "true" },
          h("label", { for: "booker-website" }, "Leave this empty"),
          h("input", { id: "booker-website", name: "website", tabindex: "-1", autocomplete: "off", value: state.form.website,
            oninput: (event) => { state.form.website = event.target.value; } })),
        h("button", { type: "submit", class: "booker-primary", disabled: state.submitting }, state.submitting ? "Booking…" : "Confirm booking")),
      h("button", { type: "button", class: "booker-link", disabled: locked(), onclick: go(() => { state.step = "time"; state.notice = ""; render(); }) }, "Choose another time"),
    ];
  }

  function doneView() {
    const result = state.result;
    return [
      h("div", { class: "booker-done" },
        h("h2", { tabindex: "-1", "data-focus": true }, "You're booked"),
        h("p", {}, `${biz().longDay.format(new Date(result.startsAt))}, ${rangeLine(result.startsAt, result.endsAt)}`),
        yoursLine(result.startsAt),
        h("p", { class: "booker-hint" }, `Reference ${result.requestId.slice(0, 8)}`)),
      h("button", { type: "button", class: "booker-link", onclick: () => { resetForm(); state.step = "date"; loadSlots(); } }, "Book another time"),
    ];
  }

  function resetForm() {
    state.form = { name: "", email: "", phone: "", notes: "", consentEmail: false, consentSms: false, website: "" };
    state.slot = null;
    state.result = null;
    state.errors = {};
    state.notice = "";
  }

  const FIELD_MESSAGES = {
    name: "Please enter your name.",
    email: "Please enter a valid email address.",
    phone: "Please enter a full phone number with area code, or start with + and your country code.",
    notes: "Notes can be at most 1000 characters.",
  };

  function localErrors() {
    const errors = {};
    if (!state.form.name.trim()) errors.name = FIELD_MESSAGES.name;
    if (!/^\S+@\S+\.\S+$/.test(state.form.email.trim())) errors.email = FIELD_MESSAGES.email;
    const phone = normalizedPhone();
    if (phone !== null && !/^\+[1-9][0-9]{1,14}$/.test(phone)) errors.phone = FIELD_MESSAGES.phone;
    return errors;
  }

  // US and Canada zones, and US territories (country code +1).
  const NANP_ZONE = /^(America\/(New_York|Detroit|Chicago|Denver|Boise|Phoenix|Los_Angeles|Anchorage|Juneau|Sitka|Metlakatla|Yakutat|Nome|Adak|Menominee|Indiana\/.+|Kentucky\/.+|North_Dakota\/.+|Indianapolis|Louisville|Toronto|Vancouver|Edmonton|Winnipeg|Regina|Halifax|St_Johns|Moncton|Glace_Bay|Goose_Bay|Swift_Current|Whitehorse|Dawson|Dawson_Creek|Fort_Nelson|Creston|Cambridge_Bay|Iqaluit|Rankin_Inlet|Resolute|Inuvik|Atikokan|Coral_Harbour|Blanc-Sablon|Montreal|Nipigon|Thunder_Bay|Rainy_River|Pangnirtung|Yellowknife|Shiprock|Fort_Wayne|Knox_IN|Atka|Puerto_Rico|St_Thomas|Virgin)|Pacific\/(Honolulu|Johnston|Guam|Saipan)|Navajo|US\/.+|Canada\/.+)$/i;

  /** A bare ten-digit number reads as +1 only when both the business and the visitor are in a +1 zone. */
  function northAmerican() {
    return NANP_ZONE.test(biz().zone) && NANP_ZONE.test(visitorZone);
  }

  function normalizedPhone() {
    const phone = state.form.phone.replace(/[\s().-]/g, "");
    if (phone === "") return null;
    if (!phone.startsWith("+") && northAmerican()) {
      if (/^[2-9][0-9]{9}$/.test(phone)) return `+1${phone}`;
      if (/^1[2-9][0-9]{9}$/.test(phone)) return `+${phone}`;
    }
    return phone;
  }

  async function submit(event) {
    event.preventDefault();
    if (state.submitting) return;
    if (!state.attempt) {
      state.errors = localErrors();
      state.notice = "";
      if (Object.keys(state.errors).length > 0) { render(); return; }
      const fields = {
        resourceId: state.resourceId,
        startsAt: state.slot.startsAt,
        name: state.form.name.trim(),
        email: state.form.email.trim(),
        phone: normalizedPhone(),
        notes: state.form.notes.trim() || null,
        consent: { email: state.form.consentEmail, sms: state.form.consentSms },
        disclosureVersion: state.page.disclosure.version,
        channel,
        website: state.form.website,
      };
      // One key per attempt, kept with its body until a definitive answer, so a retry replays.
      state.attempt = { key: crypto.randomUUID(), json: JSON.stringify(fields), fields, slot: state.slot, uncertain: false };
    }
    await send();
  }

  /** Send the frozen attempt; also the "Try again" action while its outcome is unknown. */
  async function send() {
    const attempt = state.attempt;
    if (state.submitting || !attempt) return;
    state.submitting = true;
    render();
    let response = null;
    try {
      const reply = await fetch(`/public/v1/pages/${match[1]}/requests`, {
        method: "POST",
        credentials: "omit",
        headers: { "Content-Type": "application/json", Accept: "application/json", "Idempotency-Key": attempt.key },
        body: attempt.json,
      });
      response = { status: reply.status, body: await reply.json().catch(() => null), retryAfter: reply.headers.get("Retry-After") };
    } catch {
      response = null;
    }
    state.submitting = false;
    await handleReply(attempt, response);
  }

  async function handleReply(attempt, response) {
    const reason = response && response.body && response.body.error && response.body.error.details && response.body.error.details.reason;
    if (response && response.status === 201 && response.body) {
      state.result = response.body;
      state.attempt = null;
      state.notice = "";
      state.step = "done";
      render();
      return;
    }
    if (response && response.status === 429) {
      // Refused before any database work. A fresh attempt drops its key; one that may already
      // have been saved keeps it, so the later retry still replays instead of looking taken.
      if (!attempt.uncertain) state.attempt = null;
      const minutes = Math.max(1, Math.ceil(Number(response.retryAfter || 60) / 60));
      state.notice = `Too many attempts. Please try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
      render();
      return;
    }
    // No reply, a 5xx or a gateway page: the request may have committed. Keep key and body.
    if (!response || response.status >= 500 || !response.body || typeof response.body !== "object") {
      attempt.uncertain = true;
      state.notice = response ? "The booking service did not answer properly." : "We could not reach the booking service.";
      render();
      return;
    }
    // Anything else is a definitive answer: this attempt is over and the next one gets a new key.
    state.attempt = null;
    if (response.status === 409 && reason === "disclosure_changed") {
      state.notice = "The updates notice changed. Please read it again and confirm.";
      await loadPage();
      state.step = "details";
    } else if (response.status === 409 && (reason === "slot_unavailable" || reason === "overlap")) {
      await loadSlots(false);
      state.step = "details";
    } else if (response.status === 400) {
      const issues = (response.body && response.body.error && response.body.error.details && response.body.error.details.issues) || [];
      state.errors = {};
      for (const issue of issues) {
        const name = String(issue.path || "").split(".")[0];
        if (FIELD_MESSAGES[name]) state.errors[name] = FIELD_MESSAGES[name];
      }
      if (Object.keys(state.errors).length === 0) state.notice = "Something in the form is not right. Please check it and try again.";
    } else if (response.status === 404) {
      state.page = null;
      state.notice = "This booking page is not available.";
    } else {
      state.notice = "Booking failed. Please try again.";
    }
    render();
  }

  async function loadPage() {
    const { status, body } = await getJson(`/public/v1/pages/${match[1]}`);
    // Offline after a definitive reply: keep the page shown so the visitor can try again.
    if (status === 0 && state.page) { state.notice = OFFLINE; return false; }
    if (status !== 200 || !body || !Array.isArray(body.resources)) {
      state.page = null;
      state.notice = status === 429 ? "Too many requests. Please try again shortly." : "This booking page is not available.";
      return false;
    }
    state.page = body;
    if (!body.resources.some((resource) => resource.id === state.resourceId)) state.resourceId = body.resources[0] ? body.resources[0].id : null;
    return true;
  }

  let slotsFetch = 0;

  /** Fetch free times; false when the answer was dropped as stale. */
  async function loadSlots(rerender = true) {
    if (locked()) return false;
    if (!state.resourceId) { state.slots = []; if (rerender) render(); return true; }
    const from = new Date();
    const to = new Date(from.getTime() + RANGE_DAYS * 86400000);
    const query = new URLSearchParams({ resourceId: state.resourceId, from: from.toISOString(), to: to.toISOString() });
    const fetchId = ++slotsFetch;
    const { status, body } = await getJson(`/public/v1/pages/${match[1]}/slots?${query}`);
    // A newer fetch went out, or an attempt began meanwhile and may itself hold the slot: drop it.
    if (fetchId !== slotsFetch || locked()) return false;
    if (status === 200 && body) state.slots = body.slots;
    else if (status === 429) state.notice = "Too many requests. Please try again shortly.";
    else if (status === 0) state.notice = OFFLINE;
    if (rerender) render();
    return true;
  }

  async function start() {
    applyTheme();
    document.addEventListener("pointerdown", markActed, true);
    document.addEventListener("keydown", markActed, true);
    // Assistive tech and voice control activate buttons with a click and no pointer or key event.
    document.addEventListener("click", markActed, true);
    if (!match) { state.notice = "This booking page is not available."; render(); return; }
    if (await loadPage()) await loadSlots(false);
    render();
    // Free times go stale while the page is open: refetch on focus and on a timer.
    const refresh = async () => {
      // An attempt in flight or unconfirmed may hold the slot itself; its retry reconciles first.
      if (!state.page || state.step === "done" || locked()) return;
      if (!(await loadSlots(false)) || state.step === "done") return;
      // Re-rendering the form would drop the visitor's focus; only do it when the slot was lost.
      if (state.step !== "details" || !stillAvailable()) render();
    };
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refresh(); });
    window.addEventListener("focus", refresh);
    setInterval(refresh, REFRESH_MS);
    if (embedded && "ResizeObserver" in window) new ResizeObserver(postHeight).observe(document.body);
  }

  start();
})();
