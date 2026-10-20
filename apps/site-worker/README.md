# @zs/site-worker

The dispatch Worker. One deployment serves the live release of every tenant site, chosen by
the request's `Host` header. It only reads; the API writes the objects it serves.

## Object layout

All objects live in one R2 bucket, bound as `SITES`. Keys come from `siteObjectKeys` in
`@zs/contracts`.

- `hosts/<host>`: the host pointer, JSON naming the tenant, site and live release.
- `t/<tenant>/releases/<release>/manifest.json`: the release's file table (path, media type,
  SHA-256, byte count). A release never changes.
- `t/<tenant>/blobs/<sha256>`: one file's bytes, stored once per tenant.

Each request reads the pointer once and answers every file from that one manifest, so a
request never mixes two releases. Blob keys are built from the pointer's tenant and the file's
digest only, so one tenant's host can never read another tenant's objects.

## Paths

- `/` serves the manifest's entry file.
- `/a/b/` serves `a/b/index.html`.
- `/a/b` serves `a/b`, else `a/b.html`, else `a/b/index.html`.
- An unknown path serves the release's `404.html` with status 404, or a plain 404.

## Status codes

- 200: a file. It carries `etag` (the quoted SHA-256), `cache-control: public, max-age=0,
  must-revalidate`, `x-content-type-options: nosniff` and
  `referrer-policy: strict-origin-when-cross-origin`.
- 304: `If-None-Match` matches the file's etag. The blob is not read.
- 400: the path has malformed percent-encoding.
- 404: the host is not a valid DNS name, has no pointer, or the path is unknown. Paths with
  empty, `.` or `..` segments, or segments that decode to a slash, are unknown.
- 405: a method other than GET or HEAD. The response has `allow: GET, HEAD`.
- 502: the published objects are broken. The pointer is not valid JSON or names another host;
  the manifest is missing, malformed, or names another tenant, site or release; or a blob is
  missing or its size differs from the manifest. HEAD reads the blob too, so it answers as GET.
- 500: any other error, such as the bucket failing. The text is fixed.

Error bodies are fixed plain text with `cache-control: no-store`.

## Deploying (on the Mac)

Cloud sessions never deploy. On the Mac:

1. Create the R2 bucket the API writes site objects to.
2. Copy `wrangler.toml.example` to `wrangler.toml` and set `bucket_name` for the `SITES`
   binding.
3. Route tenant domains to the Worker: a Workers route for our own zones, or Cloudflare for
   SaaS Custom Hostnames for tenant domains.
4. Run `wrangler deploy` from this folder.

## Tests

`pnpm --filter @zs/site-worker test` runs the handler against the in-memory store from
`@zs/core` and the R2 adapter against a small fake bucket.
