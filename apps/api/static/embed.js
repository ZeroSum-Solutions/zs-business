// Zero Sum booking widget (public-intake.md P-14). Original code. Paste
//   <div data-zs-booking="KEY"></div><script src="https://<api>/embed.js" async></script>
// and each marked element becomes an iframe of the hosted booking page. The iframe keeps the
// booking on the API origin: the host page never sees visitor input and needs no CORS.
(() => {
  "use strict";
  const script = document.currentScript;
  if (!script || !script.src) return;
  const origin = new URL(script.src).origin;
  const KEY = /^zsb1_[A-Za-z0-9_-]{64}$/;
  // Loaded twice (two snippets on one page): the first copy does the work.
  const installed = (window.__zsBookingEmbed = window.__zsBookingEmbed || {});
  if (installed[origin]) return;
  installed[origin] = true;
  // Each frame we made, with the element it lives in and the key it was mounted with.
  const frames = new Map();
  const mountedKey = new WeakMap();
  // P-16: the host page themes the booker with these custom properties, set on the
  // [data-zs-booking] element or any ancestor. Each is forwarded as a query parameter; the
  // booking page validates every value itself, so this file only bounds the length.
  const THEME = ["bg", "surface", "text", "muted", "accent", "accent-text", "border", "link", "error", "radius", "font"];
  const DEFAULT_FLOOR = 480;

  function themeParams(element, query) {
    const style = typeof getComputedStyle === "function" ? getComputedStyle(element) : null;
    if (!style) return;
    for (const name of THEME) {
      const value = style.getPropertyValue(`--zs-booking-${name}`).trim();
      if (value && value.length <= 200) query.set(name, value);
    }
  }

  /** The frame's minimum height: 480 px unless the host opts into a smaller one (P-16). */
  function floorOf(element) {
    const asked = Number.parseInt(element.getAttribute("data-zs-min-height") || "", 10);
    return Number.isFinite(asked) ? Math.min(Math.max(asked, 160), DEFAULT_FLOOR) : DEFAULT_FLOOR;
  }

  function ours(element) {
    for (const [frame, host] of frames) if (host === element && frame.isConnected && element.contains(frame)) return true;
    return false;
  }

  function mount(element) {
    if (ours(element)) return;
    // A host that re-rendered the element's children gets the widget back with the key it
    // was first mounted with; a key written into an already mounted element is not followed.
    const key = mountedKey.get(element) || element.getAttribute("data-zs-booking") || "";
    if (!KEY.test(key)) return;
    mountedKey.set(element, key);
    element.setAttribute("data-zs-booking-mounted", "1");
    const frame = document.createElement("iframe");
    const query = new URLSearchParams({ embed: "1", channel: "widget" });
    themeParams(element, query);
    if (element.getAttribute("data-zs-header") === "hidden") query.set("header", "0");
    frame.src = `${origin}/book/${key}?${query}`;
    frame.title = element.getAttribute("data-zs-title") || "Book an appointment";
    frame.style.width = "100%";
    frame.style.minHeight = `${floorOf(element)}px`;
    frame.style.border = "0";
    frame.style.display = "block";
    element.replaceChildren(frame);
    frames.set(frame, element);
  }

  // Only height messages from our own origin and from a frame we created resize anything.
  window.addEventListener("message", (event) => {
    if (event.origin !== origin) return;
    const data = event.data;
    if (!data || data.type !== "zs-booking:height" || typeof data.height !== "number" || !Number.isFinite(data.height)) return;
    for (const frame of frames.keys())
      if (frame.contentWindow === event.source) frame.style.height = `${Math.min(Math.max(Math.round(data.height), 160), 4000)}px`;
  });

  function scan() {
    // Frames the host removed are forgotten, so a single-page site does not keep them alive.
    for (const frame of [...frames.keys()]) if (!frame.isConnected) frames.delete(frame);
    document.querySelectorAll("[data-zs-booking]").forEach(mount);
  }

  // Single-page sites add the element, or its attribute, after this script ran: watch for both.
  const watch = () => {
    scan();
    if (typeof MutationObserver === "function")
      new MutationObserver(scan).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-zs-booking"] });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", watch);
  else watch();
})();
