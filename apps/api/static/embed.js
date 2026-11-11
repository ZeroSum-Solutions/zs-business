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
  const frames = new Set();
  // P-16: the host page themes the booker with these custom properties, set on the
  // [data-zs-booking] element or any ancestor. Each is forwarded as a query parameter; the
  // booking page validates every value itself, so this file only bounds the length.
  const THEME = ["bg", "surface", "text", "muted", "accent", "accent-text", "border", "link", "error", "radius", "font"];

  function themeParams(element, query) {
    const style = typeof getComputedStyle === "function" ? getComputedStyle(element) : null;
    if (!style) return;
    for (const name of THEME) {
      const value = style.getPropertyValue(`--zs-booking-${name}`).trim();
      if (value && value.length <= 200) query.set(name, value);
    }
  }

  function mount(element) {
    if (element.getAttribute("data-zs-booking-mounted") === "1") return;
    const key = element.getAttribute("data-zs-booking") || "";
    if (!KEY.test(key)) return;
    element.setAttribute("data-zs-booking-mounted", "1");
    const frame = document.createElement("iframe");
    const query = new URLSearchParams({ embed: "1", channel: "widget" });
    themeParams(element, query);
    if (element.getAttribute("data-zs-header") === "hidden") query.set("header", "0");
    frame.src = `${origin}/book/${key}?${query}`;
    frame.title = element.getAttribute("data-zs-title") || "Book an appointment";
    frame.style.width = "100%";
    frame.style.minHeight = "480px";
    frame.style.border = "0";
    frame.style.display = "block";
    element.replaceChildren(frame);
    frames.add(frame);
  }

  // Only height messages from our own origin and from a frame we created resize anything.
  window.addEventListener("message", (event) => {
    if (event.origin !== origin) return;
    const data = event.data;
    if (!data || data.type !== "zs-booking:height" || typeof data.height !== "number" || !Number.isFinite(data.height)) return;
    for (const frame of frames)
      if (frame.contentWindow === event.source) {
        // The 480 px floor only holds space until the page reports its own height (P-16).
        frame.style.minHeight = "0";
        frame.style.height = `${Math.min(Math.max(Math.round(data.height), 160), 4000)}px`;
      }
  });

  const scan = () => document.querySelectorAll("[data-zs-booking]").forEach(mount);
  // Single-page sites add the element after this script ran (client-side navigation): watch for it.
  const watch = () => {
    scan();
    if (typeof MutationObserver === "function") new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", watch);
  else watch();
})();
