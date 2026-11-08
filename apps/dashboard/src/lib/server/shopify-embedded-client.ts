/**
 * The script the embedded page runs inside the Shopify admin (docs/requirements/connections.md C-21). It is plain
 * JavaScript in a string, not a React bundle: the embedded page must load App Bridge as the first script, carry its
 * own frame-ancestors policy and set no cookie, so it is a route handler (app/shopify/app/route.ts) and not a page
 * under the dashboard's layout. The script takes its four globals as parameters so a test can run it against a fake
 * document (test/shopify-embedded.test.ts).
 *
 * Every call carries a fresh App Bridge session token in `Authorization: Bearer`. The script never stores one and
 * never writes dynamic text as markup: it sets `textContent` only.
 */
export const EMBEDDED_CLIENT_PARAMS = ["document", "window", "fetch", "shopify"] as const;

export const EMBEDDED_CLIENT_SOURCE = String.raw`
"use strict";
var root = document.getElementById("app");
var API = "/api/shopify/";

function el(tag, text, attrs) {
  var node = document.createElement(tag);
  if (text) node.textContent = text;
  if (attrs) for (var key in attrs) node.setAttribute(key, attrs[key]);
  return node;
}
var screen = 0;
var frozen = false;
// A person's action in place (typing a code, creating a hub) ends the plan polling and drops any read still in flight.
function interact() { screen += 1; frozen = true; }
function show() {
  screen += 1;
  frozen = false;
  var nodes = Array.prototype.slice.call(arguments);
  root.replaceChildren.apply(root, nodes);
  var heading = root.querySelector ? root.querySelector("h1") : null;
  if (heading && heading.focus) heading.focus();
}
function button(label, onClick, kind) {
  var node = el("button", label, { type: "button", class: kind === "secondary" ? "btn secondary" : "btn" });
  node.addEventListener("click", onClick);
  return node;
}
function note(text, tone) { return el("p", text, { class: "note " + (tone || "info"), role: tone === "error" ? "alert" : "status" }); }
function title(text) { return el("h1", text, { tabindex: "-1" }); }

function send(op, body) {
  return Promise.resolve(shopify.idToken()).then(function (token) {
    return fetch(API + op, {
      method: "POST",
      headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer"
    });
  });
}

// A 401 means the session token was stale: ask App Bridge for a fresh one and retry once (shopify.dev session-tokens).
function call(op, body) {
  return send(op, body).then(function (response) {
    return response.status === 401 ? send(op, body) : response;
  }).then(function (response) {
    if (response.status === 401) return { outcome: "invalid_token" };
    if (response.status === 429) return { outcome: "unavailable" };
    if (!response.ok) return { outcome: "unavailable" };
    return response.json();
  }).catch(function () { return { outcome: "unavailable" }; });
}

var SHOP_TROUBLE = {
  invalid_token: "Your Shopify session expired. Reload this page to continue.",
  unavailable: "ZS Hub is not reachable right now. Try again in a minute.",
  busy: "Another change is in progress. Try again in a few seconds.",
  not_supported: "This store cannot use the app yet."
};

function trouble(outcome) {
  var message = SHOP_TROUBLE[outcome] || SHOP_TROUBLE.unavailable;
  var again = outcome === "invalid_token" ? button("Reload", function () { window.location.reload(); }) : button("Try again", start);
  show(title("ZS Business Connections"), note(message, "error"), again);
}

function shopBlock(shop) {
  var block = el("div", null, { class: "shop" });
  block.appendChild(el("p", shop.name, { class: "shop-name" }));
  block.appendChild(el("p", shop.domain, { class: "shop-domain" }));
  return block;
}

function openHub(status) {
  interact();
  // Open the tab first, while the click still counts as a person's action, and point it at the link when it arrives.
  var tab = window.open("", "_blank");
  if (tab) { try { tab.opener = null; } catch (error) { /* a cross-origin tab refuses; the link below still works */ } }
  status.textContent = "Opening your hub...";
  call("sign-in").then(function (result) {
    if (result.outcome === "ok") {
      if (tab) { tab.location.href = result.url; status.textContent = "Your hub opened in a new tab."; }
      else {
        var link = el("a", "Continue to ZS Hub", { href: result.url, target: "_blank", rel: "noopener noreferrer", class: "btn" });
        status.replaceChildren(link);
      }
      return;
    }
    if (tab) tab.close();
    status.textContent = result.outcome === "not_owner"
      ? "Only the store owner can open the hub from here. Ask the owner, or sign in to the hub directly."
      : result.outcome === "invalid_token" ? SHOP_TROUBLE.invalid_token
      : result.outcome === "not_available" ? "This store is not linked to a hub yet. Reload this page."
      : SHOP_TROUBLE.unavailable;
  });
}

// C-29: Shopify's plan selection page, only when the API sent a Shopify admin address (never a URL from anywhere else).
var PLAN_URL_PREFIX = "https://admin.shopify.com/store/";
var WELCOME_POLL_MS = 15000;
var WELCOME_WINDOW_MS = 600000;
var welcomeDeadline = null;
var welcomeTimer = null;
var lastOpen = null;
function nowMs() { return (window.Date || Date).now(); }
function planLink(open, label, kind) {
  var url = open.planUrl;
  if (typeof url !== "string" || url.indexOf(PLAN_URL_PREFIX) !== 0) return null;
  // target _top leaves the admin iframe; Shopify allows it from a click.
  return el("a", label, { href: url, target: "_top", class: kind === "secondary" ? "btn secondary" : "btn", "data-testid": "plan-link" });
}
// Shopify appends plan_handle, shop, host and embedded to the welcome link; only the plan=welcome pair matters.
function cameFromPlanPage() {
  var search = (window.location && window.location.search) || "";
  return /(^|[?&])plan=welcome(&|$)/.test(search);
}
function confirmingPlan() {
  if (!cameFromPlanPage()) return false;
  if (welcomeDeadline === null) welcomeDeadline = nowMs() + WELCOME_WINDOW_MS;
  return nowMs() < welcomeDeadline;
}
function scheduleWelcome() {
  if (welcomeTimer !== null) window.clearTimeout(welcomeTimer);
  welcomeTimer = window.setTimeout(refreshPlan, WELCOME_POLL_MS);
}
// Only a store linked to a hub has a plan to show: the hub tracks the plan from the link on (plans.md PL-17, PL-18).
// canConfirm is false right after the hub is made, because the welcome link cannot belong to a plan chosen before the hub existed.
function planBlock(open, canConfirm) {
  lastOpen = open;
  var plan = open.plan || { state: "none" };
  var block = el("div", null, { class: "plan", "data-testid": "plan-state" });
  if (plan.state === "active" || plan.state === "trial") {
    block.appendChild(el("p", plan.state === "trial" ? "Plan: " + plan.name + " (free trial)" : "Plan: " + plan.name, { class: "plan-name" }));
    var change = planLink(open, "Change plan", "secondary");
    if (change) { var row = el("div", null, { class: "actions" }); row.appendChild(change); block.appendChild(row); }
    return block;
  }
  if (canConfirm !== false && confirmingPlan()) {
    block.appendChild(el("p", "Confirming your plan...", { class: "badge neutral", "data-testid": "plan-confirming" }));
    block.appendChild(el("p", "Shopify has your choice. It can take a few minutes to show here.", { class: "help" }));
    scheduleWelcome();
    return block;
  }
  block.appendChild(el("p", "No plan yet", { class: "badge warn" }));
  var choose = planLink(open, "Choose a plan");
  if (choose) { var actions = el("div", null, { class: "actions" }); actions.appendChild(choose); block.appendChild(actions); }
  return block;
}
function refreshPlan() {
  welcomeTimer = null;
  // Only while the "confirming" screen is on show and untouched; a form or a running action stops the polling.
  if (frozen || !root.querySelector || !root.querySelector(".plan")) return;
  var generation = screen;
  call("open").then(function (open) {
    if (generation !== screen || frozen) return;
    if (open.outcome === "ok") return showOpen(open);
    // A failed read keeps the last good result and tries again; past the deadline the same result renders as "Choose a plan".
    if (confirmingPlan()) scheduleWelcome();
    else if (lastOpen) showOpen(lastOpen);
  });
}
function showOpen(open) {
  if (open.link.state === "linked") return renderLinked(open);
  renderChoice(open);
}

function renderLinked(open) {
  var status = el("p", null, { class: "note info", role: "status" });
  var needsRenewal = open.link.connection === "reauthorize";
  show(
    title("ZS Business Connections"),
    shopBlock(open.shop),
    planBlock(open),
    el("p", needsRenewal ? "Reconnect needed" : "Connected", { class: "badge " + (needsRenewal ? "warn" : "ok"), "data-testid": "link-state" }),
    el("p", needsRenewal
      ? "Shopify access for " + open.link.businessName + " needs to be renewed. Open your hub to reconnect."
      : "This store is connected to " + open.link.businessName + ". Your agents there can read this store's orders. Nothing in your store is changed."),
    button("Open ZS Hub", function () { openHub(status); }),
    status
  );
}

function renderCreated(result) {
  show(
    title("Your hub is ready"),
    note("We made a ZS Hub called " + result.businessName + " for " + result.ownerEmail + ". Open it to sign in with that address.", "info"),
    button("Open ZS Hub", function () {
      var status = el("p", null, { class: "note info", role: "status" });
      openHub(status);
      root.appendChild(status);
    })
  );
  // The hub now tracks this store's plan (PL-17): read it again and offer Choose a plan next to the hub link.
  var generation = screen;
  call("open").then(function (open) {
    if (generation !== screen || open.outcome !== "ok") return;
    root.appendChild(planBlock(open, false));
  });
}

var CREATE_TROUBLE = {
  not_owner: "Only the store owner can create a hub. Ask the owner to open this app.",
  email_has_hub: "The owner's email already has a ZS Hub. Choose I already have a hub, and link this store with a code.",
  store_in_use: "This store is already linked to another hub.",
  not_installed: "The app is not fully installed on this store yet. Reload this page.",
  invalid_token: SHOP_TROUBLE.invalid_token,
  unavailable: SHOP_TROUBLE.unavailable
};

function createHub(statusNode, buttons) {
  interact();
  buttons.forEach(function (node) { node.disabled = true; });
  statusNode.textContent = "Creating your hub...";
  call("create-hub").then(function (result) {
    if (result.outcome === "created" || result.outcome === "relinked") return renderCreated(result);
    if (result.outcome === "already_linked") return start();
    buttons.forEach(function (node) { node.disabled = false; });
    statusNode.textContent = CREATE_TROUBLE[result.outcome] || SHOP_TROUBLE.unavailable;
  });
}

function renderCode(open) {
  var input = el("input", null, { id: "claim-code", type: "text", inputmode: "text", autocomplete: "off", autocapitalize: "characters", spellcheck: "false", maxlength: "16", "aria-describedby": "claim-help" });
  var status = el("p", null, { class: "note info", role: "status" });
  var submit = button("Link this store", function () {
    interact();
    submit.disabled = true;
    status.textContent = "Checking the code...";
    call("redeem-claim", { code: input.value }).then(function (result) {
      submit.disabled = false;
      if (result.outcome === "redeemed") {
        show(title("Almost done"), note("The code worked for " + result.businessName + ". Now go back to your hub, open Account, then Connections, and choose Confirm link.", "info"));
        return;
      }
      if (result.outcome === "locked") {
        var minutes = Math.max(1, Math.ceil((result.retryAfterSeconds || 60) / 60));
        status.textContent = "Too many wrong codes. Try again in " + minutes + (minutes === 1 ? " minute." : " minutes.");
        return;
      }
      status.textContent = result.outcome === "invalid_code" ? "That code is not right, or it expired. Check it in your hub and try again."
        : result.outcome === "not_owner" ? "Only the store owner can link this store."
        : result.outcome === "already_linked" ? "This store is already linked."
        : result.outcome === "not_installed" ? "The app is not fully installed on this store yet. Reload this page."
        : result.outcome === "invalid_token" ? SHOP_TROUBLE.invalid_token
        : SHOP_TROUBLE.unavailable;
    });
  });
  var back = button("Back", function () { renderChoice(open); }, "secondary");
  show(
    title("Link to your hub"),
    el("p", "In your ZS Hub, open Account, then Connections, and choose Link a Shopify store. Enter the code it shows here."),
    el("label", "Code from your hub", { for: "claim-code" }),
    input,
    el("p", "Ten letters and numbers. It works once and expires in 15 minutes.", { id: "claim-help", class: "help" }),
    el("div", null, { class: "actions" }),
    status
  );
  var actions = root.querySelector ? root.querySelector(".actions") : null;
  if (actions) { actions.appendChild(submit); actions.appendChild(back); } else { root.appendChild(submit); root.appendChild(back); }
}

function renderChoice(open) {
  var status = el("p", null, { class: "note info", role: "status" });
  var make = button("Create my ZS Hub", function () { createHub(status, [make, have]); });
  var have = button("I already have a hub", function () { renderCode(open); }, "secondary");
  var actions = el("div", null, { class: "actions" });
  actions.appendChild(make);
  actions.appendChild(have);
  show(
    title("ZS Business Connections"),
    shopBlock(open.shop),
    el("p", "Not linked to a ZS Hub yet", { class: "badge neutral", "data-testid": "link-state" }),
    el("p", "ZS Hub lets your agents read this store's orders. It asks Shopify for read-only access to orders and cannot change anything in your store."),
    el("p", "New here? We make a hub for the store owner's email. Already have one? Link this store with a code."),
    actions,
    status
  );
}

function start() {
  if (window.top === window.self) {
    show(title("ZS Business Connections"), note("Open this app from your Shopify admin: choose Apps, then ZS Business Connections.", "info"));
    return;
  }
  show(title("ZS Business Connections"), note("Connecting to your store...", "info"));
  call("open").then(function (open) {
    if (open.outcome !== "ok") return trouble(open.outcome);
    if (open.link.state === "linked") return renderLinked(open);
    renderChoice(open);
  });
}

start();
`;
