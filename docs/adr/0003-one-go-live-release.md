# One go-live tap publishes the whole release, all or nothing

The first run ends with one Go live card. One tap approves one exact release (booking page, site and AEO files), bound by digest, rechecked under lock and published all or nothing. The app says "live" only after the release is actually public. ZAB's site and AEO producers draft behind the companion with tenant-scoped, draft-only access (ZSB-71); they never publish. Decided 2026-11-24 in ZSB-81 (Q11).

## Considered Options

- A tap per part (booking, then site, then AEO): rejected as friction and as a half-live state the owner must track.
