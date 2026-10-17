# Licences and sources (read before using outside code)

| Source | Licence | Rule |
|---|---|---|
| cal.diy `~/projects/tools/third-party/cal.diy` | MIT | May read and port. Keep the MIT notice in `NOTICE` and a header in each ported file. Never import Prisma, tRPC or cal.diy packages. |
| Activepieces community pieces `~/projects/tools/third-party/activepieces/packages/pieces/community` | MIT | May read and port with the notice. Never read or copy any `ee/` directory. |
| rise-scheduler `~/projects/rise-scheduler` | ours | May read and reuse. Read-only from here; it is a live client system. |
| Mish `~/projects/mish` | ours, Apache-2.0, public | May read. Do not add business contracts or plans to it. |
| Cloudflare agents, vibesdk (MIT), web-bot-auth (Apache-2.0) | permissive | Study only until a measured need. |
| SeldonFrame | AGPL-3.0 | **Dropped (Devin, 2026-10-17); we build these parts ourselves.** Behaviour study is allowed: use the local running instance at `http://localhost:3000` like a user (click through, screenshots, note what it does). Never open its source folder `~/projects/tools/third-party/seldonframe`, never read its JS bundles or scripts (no REA `analyze_web_bundle`, `export_web_scripts`, `recover_javascript_sources`, `observe_web_execution` script bodies), never copy its UI text, names or assets. Write what you learn as requirements in our own words. |
| HighLevel | proprietary SaaS | Behaviour notes and help docs only. Never copy its code, bundles, text or assets. |

Behaviour (what a product does) is free to study and rebuild; code, text and assets are not.
Reading a source and then writing a "spec" from it does not make a clean room. Write
requirements in our own words from behaviour and product needs. A similarity scan against
each MIT source runs before any port lands.
