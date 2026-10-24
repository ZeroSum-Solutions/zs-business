# browser-runner

The pilot Mac's runner for website tasks (`docs/requirements/browser-tasks.md`, BT-2 and BT-7).
It pulls claimed jobs from the API over HTTPS, drives a Chrome it launches itself, and reports
steps, files and the result back. It opens no inbound port.

This first slice holds the job interface client, the settings checks and the claim loop, all
standard library and tested with a fake API. The Browser Use executor is not in it: nothing here
installs Browser Use, opens a browser or visits a site.

## Pilot Mac setup

Do this by hand on the pilot Mac, once. Nothing in this repository does it for you.

1. **Python 3.12 or newer** and **Google Chrome** installed. The runner launches its own Chrome
   per job; it never attaches to a Chrome you use.
2. **Settings.** Put these in the service's environment (a launchd plist or a `0600` env file
   outside the repository). The runner refuses to start if any is missing or wrong.

   | Name | Value |
   |---|---|
   | `ANONYMIZED_TELEMETRY` | `false` (Browser Use telemetry stays off) |
   | `BROWSER_USE_CLOUD_SYNC` | `false` (no Browser Use Cloud, ever) |
   | `ZS_API_URL` | the API origin, `https://...` (plain http only on `127.0.0.1`) |
   | `BROWSER_RUNNER_TOKEN` | the runner's scoped bearer token, 24 characters or more |
   | `BROWSER_ROOT` | an absolute path, for example `/var/zs-browser` |
   | `BROWSER_POLL_SECONDS` | optional, 1 to 300, default 10 |

3. **The token.** The API compares it with the token it was started with (`runner.token` in the
   `browser` dependency of `createApp`; wiring it into the production API process is not done yet). Store both in ZS Vault, not in a file in this repository.
   The token can claim a job and then act only on that run, with the run's lease token. It
   cannot read customers, bookings, the Inbox or any other run (BT-7).
4. **Profiles.** `BROWSER_ROOT/<tenantId>/<targetId>/profile` holds one Chrome profile per
   tenant and target. The runner builds the path from the claim's server-derived IDs, never from
   a payload (BT-6). Keep `BROWSER_ROOT` on an encrypted volume, readable only by the service
   user, and exclude it from backups that leave the Mac. Deleting a target does not delete its
   profile yet: remove the folder by hand.
5. **Network.** Outbound HTTPS to the API and to the supplier sites you allowed. No inbound
   port. A firewall rule that allows only those hosts is welcome but not required by the code;
   the policy that refuses other origins runs in the browser layer (BT-5).
6. **Check the settings.** From this folder: `python3 -m browser_runner`. It prints one line
   when the settings are valid and exits with 2 and a reason when they are not.
7. **Run the tests.** `python3 -m unittest discover -s tests -t .` (no browser, loopback only).

## What the executor must do (next slice)

The `BrowserExecutor` protocol in `browser_runner/loop.py` is the seam. An implementation:

- gets the claim and a profile directory, and calls `hooks.before_step()` before every step,
  stopping when it answers a reason (kill, cap or deadline);
- passes the claim's credentials to Browser Use only as sensitive-data placeholders bound to the
  target's origins, so the model sees placeholders, never values (BT-8);
- refuses any request outside the target's origins and paths, and any write other than the one
  sign-in POST (BT-5), mirroring `packages/core/src/browser/policy.ts`;
- sends each step to `hooks.record_step()` with the URL it touched (the server keeps only origin
  and path), and each PDF to `hooks.save_artifact()`;
- returns `Outcome("read_done")` or `Outcome("stopped", <reason>)`. An exception becomes
  `runner_error` with no detail.

Also pending for that slice: a fixture-site run of this service, and the HTTP runner adapter on
the TypeScript side (`createHttpBrowserRunner`).

## Files

- `browser_runner/config.py`: settings checks and the profile path.
- `browser_runner/client.py`: the five job calls over HTTPS.
- `browser_runner/loop.py`: claim, execute, finish.
- `tests/test_runner.py`: unit tests against a loopback fake API.
