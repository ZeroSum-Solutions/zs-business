// Zero Sum booking link page (booking-self-service.md BS-10). Original code, in the style of booker.js: the
// customer sees their booking, cancels it, or moves it to another free time. It talks only to
// /public/v1/manage on its own origin, keeps the token in the path, and renders server text with textContent.
(() => {
  "use strict";
  const root = document.getElementById("booker");
  const match = /^\/manage\/(zsm1_[A-Za-z0-9_-]{70})\/?$/.exec(location.pathname);
  let token = match ? match[1] : null;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const RANGE_DAYS = 14;

  const state = {
    view: null,
    // "view" | "cancel" | "date" | "time" | "confirm" | "done"
    step: "view",
    slots: [],
    day: null,
    slot: null,
    notice: "",
    dead: "",
    // The request in flight or unconfirmed: { kind, key, json, uncertain }. Key and body stay frozen together
    // until a definitive reply, so every resend is byte for byte the request the server may have saved.
    attempt: null,
    submitting: false,
    outcome: "",
  };

  const dayKey = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" });
  const dayLabel = new Intl.DateTimeFormat(undefined, { timeZone: zone, weekday: "short", month: "short", day: "numeric" });
  const longDay = new Intl.DateTimeFormat(undefined, { timeZone: zone, weekday: "long", month: "long", day: "numeric" });
  const timeLabel = new Intl.DateTimeFormat(undefined, { timeZone: zone, hour: "numeric", minute: "2-digit" });

  /** Build an element; strings become text nodes, never markup. */
  function h(tag, attrs, ...children) {
    const element = document.createElement(tag);
    for (const [name, value] of Object.entries(attrs || {})) {
      if (value === false || value === null || value === undefined) continue;
      if (name.startsWith("on")) element.addEventListener(name.slice(2), value);
      else element.setAttribute(name, value === true ? "" : String(value));
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      element.append(typeof child === "string" ? document.createTextNode(child) : child);
    }
    return element;
  }

  const OFFLINE = "We could not reach the booking service. Check your connection and try again.";
  const reasonOf = (response) => response && response.body && response.body.error && response.body.error.details && response.body.error.details.reason;

  /** A request that never throws: no connection answers status 0, so callers always reach render(). */
  async function call(method, path, headers, body) {
    try {
      const response = await fetch(path, {
        method, credentials: "omit", referrerPolicy: "no-referrer",
        headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(headers || {}) },
        ...(body === undefined ? {} : { body }),
      });
      const parsed = await response.json().catch(() => null);
      return { status: response.status, body: parsed, retryAfter: response.headers.get("Retry-After") };
    } catch {
      return { status: 0, body: null, retryAfter: null };
    }
  }

  const locked = () => state.submitting || Boolean(state.attempt);
  const go = (action) => (event) => { if (!locked()) action(event); };

  function render() {
    const view = state.dead ? deadView()
      : !state.view ? h("p", { class: "booker-status" }, state.notice || "Loading…")
        : state.attempt && state.attempt.uncertain ? unconfirmedView() : viewFor(state.step);
    // Views are arrays with optional parts (null when absent); replaceChildren would print "null".
    root.replaceChildren(...(Array.isArray(view) ? view : [view]).filter((node) => node !== null && node !== undefined && node !== false));
    const focus = root.querySelector("[data-focus]");
    if (focus) focus.focus({ preventScroll: true });
  }

  const noticeLine = () => (state.notice ? h("p", { class: "booker-error", role: "alert" }, state.notice) : null);

  function when(view) {
    const start = new Date(view.startsAt);
    const end = new Date(view.endsAt);
    return h("div", { class: "booker-summary" },
      h("strong", {}, longDay.format(start)),
      h("div", {}, `${timeLabel.format(start)} – ${timeLabel.format(end)}`),
      h("div", { class: "booker-hint" }, `Times are shown in ${zone}.`));
  }

  function header(view) {
    return [
      h("h1", { tabindex: "-1", "data-focus": true }, "Your appointment"),
      h("p", { class: "booker-sub" }, view.serviceName ? `${view.businessName} · ${view.serviceName}` : view.businessName),
    ];
  }

  function deadView() {
    return [h("h1", { tabindex: "-1", "data-focus": true }, state.dead === "expired" ? "This link has expired" : "This link is not available"),
      h("p", { class: "booker-status" }, state.dead === "expired"
        ? "The appointment has started, so it can no longer be changed here. Please contact the business directly."
        : "Please check the link in your email, or contact the business directly.")];
  }

  function viewFor(step) {
    const view = state.view;
    if (view.state === "cancelled") return [...header(view), h("div", { class: "booker-done" }, h("h2", {}, "This appointment is cancelled")), when(view)];
    if (view.state === "started") return [...header(view), h("p", { class: "booker-status" }, "This appointment has started and can no longer be changed here."), when(view)];
    if (view.state === "moved") {
      const next = view.movedTo;
      return [...header(view), h("h2", {}, "This appointment was moved"),
        h("p", { class: "booker-status" }, `It is now on ${longDay.format(new Date(next.startsAt))}, ${timeLabel.format(new Date(next.startsAt))}.`),
        h("a", { class: "booker-link", href: `/manage/${next.token}` }, "See the new appointment")];
    }
    if (step === "done") return doneView();
    if (step === "cancel") return cancelView();
    if (step === "date") return dateView();
    if (step === "time") return timeView();
    if (step === "confirm") return confirmView();
    return mainView();
  }

  function mainView() {
    const view = state.view;
    return [...header(view), when(view), noticeLine(),
      h("div", { class: "booker-grid" },
        h("button", { type: "button", class: "booker-choice", disabled: locked(), onclick: go(() => { state.notice = ""; state.step = "date"; loadSlots(); }) }, "Pick another time"),
        h("button", { type: "button", class: "booker-choice", disabled: locked(), onclick: go(() => { state.notice = ""; state.step = "cancel"; render(); }) }, "Cancel appointment"))];
  }

  function cancelView() {
    return [h("h2", { tabindex: "-1", "data-focus": true }, "Cancel this appointment?"), when(state.view), noticeLine(),
      h("button", { type: "button", class: "booker-primary", disabled: state.submitting, onclick: cancel }, state.submitting ? "Cancelling…" : "Yes, cancel it"),
      h("button", { type: "button", class: "booker-link", disabled: locked(), onclick: go(() => { state.notice = ""; state.step = "view"; render(); }) }, "No, keep it")];
  }

  function slotsByDay() {
    const days = new Map();
    for (const slot of state.slots) {
      const key = dayKey.format(new Date(slot.startsAt));
      if (!days.has(key)) days.set(key, []);
      days.get(key).push(slot);
    }
    return days;
  }

  function dateView() {
    const days = slotsByDay();
    return [h("h2", { tabindex: "-1", "data-focus": true }, "Pick a day"), noticeLine(),
      days.size === 0
        ? h("p", { class: "booker-status" }, `No times are free in the next ${RANGE_DAYS} days.`)
        : h("div", { class: "booker-grid" }, [...days].map(([key, slots]) => h("button", {
          type: "button", class: "booker-choice", disabled: locked(),
          onclick: go(() => { state.day = key; state.notice = ""; state.step = "time"; render(); }),
        }, dayLabel.format(new Date(slots[0].startsAt)), h("small", {}, `${slots.length} ${slots.length === 1 ? "time" : "times"}`)))),
      h("p", { class: "booker-hint" }, `Times are shown in ${zone}.`),
      h("button", { type: "button", class: "booker-link", disabled: locked(), onclick: go(() => { state.notice = ""; state.step = "view"; render(); }) }, "Back")];
  }

  function timeView() {
    const slots = slotsByDay().get(state.day) || [];
    return [h("h2", { tabindex: "-1", "data-focus": true }, slots[0] ? longDay.format(new Date(slots[0].startsAt)) : "Pick a time"), noticeLine(),
      slots.length === 0
        ? h("p", { class: "booker-status" }, "No times are left on this day.")
        : h("div", { class: "booker-grid" }, slots.map((slot) => h("button", {
          type: "button", class: "booker-choice", disabled: locked(),
          onclick: go(() => { state.slot = slot; state.notice = ""; state.step = "confirm"; render(); }),
        }, timeLabel.format(new Date(slot.startsAt))))),
      h("button", { type: "button", class: "booker-link", disabled: locked(), onclick: go(() => { state.step = "date"; state.notice = ""; render(); }) }, "Back to days")];
  }

  function confirmView() {
    const slot = state.slot;
    if (!slot || !state.slots.some((other) => other.startsAt === slot.startsAt)) {
      return [h("h2", { tabindex: "-1", "data-focus": true }, "That time is no longer available"),
        h("p", { class: "booker-status" }, "Someone else booked it first. Please pick another time."),
        h("button", { type: "button", class: "booker-primary", disabled: locked(), onclick: go(() => { state.slot = null; state.step = "date"; render(); }) }, "See free times")];
    }
    return [h("h2", { tabindex: "-1", "data-focus": true }, "Move your appointment to"),
      h("div", { class: "booker-summary" }, h("strong", {}, longDay.format(new Date(slot.startsAt))),
        h("div", {}, `${timeLabel.format(new Date(slot.startsAt))} – ${timeLabel.format(new Date(slot.endsAt))}`)),
      noticeLine(),
      h("button", { type: "button", class: "booker-primary", disabled: state.submitting, onclick: reschedule }, state.submitting ? "Moving…" : "Move my appointment"),
      h("button", { type: "button", class: "booker-link", disabled: locked(), onclick: go(() => { state.step = "time"; state.notice = ""; render(); }) }, "Choose another time")];
  }

  function doneView() {
    const view = state.view;
    return [h("div", { class: "booker-done" }, h("h2", { tabindex: "-1", "data-focus": true }, state.outcome), when(view)),
      view.canChange ? h("button", { type: "button", class: "booker-link", onclick: () => { state.step = "view"; state.outcome = ""; render(); } }, "Change it again") : null];
  }

  /** No answer we can trust: offer only the same request again. */
  function unconfirmedView() {
    const verb = state.attempt.kind === "cancel" ? "cancellation" : "change";
    return [h("h2", { tabindex: "-1", "data-focus": true }, `We could not confirm your ${verb}`),
      h("p", { class: "booker-error", role: "alert" }, `${state.notice} It may already have gone through. Trying again will not do it twice.`),
      h("button", { type: "button", class: "booker-primary", disabled: state.submitting, onclick: send }, state.submitting ? "Checking…" : "Try again")];
  }

  async function loadView() {
    const response = await call("GET", `/public/v1/manage/${token}`);
    if (response.status === 200 && response.body && typeof response.body.state === "string") { state.view = response.body; return true; }
    if (response.status === 409 && reasonOf(response) === "link_expired") state.dead = "expired";
    else if (response.status === 0 && state.view) state.notice = OFFLINE;
    else if (response.status === 429) state.notice = "Too many requests. Please try again shortly.";
    else state.dead = "missing";
    return false;
  }

  let slotsFetch = 0;
  async function loadSlots() {
    if (locked()) return;
    const from = new Date();
    const to = new Date(from.getTime() + RANGE_DAYS * 86400000);
    const query = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
    const fetchId = ++slotsFetch;
    render();
    const response = await call("GET", `/public/v1/manage/${token}/slots?${query}`);
    if (fetchId !== slotsFetch || locked()) return;
    if (response.status === 200 && response.body) state.slots = response.body.slots;
    else if (response.status === 409 && reasonOf(response) === "link_expired") state.dead = "expired";
    else if (response.status === 409) { await loadView(); state.step = "view"; }
    else if (response.status === 429) state.notice = "Too many requests. Please try again shortly.";
    else if (response.status === 0) state.notice = OFFLINE;
    else state.notice = "Free times could not be loaded. Please try again.";
    render();
  }

  function begin(kind, body) {
    if (state.submitting || state.attempt) return send();
    // One key per attempt, kept with its body until a definitive answer, so a retry replays.
    state.attempt = { kind, key: crypto.randomUUID(), json: JSON.stringify(body), uncertain: false };
    return send();
  }
  const cancel = () => begin("cancel", {});
  const reschedule = () => begin("reschedule", { startsAt: state.slot.startsAt });

  /** Send the frozen attempt; also the "Try again" action while its outcome is unknown. */
  async function send() {
    const attempt = state.attempt;
    if (state.submitting || !attempt) return;
    state.submitting = true;
    render();
    const response = await call("POST", `/public/v1/manage/${token}/${attempt.kind}`, { "Idempotency-Key": attempt.key }, attempt.json);
    state.submitting = false;
    await handleReply(attempt, response);
  }

  async function handleReply(attempt, response) {
    const reason = reasonOf(response);
    if (response.status === 200 && response.body) {
      state.attempt = null;
      state.notice = "";
      if (attempt.kind === "cancel") {
        state.view = response.body;
        state.outcome = "Your appointment is cancelled";
      } else {
        state.view = response.body.view;
        token = response.body.token;
        if (typeof history !== "undefined" && history.replaceState) history.replaceState(null, "", `/manage/${token}`);
        state.outcome = "Your appointment is moved";
      }
      state.step = "done";
      render();
      return;
    }
    if (response.status === 429) {
      // Refused before any database work. A fresh attempt drops its key; one that may already have been saved keeps it.
      if (!attempt.uncertain) state.attempt = null;
      const minutes = Math.max(1, Math.ceil(Number(response.retryAfter || 60) / 60));
      state.notice = `Too many attempts. Please try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
      render();
      return;
    }
    // No reply, a 5xx or a gateway page: the request may have committed. Keep key and body.
    if (response.status === 0 || response.status >= 500 || !response.body || typeof response.body !== "object") {
      attempt.uncertain = true;
      state.notice = response.status === 0 ? "We could not reach the booking service." : "The booking service did not answer properly.";
      render();
      return;
    }
    // Anything else is a definitive answer: this attempt is over and the next one gets a new key.
    state.attempt = null;
    if (response.status === 409 && reason === "link_expired") state.dead = "expired";
    else if (response.status === 409 && reason === "slot_unavailable") {
      state.notice = "That time was just taken. Please pick another time.";
      state.slot = null;
      state.step = "date";
      await loadSlots();
      return;
    } else if (response.status === 409 && (reason === "too_late" || reason === "not_changeable" || reason === "same_time")) {
      await loadView();
      state.step = "view";
      if (reason === "same_time") state.notice = "That is the time you already have. Please pick another.";
      else if (!state.dead && state.view && state.view.state === "confirmed") state.notice = "This appointment can no longer be changed.";
    } else if (response.status === 404) state.dead = "missing";
    else state.notice = "That did not work. Please try again.";
    render();
  }

  async function start() {
    if (!token) { state.dead = "missing"; render(); return; }
    await loadView();
    render();
  }

  start();
})();
