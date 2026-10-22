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

Projects in [integrations.md](integrations.md) (added 2026-10-22):

| Source | Licence | Rule |
|---|---|---|
| Treg (lead enrichment) | Apache-2.0, plus a clause against reselling it as a service | Use the hosted API only, through the enrichment port (`requirements/enrichment.md`). Never host Treg for tenants or resell it. |
| WhisperX | BSD-2-Clause | May run as a separate local service behind the transcription port. Keep the notice if any code is ported. |
| faster-whisper, CTranslate2, mlx-whisper; Whisper weights | MIT | May run behind the transcription port. Keep the notices if any code is ported. |
| torchaudio `WAV2VEC2_ASR_BASE_960H` (English aligner) | BSD-2-Clause code; weights from fairseq, MIT | May run behind the transcription port. Aligners for other languages need their licence checked first; non-commercial ones are forbidden. |
| Kokoro text-to-speech weights | Apache-2.0 | May run as the local voice for the receptionist. Check the licence of each voice pack before use. |
| pyannote `speaker-diarization-community-1` weights | CC-BY-4.0 | May use with attribution in `NOTICE`. The repo owner accepts the model gate as a setup step; agents never do. |
| Pipecat | BSD-2-Clause | May run as a separate service behind the voice port. Keep the notice if any code is ported. |
| ComfyUI | GPL-3.0 | Run unmodified as a separate service behind the image port. Never bundle, link or copy its code into this repo. |
| Docling | MIT | May run behind the document port. Never enable its surya-ocr option (GPL-3.0). |
| Browser Use | MIT | May run behind the browser-task port on the pilot Mac. Keep the notice if any code is ported. |
| Paperclip | MIT | Ideas only (cost ledger, budget stop, run events, watchdog), written fresh in `requirements/agents.md`. No code. |
| Higgsfield CLI | MIT | Development only, on subscription credits. Never used for tenant production jobs. |
| Kie.ai, FAL | hosted APIs | Production image jobs, billed to the tenant's wallet. Only models whose licence allows commercial use. |
| FLUX dev and other non-commercial model weights | non-commercial | **Forbidden** for tenant output, through any vendor. |
| Listmonk, Postiz | AGPL-3.0 | Do not run them. Behaviour from their public docs only, in our own words. Never read their source. |
| Nosto | proprietary SaaS | Public docs only. Never copy its code, text or assets. |

Behaviour (what a product does) is free to study and rebuild; code, text and assets are not.
Reading a source and then writing a "spec" from it does not make a clean room. Write
requirements in our own words from behaviour and product needs. A similarity scan against
each MIT source runs before any port lands.
