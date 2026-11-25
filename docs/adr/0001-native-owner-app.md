# The owner app is one Expo native app; the web dashboard retires

The owner client is rebuilt from scratch as one Expo (React Native, TypeScript) app for iOS and Android, because voice-first needs a native microphone, background audio, push and passkeys. The server core (contracts, db, core, API, site-worker) stays. `apps/dashboard` retires after parity; the web keeps the Shopify embedded app, public booking pages and sites, auth callbacks and checkout. Testers get TestFlight builds. Decided 2026-11-24 in ZSB-81 (Q12).

## Considered Options

- Keep the Next.js PWA: rejected, because a PWA cannot hold background audio or a reliable mic session on iOS.
- Wait for the ZSB-75 device spike before deciding: rejected; the spike now verifies the native build instead of gating it.
