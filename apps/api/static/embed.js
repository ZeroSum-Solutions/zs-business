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

  function mount(element) {
    if (element.getAttribute("data-zs-booking-mounted") === "1") return;
    const key = element.getAttribute("data-zs-booking") || "";
    if (!KEY.test(key)) return;
    element.setAttribute("data-zs-booking-mounted", "1");
    const frame = document.createElement("iframe");
    frame.src = `${origin}/book/${key}?embed=1&channel=widget`;
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
      if (frame.contentWindow === event.source) frame.style.height = `${Math.min(Math.max(Math.round(data.height), 320), 4000)}px`;
  });

  const scan = () => document.querySelectorAll("[data-zs-booking]").forEach(mount);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", scan);
  else scan();
})();
