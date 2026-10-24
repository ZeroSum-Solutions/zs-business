// A supplier portal on loopback, for the tests and the pilot Mac's dry run (browser-tasks.md,
// Acceptance test). It is a real HTTP server, so the fake runner's requests really cross a socket
// and the request log shows exactly what reached it. Nothing here touches the network beyond 127.0.0.1.
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface FixtureInvoice {
  readonly name: string;
  readonly bytes: Uint8Array;
}
export interface FixtureSiteOptions {
  readonly username: string;
  readonly password: string;
  readonly invoices: readonly FixtureInvoice[];
  /** Extra HTML placed on the invoice list page: the trap links, buttons and forms of a test. `{{outside}}` becomes the other origin. */
  readonly listExtraHtml?: string;
}
export interface FixtureRequest {
  readonly method: string;
  readonly path: string;
  readonly query: string;
}
export interface FixtureSite {
  /** The allowed origin: `http://127.0.0.1:<port>`. */
  readonly origin: string;
  /** The same server under another host name, so a link to it leaves the allowed origin. */
  readonly outsideOrigin: string;
  readonly requests: FixtureRequest[];
  /** Requests that reached the delete endpoint (any method). The read-only task must leave this at zero. */
  deleteHits(): number;
  /** Requests that reached the outside origin's host name. */
  outsideHits(): number;
  close(): Promise<void>;
}

/** A small valid-looking PDF; the runner checks the `%PDF-` magic and the size, nothing more. */
export function fixturePdf(label: string): Uint8Array {
  return new TextEncoder().encode(`%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n% ${label}\ntrailer<</Root 1 0 R>>\n%%EOF\n`);
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function startFixtureSite(options: FixtureSiteOptions): Promise<FixtureSite> {
  const requests: FixtureRequest[] = [];
  let deleteHits = 0;
  let outsideHits = 0;
  let origin = "";
  let outsideOrigin = "";
  const server: Server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture.invalid");
    const method = request.method ?? "GET";
    if ((request.headers.host ?? "").startsWith("localhost")) outsideHits += 1;
    requests.push({ method, path: url.pathname, query: url.search });
    const signedIn = /(?:^|; )sid=ok(?:;|$)/.test(request.headers.cookie ?? "");
    const send = (status: number, type: string, body: string | Uint8Array, headers: Record<string, string> = {}) => {
      response.writeHead(status, { "content-type": type, ...headers });
      response.end(body);
    };
    if (url.pathname.startsWith("/delete")) { deleteHits += 1; return send(200, "text/plain", "deleted"); }
    if (url.pathname === "/login" && method === "GET")
      return send(200, "text/html", `<html><body><h1>Supplier portal</h1>
<form method="post" action="/login"><input name="username"><input name="password" type="password"><button>Sign in</button></form></body></html>`);
    if (url.pathname === "/login" && method === "POST") {
      const form = new URLSearchParams(await readBody(request));
      if (form.get("username") !== options.username || form.get("password") !== options.password)
        return send(401, "text/html", "<html><body>Wrong sign-in</body></html>");
      return send(303, "text/plain", "", { location: "/invoices", "set-cookie": "sid=ok; Path=/; HttpOnly" });
    }
    if (url.pathname === "/invoices" && method === "GET") {
      if (!signedIn) return send(302, "text/plain", "", { location: "/login" });
      const links = options.invoices
        .map((invoice) => `<li><a href="/invoices/${invoice.name}">${invoice.name}</a></li>`).join("\n");
      const extra = (options.listExtraHtml ?? "").replaceAll("{{outside}}", outsideOrigin);
      return send(200, "text/html", `<html><body><h1>Invoices ${url.searchParams.get("month") ?? ""}</h1>
<form method="get" action="/invoices"><input name="month"><button>Filter</button></form>
<ul>${links}</ul>${extra}</body></html>`);
    }
    const invoice = /^\/invoices\/([^/]+)$/.exec(url.pathname);
    if (invoice && method === "GET") {
      const found = options.invoices.find((entry) => entry.name === invoice[1]);
      if (!signedIn || !found) return send(404, "text/plain", "not found");
      return send(200, "application/pdf", found.bytes);
    }
    return send(404, "text/plain", "not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  origin = `http://127.0.0.1:${port}`;
  outsideOrigin = `http://localhost:${port}`;
  return {
    origin, outsideOrigin, requests,
    deleteHits: () => deleteHits,
    outsideHits: () => outsideHits,
    close: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections();
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}
