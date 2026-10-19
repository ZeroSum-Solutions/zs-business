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
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const RANGE_DAYS = 14;
  const REFRESH_MS = 3 * 60 * 1000;

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
      else if (name === "value" || name === "checked") element[name] = value;
      else element.setAttribute(name, value === true ? "" : String(value));
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      element.append(typeof child === "string" ? document.createTextNode(child) : child);
    }
    return element;
  }

  function postHeight() {
    if (!embedded) return;
    const height = Math.ceil(document.documentElement.scrollHeight);
    window.parent.postMessage({ type: "zs-booking:height", height }, "*");
  }

  async function getJson(path) {
    const response = await fetch(path, { headers: { Accept: "application/json" }, credentials: "omit" });
    const body = await response.json().catch(() => null);
    return { status: response.status, body, retryAfter: response.headers.get("Retry-After") };
  }

  function render() {
    const view = state.page ? viewFor(state.step) : h("p", { class: "booker-status" }, state.notice || "Loading…");
    root.replaceChildren(...(Array.isArray(view) ? view : [view]));
    const focus = root.querySelector("[data-focus]");
    if (focus) focus.focus({ preventScroll: true });
    postHeight();
  }

  function header() {
    const page = state.page;
    return [
      h("h1", { tabindex: "-1", "data-focus": state.step === "date" ? true : null }, page.title),
      h("p", { class: "booker-sub" }, page.businessName),
      page.description ? h("p", { class: "booker-sub" }, page.description) : null,
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
        onclick: () => { state.resourceId = resource.id; state.day = null; state.slot = null; loadSlots(); },
      }, resource.name || "Appointment", h("small", {}, `${resource.slotLengthMinutes} min`)))));
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

  function viewFor(step) {
    if (step === "done") return doneView();
    if (step === "details") return detailsView();
    if (step === "time") return timeView();
    return dateView();
  }

  function noticeLine() {
    return state.notice ? h("p", { class: "booker-error", role: "alert" }, state.notice) : null;
  }

  function dateView() {
    const days = slotsByDay();
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
          onclick: () => { state.day = key; state.notice = ""; state.step = "time"; render(); },
        }, dayLabel.format(new Date(slots[0].startsAt)), h("small", {}, `${slots.length} ${slots.length === 1 ? "time" : "times"}`)))),
      h("p", { class: "booker-hint" }, `Times are shown in ${zone}.`),
    ];
  }

  function timeView() {
    const slots = slotsByDay().get(state.day) || [];
    return [
      h("h2", { tabindex: "-1", "data-focus": true }, slots[0] ? longDay.format(new Date(slots[0].startsAt)) : "Pick a time"),
      noticeLine(),
      slots.length === 0
        ? h("p", { class: "booker-status" }, "No times are left on this day.")
        : h("div", { class: "booker-grid" }, slots.map((slot) => h("button", {
          type: "button",
          class: "booker-choice",
          onclick: () => { state.slot = slot; state.notice = ""; state.errors = {}; state.step = "details"; render(); },
        }, timeLabel.format(new Date(slot.startsAt))))),
      h("button", { type: "button", class: "booker-link", onclick: () => { state.step = "date"; state.notice = ""; render(); } }, "Back to days"),
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
      "aria-describedby": state.errors[name] ? `booker-${name}-error` : null,
      oninput: (event) => { state.form[name] = event.target.value; },
      ...attrs,
      multiline: null,
    });
  }

  function slotSummary(slot) {
    return h("div", { class: "booker-summary" },
      h("strong", {}, longDay.format(new Date(slot.startsAt))),
      h("div", {}, `${timeLabel.format(new Date(slot.startsAt))} – ${timeLabel.format(new Date(slot.endsAt))}`));
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
    // An unconfirmed attempt may hold this very slot, so it is never shown as lost.
    if (state.attempt && state.attempt.uncertain) return unconfirmedView();
    if (!stillAvailable()) {
      return [
        h("h2", { tabindex: "-1", "data-focus": true }, "That time is no longer available"),
        h("p", { class: "booker-status" }, "Someone else booked it first. Please pick another time."),
        h("button", { type: "button", class: "booker-primary", onclick: () => { state.slot = null; state.step = "date"; render(); } }, "See free times"),
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
        field("phone", "Phone (optional)", input("phone", { type: "tel", autocomplete: "tel", maxlength: "20" }),
          "International format, for example +44 20 7946 0000."),
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
      h("button", { type: "button", class: "booker-link", onclick: () => { state.step = "time"; state.notice = ""; render(); } }, "Choose another time"),
    ];
  }

  function doneView() {
    const result = state.result;
    return [
      h("div", { class: "booker-done" },
        h("h2", { tabindex: "-1", "data-focus": true }, "You're booked"),
        h("p", {}, `${longDay.format(new Date(result.startsAt))}, ${timeLabel.format(new Date(result.startsAt))} – ${timeLabel.format(new Date(result.endsAt))}`),
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
    phone: "Please use international format, starting with +.",
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

  function normalizedPhone() {
    const phone = state.form.phone.replace(/[\s().-]/g, "");
    return phone === "" ? null : phone;
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
    if (status !== 200 || !body) {
      state.page = null;
      state.notice = status === 429 ? "Too many requests. Please try again shortly." : "This booking page is not available.";
      return false;
    }
    state.page = body;
    if (!body.resources.some((resource) => resource.id === state.resourceId)) state.resourceId = body.resources[0] ? body.resources[0].id : null;
    return true;
  }

  async function loadSlots(rerender = true) {
    if (!state.resourceId) { state.slots = []; if (rerender) render(); return; }
    const from = new Date();
    const to = new Date(from.getTime() + RANGE_DAYS * 86400000);
    const query = new URLSearchParams({ resourceId: state.resourceId, from: from.toISOString(), to: to.toISOString() });
    const { status, body } = await getJson(`/public/v1/pages/${match[1]}/slots?${query}`);
    if (status === 200 && body) state.slots = body.slots;
    else if (status === 429) state.notice = "Too many requests. Please try again shortly.";
    if (rerender) render();
  }

  async function start() {
    if (!match) { state.notice = "This booking page is not available."; render(); return; }
    if (await loadPage()) await loadSlots(false);
    render();
    // Free times go stale while the page is open: refetch on focus and on a timer.
    const refresh = async () => {
      // An attempt in flight or unconfirmed may hold the slot itself; its retry reconciles first.
      if (!state.page || state.step === "done" || state.submitting || state.attempt) return;
      await loadSlots(false);
      // Re-rendering the form would drop the visitor's focus; only do it when the slot was lost.
      if (state.step !== "details" || !stillAvailable()) render();
    };
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refresh(); });
    window.addEventListener("focus", refresh);
    setInterval(refresh, REFRESH_MS);
    if (embedded && "ResizeObserver" in window) new ResizeObserver(postHeight).observe(document.documentElement);
  }

  start();
})();
