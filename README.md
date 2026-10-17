# DoorPass

**A front door that runs itself for spaces with nobody at the desk.** Music practice rooms, self-storage,
24-hour gyms: a member presses the Ring doorbell, taps their pass, and a real smart lock opens. Anyone
else becomes a one-tap request to the manager, on their phone or by asking Alexa.

Built for the [Amazon Developer Hackathon](https://amazonappdev2026.devpost.com) (Ring track; also
entered in Alexa+).

**Live:** https://doorpass.snack-wrap.com (read-only without the manager key)

## How the door decides

| Fact | Comes from | Why it's needed |
|---|---|---|
| **Presence**: someone is at this door now | Ring doorbell press (`button_press` webhook) | A pass link alone could be used from anywhere |
| **Permission**: they're booked for now | The booking system (10 minutes early is fine) | Members only get in during their slot |
| **Identity**: it's the member | A tap on their pass within 60 s of the press, either order | A doorbell press alone is anonymous |

All three: the lock opens, and locks again after 10 s. Anything missing (no booking, an expired
membership, a stranger) becomes a request to the manager that **expires closed** after 90 s. Every
decision lands in a door log with its evidence: the Ring event, the booking, the lock's own report and
the time it took. Human motion at the door right after an opening is counted; a second person is
flagged as possible tailgating. During staffed hours the doorbell only announces visitors.

```
Ring Battery Doorbell 2K ──button_press / motion_detected (HMAC-signed webhook)──▶ DoorPass
Member's phone ──"I'm at the door" on their pass──────────────────────────────────▶   gate
Booking system ──bookings─────────────────────────────────────────────────────────▶   │
                                                                                      ├─▶ SwitchBot OpenAPI ──▶ Lock Vision (unlock, re-lock, read back)
                                                                                      ├─▶ manager dashboard (live, one-tap Let in / Keep closed)
                                                                                      └─▶ MCP server ──▶ Alexa+ (who_is_at_door, let_them_in, door_log, …)
```

**Ring is the eyes and ears; the lock maker's API is the hands.** Ring's Partner API is read-only (it
can't open anything), so the lock is opened through SwitchBot's own API. The door opens as soon as the
lock's cloud accepts the command (about 0.4 s after the press reaches DoorPass); the lock's own
"unlocked" report follows a few seconds later and is logged separately.

## What's real and what's simulated

| Piece | Status |
|---|---|
| Ring doorbell | **Real.** A Ring Battery Doorbell 2K, linked to DoorPass through the Ring Developer Console's private app and **one-way account linking** (token exchange, nonce matching after manager sign-in, `POST` + `PATCH /v1/accounts/me/app-integrations`, refresh tokens) |
| Ring webhooks | **Real.** HMAC-SHA256 over the raw body, verified before parsing; retries deduped on `request_id`, events older than 10 minutes refused as replays; a press reached DoorPass 1.4 s after Ring's event timestamp. The signing, simulator and receiver are also published on their own as [ring-webhook-kit](https://github.com/mikey92/ring-webhook-kit) |
| Ring REST calls | **Real.** Devices, status, capabilities; shown live (without tokens) on the dashboard |
| Ring snapshots | **Real.** After each doorbell press DoorPass fetches Ring's photo of the visitor (`media/image/download`, redirect followed without the Ring token) and shows it on the manager's request and in the door log. Manager view only; the last 100 are kept (mode 600) |
| Smart lock | **Real.** SwitchBot Lock Vision over SwitchBot OpenAPI v1.1 (unlock, lock, status read-back). Without a `switchbot.json`, a clearly labelled simulated lock is used |
| Alexa+ | **Simulated client.** Alexa+ add-on tooling isn't open to hackathon entrants, so the dashboard has an Alexa+-style client that talks to DoorPass's real **MCP server** (Streamable HTTP, protocol 2025-11-25) and hosts its **MCP App** card, whose Let in / Keep closed buttons call tools back through the host |
| Bookings and members | Demo data for "Night Owl Rooms" |
| Demo buttons on the dashboard | Send signed Ring-format webhooks through the same endpoint (manager key required) |

## Run it

Node 22.18 or later (TypeScript runs natively).

```bash
npm install
npm test            # 17 tests: the gate's rules, account linking, webhook signatures
npm start           # http://localhost:8842
```

Configuration (all optional; without them DoorPass runs on simulated hardware):

| File / variable | What |
|---|---|
| `RING_CREDENTIALS_FILE` | The app-credentials CSV the Ring Developer Console shows once (Client ID, Client Secret, HMAC key) |
| `RING_TOKEN_FILE` | A Ring Developer Playground token, used until an account is linked |
| `~/.config/doorpass/switchbot.json` | `{"token","secret","deviceId"}` from the SwitchBot app's developer options |
| `data/manager.key` | Created on first run (mode 600). Open the dashboard as `/#key=<key>` for approvals and demo controls |

Register these URLs for your Ring app: Account Link `…/ring/link`, Token Exchange `…/ring/token`,
Webhook `…/webhooks/ring`, Homepage `/`.

## MCP tools (for Alexa+)

| Tool | What it does |
|---|---|
| `who_is_at_door` | Who rang, whether they're booked, whether DoorPass is waiting on the manager. Returns the MCP App door card |
| `let_them_in` / `keep_door_closed` | Answer the open request. These two need the manager key (`Authorization: Bearer <key>`); reading the door doesn't |
| `door_log` | Openings, refusals and flags over the last N hours |
| `todays_bookings` | Who is booked from now on |

## Privacy

DoorPass uses doorbell presses and person-motion events only. No video, no face recognition, nothing
about visitors beyond what the manager sees in the log. Pass links are the member's credential; the
public dashboard never shows them.

See [FRICTION_LOG.md](FRICTION_LOG.md) for what got in the way on the Ring Partner API.

MIT licensed.
