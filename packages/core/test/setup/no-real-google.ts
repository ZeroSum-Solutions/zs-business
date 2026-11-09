// Outreach sequencer OS-25: no test reaches Google. This replaces the global `fetch` for every host in google.com or
// googleapis.com with a function that throws `real_google_call_in_test`; any other host (a loopback fake server) goes
// through. Adapter tests pass their own stubbed `fetch` and never touch the global one.
const real = globalThis.fetch.bind(globalThis);
const BLOCKED = ["google.com", "googleapis.com"];

function hostOf(input: Parameters<typeof fetch>[0]): string {
  try {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const host = hostOf(input);
  if (BLOCKED.some((domain) => host === domain || host.endsWith(`.${domain}`))) throw new Error("real_google_call_in_test");
  return real(input, init);
}) as typeof fetch;
