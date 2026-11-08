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
// Each show() is a new screen. A late answer for an earlier screen is dropped by comparing this number.
var screen = 0;
// The plan block on the current screen, or null. Only show() replaces the screen; a plan read updates this node alone,
// so polling never moves focus or re-announces the page (C-29).
var planNode = null;
// Actions running in place (opening the hub). Plan polling waits while one runs.
var acting = 0;
// Ends the orders read in flight (C-30), or null when none runs.
var stopOrders = null;
function show() {
  screen += 1;
  planNode = null;
  // A new screen ends the orders read of the old one (C-30): its request is aborted, not left to finish unseen.
  if (stopOrders) { stopOrders(); stopOrders = null; }
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
function reload() { window.location.reload(); }

function send(op, body, signal) {
  return Promise.resolve(shopify.idToken()).then(function (token) {
    var init = {
      method: "POST",
      headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer"
    };
    if (signal) init.signal = signal;
    return fetch(API + op, init);
  });
}

function retryAfterMs(response) {
  var value = response.headers && response.headers.get ? response.headers.get("retry-after") : null;
  return value && /^\d{1,6}$/.test(value) ? Number(value) * 1000 : 0;
}

// A 401 means the session token was stale: ask App Bridge for a fresh one and retry once (shopify.dev session-tokens).
function call(op, body, signal) {
  return send(op, body, signal).then(function (response) {
    return response.status === 401 ? send(op, body, signal) : response;
  }).then(function (response) {
    if (response.status === 401) return { outcome: "invalid_token" };
    if (response.status === 429) return { outcome: "unavailable", retryAfterMs: retryAfterMs(response) };
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
  var again = outcome === "invalid_token" ? button("Reload", reload) : button("Try again", start);
  show(title("ZS Business Connections"), note(message, "error"), again);
}

function shopBlock(shop) {
  var block = el("div", null, { class: "shop" });
  block.appendChild(el("p", shop.name, { class: "shop-name" }));
  block.appendChild(el("p", shop.domain, { class: "shop-domain" }));
  return block;
}

function openHub(status) {
  acting += 1;
  // Open the tab first, while the click still counts as a person's action, and point it at the link when it arrives.
  var tab = window.open("", "_blank");
  if (tab) { try { tab.opener = null; } catch (error) { /* a cross-origin tab refuses; the link below still works */ } }
  status.textContent = "Opening your hub...";
  call("sign-in").then(function (result) {
    acting -= 1;
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

// ---- C-29: the plan ------------------------------------------------------------------------------
// Shopify's plan selection page, only when the API sent a Shopify admin address (never a URL from anywhere else).
var PLAN_URL_PREFIX = "https://admin.shopify.com/store/";
var WELCOME_POLL_MS = 30000;
var WELCOME_WINDOW_MS = 600000;
function nowMs() { return (window.Date || Date).now(); }
// Shopify appends plan_handle, shop, host and embedded to the welcome link; only the plan=welcome pair matters.
function cameFromPlanPage() {
  var search = (window.location && window.location.search) || "";
  return /(^|[?&])plan=welcome(&|$)/.test(search);
}
// One absolute deadline, taken at load. A timer ends the confirming state at the deadline even while a read hangs.
var welcome = cameFromPlanPage();
var welcomeDeadline = nowMs() + WELCOME_WINDOW_MS;
var welcomeTimer = null;
var reading = false;
var lastOpen = null;
if (welcome) window.setTimeout(endWelcome, WELCOME_WINDOW_MS);

function confirmingPlan() { return welcome && nowMs() < welcomeDeadline; }
// A store seen without a hub on this page cannot have chosen a plan the hub tracks (plans.md PL-17, PL-18):
// the welcome link is void for the rest of the page, whatever the later answers say.
function noteLink(open) { if (open.link.state !== "linked") welcome = false; }
function endWelcome() {
  welcome = false;
  stopPolling();
  // Only a block still saying "Confirming" turns into the last good answer; a reload prompt stays.
  if (planNode && lastOpen && typeof planNode.planKey === "string" && planNode.planKey.indexOf("confirming|") === 0) setPlan(planNode, lastOpen);
}
function stopPolling() {
  if (welcomeTimer !== null) window.clearTimeout(welcomeTimer);
  welcomeTimer = null;
}
function schedulePlan(waitMs) {
  stopPolling();
  if (!confirmingPlan() || !planNode) return;
  welcomeTimer = window.setTimeout(refreshPlan, Math.max(WELCOME_POLL_MS, waitMs || 0));
}

function planLink(open, label, kind) {
  var url = open.planUrl;
  if (typeof url !== "string" || url.indexOf(PLAN_URL_PREFIX) !== 0) return null;
  // target _top leaves the admin iframe; Shopify allows it from a click.
  return el("a", label, { href: url, target: "_top", class: kind === "secondary" ? "btn secondary" : "btn", "data-testid": "plan-link" });
}
function withLink(nodes, link) {
  if (link) { var row = el("div", null, { class: "actions" }); row.appendChild(link); nodes.push(row); }
  return nodes;
}
// Fills a plan block from an open answer and says which state it shows. An unchanged state leaves the DOM alone.
function setPlan(node, open) {
  var plan = open.plan || { state: "none" };
  var nodes;
  var state;
  if (plan.state === "active" || plan.state === "trial") {
    state = "plan";
    nodes = withLink([el("p", plan.state === "trial" ? "Plan: " + plan.name + " (free trial)" : "Plan: " + plan.name, { class: "plan-name" })], planLink(open, "Change plan", "secondary"));
  } else if (confirmingPlan()) {
    state = "confirming";
    nodes = [
      el("p", "Confirming your plan...", { class: "badge neutral", "data-testid": "plan-confirming" }),
      el("p", "Shopify has your choice. It can take a few minutes to show here.", { class: "help" })
    ];
  } else {
    state = "none";
    nodes = withLink([el("p", "No plan yet", { class: "badge warn" })], planLink(open, "Choose a plan"));
  }
  var key = state + "|" + (plan.name || "") + "|" + (open.planUrl || "");
  if (node.planKey !== key) { node.planKey = key; node.replaceChildren.apply(node, nodes); }
  return state;
}
function setPlanNote(node, text, action) {
  node.planKey = null;
  var nodes = [el("p", text, { class: "help" })];
  if (action) nodes.push(action);
  node.replaceChildren.apply(node, nodes);
}
function planShell() { return el("div", null, { class: "plan", "data-testid": "plan-state" }); }

// The welcome poll: one read at a time, waiting while an action runs or the tab is hidden, until the deadline.
function refreshPlan() {
  welcomeTimer = null;
  var node = planNode;
  if (!node || !confirmingPlan() || reading) return;
  if (acting > 0 || document.visibilityState === "hidden") return schedulePlan();
  reading = true;
  call("open").then(function (open) {
    reading = false;
    if (node !== planNode) return;
    if (open.outcome === "ok") {
      if (open.link.state !== "linked") { noteLink(open); stopPolling(); if (acting === 0) showOpen(open); else node.replaceChildren(); return; }
      lastOpen = open;
      if (setPlan(node, open) === "confirming") schedulePlan();
      return;
    }
    // A session App Bridge cannot renew does not heal by waiting: stop and ask for a reload.
    if (open.outcome === "invalid_token") { welcome = false; stopPolling(); if (acting === 0) trouble("invalid_token"); else setPlanNote(node, SHOP_TROUBLE.invalid_token, button("Reload", reload)); return; }
    // A failed read keeps the last good answer and tries again, no sooner than Retry-After.
    schedulePlan(open.retryAfterMs);
  });
}
function showOpen(open) {
  noteLink(open);
  if (open.link.state === "linked") return renderLinked(open);
  renderChoice(open);
}

// C-30: the read-only "Recent orders" view. Every value comes from the API as data and is set with textContent only.
function orderStatus(value) {
  if (typeof value !== "string" || value === "") return "-";
  var text = value.replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}
function orderDate(value) { return typeof value === "string" ? value.slice(0, 10) : "-"; }
// The amount stays a decimal string: Intl formats a string exactly, where Number() would round large amounts. It keeps
// every decimal Shopify sent (up to 6), never fewer than the currency's own.
function money(total) {
  if (!total) return "-";
  try {
    var amount = String(total.amount);
    var decimals = amount.indexOf(".") === -1 ? 0 : amount.length - amount.indexOf(".") - 1;
    var usual = new Intl.NumberFormat("en-US", { style: "currency", currency: total.currency }).resolvedOptions().maximumFractionDigits;
    return new Intl.NumberFormat("en-US", { style: "currency", currency: total.currency, minimumFractionDigits: Math.min(usual, 6), maximumFractionDigits: Math.max(usual, Math.min(decimals, 6)) }).format(amount);
  } catch (error) {
    return String(total.amount) + " " + String(total.currency);
  }
}
function ordersBlock(result) {
  var block = el("div", null, { class: "orders", "data-testid": "recent-orders" });
  block.appendChild(el("h2", "Recent orders"));
  if (result.outcome !== "ok" || !result.orders || !result.summary) {
    block.appendChild(note("Orders are not available right now.", "info"));
    return block;
  }
  if (result.orders.length === 0) {
    block.appendChild(el("p", "No orders in the last 60 days", { class: "help", "data-testid": "orders-empty" }));
    return block;
  }
  var count = result.summary.count;
  block.appendChild(el("p", count + (count === 1 ? " order" : " orders") + " in the last 60 days, total " + (result.summary.total ? money(result.summary.total) : "in more than one currency"), { class: "orders-summary", "data-testid": "orders-summary" }));
  var wrap = el("div", null, { class: "table-wrap", tabindex: "0", role: "region", "aria-label": "Recent orders" });
  var table = el("table", null, { class: "orders-table" });
  var head = el("tr");
  ["Order", "Date", "Payment", "Fulfillment", "Total"].forEach(function (label) { head.appendChild(el("th", label, { scope: "col" })); });
  table.appendChild(el("thead")).appendChild(head);
  var body = el("tbody");
  result.orders.forEach(function (order) {
    var row = el("tr");
    row.appendChild(el("th", String(order.name), { scope: "row" }));
    row.appendChild(el("td", orderDate(order.createdAt)));
    row.appendChild(el("td", orderStatus(order.displayFinancialStatus)));
    row.appendChild(el("td", orderStatus(order.displayFulfillmentStatus)));
    row.appendChild(el("td", money(order.total), { class: "num" }));
    body.appendChild(row);
  });
  table.appendChild(body);
  wrap.appendChild(table);
  block.appendChild(wrap);
  return block;
}
function ordersShell() { return el("section", null, { class: "orders-slot" }); }
// Read once a linked store is on screen. Only show() moves to another screen (Open ZS Hub does not), so an answer
// whose screen is still current always settles the slot; an answer for a screen that is gone is dropped.
// The read has its own deadline (longer than the dashboard's 12 s to the API): at it, the request is aborted and the
// slot settles into "not available", so a hung token or request never leaves "Loading recent orders...".
var ORDERS_DEADLINE_MS = 15000;
function loadOrders(slot) {
  if (stopOrders) stopOrders();
  var generation = screen;
  var done = false;
  var controller = typeof AbortController === "function" ? new AbortController() : null;
  var timer = window.setTimeout(function () { settle({ outcome: "unavailable" }); }, ORDERS_DEADLINE_MS);
  function stop() {
    done = true;
    window.clearTimeout(timer);
    if (controller) controller.abort();
  }
  function settle(result) {
    if (done) return;
    stop();
    if (stopOrders === stop) stopOrders = null;
    if (generation !== screen) return;
    slot.replaceChildren(ordersBlock(result));
  }
  stopOrders = stop;
  slot.replaceChildren(el("p", "Loading recent orders...", { class: "help", role: "status" }));
  call("orders", null, controller ? controller.signal : undefined).then(settle);
}

function renderLinked(open) {
  var status = el("p", null, { class: "note info", role: "status" });
  var needsRenewal = open.link.connection === "reauthorize";
  var plan = planShell();
  lastOpen = open;
  var ordersSlot = ordersShell();
  show(
    title("ZS Business Connections"),
    shopBlock(open.shop),
    plan,
    el("p", needsRenewal ? "Reconnect needed" : "Connected", { class: "badge " + (needsRenewal ? "warn" : "ok"), "data-testid": "link-state" }),
    el("p", needsRenewal
      ? "Shopify access for " + open.link.businessName + " needs to be renewed. Open your hub to reconnect."
      : "This store is connected to " + open.link.businessName + ". Your agents there can read this store's orders. Nothing in your store is changed."),
    button("Open ZS Hub", function () { openHub(status); }),
    status,
    ordersSlot
  );
  planNode = plan;
  if (setPlan(plan, open) === "confirming") schedulePlan();
  loadOrders(ordersSlot);
}

// The hub now tracks this store's plan (PL-17): read it again and offer Choose a plan next to the hub link. The same
// read confirms the link, so the recent orders (C-30) load from here too.
function loadCreatedPlan(node, ordersSlot) {
  call("open").then(function (open) {
    if (node !== planNode) return;
    if (open.outcome === "ok" && open.link.state === "linked") { lastOpen = open; setPlan(node, open); loadOrders(ordersSlot); return; }
    // Unlinked again (another session disconnected it): show the store as it is, not a plan block.
    if (open.outcome === "ok") { if (acting === 0) showOpen(open); else node.replaceChildren(); return; }
    if (open.outcome === "invalid_token") { setPlanNote(node, SHOP_TROUBLE.invalid_token, button("Reload", reload)); return; }
    setPlanNote(node, "Your plan could not be loaded just now.", button("Try again", function () {
      setPlanNote(node, "Checking your plan...");
      loadCreatedPlan(node, ordersSlot);
    }, "secondary"));
  });
}
function renderCreated(result) {
  var status = el("p", null, { class: "note info", role: "status" });
  var plan = planShell();
  var ordersSlot = ordersShell();
  show(
    title("Your hub is ready"),
    note("We made a ZS Hub called " + result.businessName + " for " + result.ownerEmail + ". Open it to sign in with that address.", "info"),
    button("Open ZS Hub", function () { openHub(status); }),
    status,
    plan,
    ordersSlot
  );
  planNode = plan;
  loadCreatedPlan(plan, ordersSlot);
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
  var generation = screen;
  buttons.forEach(function (node) { node.disabled = true; });
  statusNode.textContent = "Creating your hub...";
  call("create-hub").then(function (result) {
    if (generation !== screen) return;
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
    var generation = screen;
    submit.disabled = true;
    status.textContent = "Checking the code...";
    call("redeem-claim", { code: input.value }).then(function (result) {
      // The merchant chose Back while the code was checked: that screen is gone, so is this answer.
      if (generation !== screen) return;
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
  var generation = screen;
  call("open").then(function (open) {
    if (generation !== screen) return;
    if (open.outcome !== "ok") return trouble(open.outcome);
    showOpen(open);
  });
}

start();
`;
