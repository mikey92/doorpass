# Friction log

What got in the way while building on the Ring Partner API and Amazon Bedrock (first for CareBell, our earlier prototype, then DoorPass), in the order it happened. Every entry has the task, the steps, expected vs. actual, a severity, the workaround we used and a suggestion.

Severity: **high** blocks the build, **medium** costs real time or forces a workaround, **low** is a papercut.

| # | Area | Entry | Severity |
|---|---|---|---|
| 1 | Ring Playground | Can't send doorbell or motion webhooks | high |
| 2 | Ring Playground | Event history is empty | medium |
| 3 | Ring Playground | Snapshot: `TIME_RANGE_NOT_AUTHORIZED` | medium |
| 4 | Ring Playground | 30-minute token, copy from the page only | low |
| 5 | Developer registration | Custom dropdowns don't take typed values | low |
| 6 | Ring account linking | Private app needs a location; error doesn't say so | high |
| 7 | Ring account | New accounts pushed into SMS two-step setup | low |
| 8 | Ring webhooks | Real `data.id` differs from the docs | low |
| 9 | Ring snapshots | Old app name in the watermark; "not ready" looks like "nothing there" | low |
| 10 | Amazon Bedrock | First call after sign-up: "account is being verified" | low |
| 11 | Amazon Bedrock | API key expiry must be chosen; the form error is easy to miss | low |

---

## 1. The Playground can't send doorbell or motion webhooks
- **Task:** test the webhook handler with a real `button_press`.
- **Steps:** Developer Console → Playground → Generate token; looked for a way to trigger events toward our webhook URL.
- **Expected:** a "send test webhook" button (button press, human motion) to a URL I enter, signed with a test HMAC key.
- **Actual:** the Playground simulates live-view *streams* (Package, Vehicle, Motion), but nothing is delivered to a webhook URL, and there is no test signing key.
- **Severity:** high (the webhook is the core of any real-time Ring app).
- **Workaround:** wrote a simulator that builds v1.1 payloads as documented, signs them with HMAC-SHA256 over the raw body and POSTs them to the real endpoint. Published separately as [ring-webhook-kit](https://github.com/mikey92/ring-webhook-kit).
- **Suggestion:** a "Send test event" panel in the Playground: event type, sub_type, target URL, and a per-developer test HMAC key.

## 2. Event history is empty on the Playground device
- **Task:** use the documented polling alternative to webhooks.
- **Steps:** `GET /v1/history/devices/{id}/events` with a Playground token, several times over two days.
- **Expected:** a few sample `ding` / `motion` events so parsing can be tested.
- **Actual:** `{"data": []}` every time.
- **Severity:** medium. The history code path can only be tested against made-up data.
- **Workaround:** unit tests against payloads written from the docs.
- **Suggestion:** seed the Playground device with a day of sample events, or let simulated live-view events also appear in history.

## 3. Snapshots on the Playground: `TIME_RANGE_NOT_AUTHORIZED`
- **Task:** attach a door snapshot to the doorbell notification.
- **Steps:** `POST /v1/devices/{id}/media/image/download` with `type: latest_in_range` over the last hour, Playground token.
- **Expected:** an image, or an error that says which time range *is* authorized.
- **Actual:** `403 TIME_RANGE_NOT_AUTHORIZED: Requested time range is not within authorized boundaries`.
- **Severity:** medium.
- **Workaround:** made the snapshot optional; with a linked real account (item 9) it works.
- **Suggestion:** document the authorized range for Playground tokens and include it in the error `detail`.

## 4. Playground token: 30 minutes, UI only
- **Task:** keep a local server connected while developing.
- **Steps:** Generate token in the Playground, paste into the server, keep working.
- **Expected:** a token that lasts a working session, or a refresh token.
- **Actual:** ~30 minutes, no refresh token, and it can only be copied from the page (it is cleared when the tab closes).
- **Severity:** low.
- **Workaround:** re-generate and re-paste; later replaced by a real linked account with refresh tokens.
- **Suggestion:** a longer-lived developer token, or a refresh token for Playground sessions.

## 5. Developer registration form
- **Task:** register as a developer to reach the Playground.
- **Steps:** filled the registration form; typed the country and state.
- **Expected:** typed values are accepted.
- **Actual:** Country, State and phone-country are custom dropdowns; typing shows the value but doesn't select it, and the form reports "required field" with the value visibly filled in.
- **Severity:** low.
- **Workaround:** open each dropdown and click the option.
- **Suggestion:** native `<select>` elements, or commit the typed value on blur.

## 6. Connecting a private app needs a Ring location, and the error doesn't say so
- **Task:** install our private app on a new Ring account to exercise token exchange and account linking.
- **Steps:** created a Ring account → Developer Console → Connect Ring account (worked) → ring.com/appstore → Staging Apps → our app → Connect App → Agree and Continue.
- **Expected:** device selection, then a redirect to our Account Link URL with `nonce` and `time`.
- **Actual:** "There are currently no eligible locations available for subscription. We cannot sign you up for this service." and a single "Got It" button.
- **Severity:** high for anyone without a Ring device: token exchange and nonce linking can't be tested end to end.
- **Workaround:** unit tests against the documented flow until our doorbell arrived; then linked the real account (works as documented).
- **Suggestion:** let a developer account with no devices link private apps to the Playground device, and make the error say a location with at least one device is required.

## 7. New Ring accounts are pushed into SMS two-step setup
- **Task:** create a Ring account for testing.
- **Steps:** sign up → verify email.
- **Expected:** reach the account, set up two-step later.
- **Actual:** a phone number for SMS two-step verification is required next, with only a Continue button.
- **Severity:** low.
- **Workaround:** entered a phone number.
- **Suggestion:** a "later" option for developer test accounts.

## 8. Real webhook event ids don't match the documented format
- **Task:** deduplicate and parse doorbell webhooks from a real Battery Doorbell 2K.
- **Steps:** pressed the doorbell, logged the verified webhook body.
- **Expected (docs):** `data.id` is `<device_id>_button_press_<timestamp>`.
- **Actual:** `<device_id>_ding_<timestamp>` (`data.type` is still `button_press`).
- **Severity:** low, but anyone parsing the id instead of `data.type` breaks.
- **Workaround:** branch on `data.type`, treat `data.id` as opaque, dedupe on `meta.request_id`.
- **Suggestion:** fix the docs, or state that `data.id` is opaque.

## 9. Snapshots: old app name in the watermark, and "not ready yet" looks like "nothing there"
- **Task:** attach Ring's photo of whoever pressed the doorbell to the manager's request.
- **Steps:** on `button_press`, `POST media/image/download` with `type: at_timestamp` and the event's timestamp; follow the 303 to the pre-signed URL.
- **Expected:** the frame, labelled with the current app name; a "processing" signal while it isn't ready.
- **Actual:** works with the linked account (640×360 JPEG), but the frame is watermarked `Partner: CareBell`, the app's original name, after renaming it to DoorPass. Asking right after the press returns `416 MEDIA_NOT_FOUND`, the same answer as for a moment with no recording.
- **Severity:** low.
- **Workaround:** retry at 2, 6, 12 and 22 s after the press; the photo usually arrives on the first or second try.
- **Suggestion:** take the watermark from the current app name; return a distinct status (or `Retry-After`) while media for a recent event is still processing.

## 10. Amazon Bedrock: first call after sign-up says the account is being verified
- **Task:** call Amazon Nova through the Converse API from a new AWS account.
- **Steps:** signed up (free plan) → Bedrock console → API keys → generated a long-term key → `POST bedrock-runtime…/converse`.
- **Expected:** a response, or a clear "not yet" with an ETA in the console before generating a key.
- **Actual:** HTTP error "Your account is currently being verified. Verification normally takes less than 2 hours." The console let us generate the key without saying so. It cleared within minutes.
- **Severity:** low.
- **Workaround:** built the agent against a fake Converse function in tests while waiting.
- **Suggestion:** show the verification state on the Bedrock API keys page.

## 11. Amazon Bedrock: API key expiry must be chosen, and the error is easy to miss
- **Task:** generate a long-term Bedrock API key.
- **Steps:** Bedrock → API keys → Generate long-term API key → Generate.
- **Expected:** a sensible default expiry (the page suggests setting one) or a visible error next to the button.
- **Actual:** nothing seems to happen; the message "You must select a time after which your API key will expire" appears above, out of view.
- **Severity:** low.
- **Workaround:** picked 30 days.
- **Suggestion:** default to 30 days, or scroll to and focus the field with the error.

---

## What worked well
- With a real doorbell linked through one-way account linking, a press reached our webhook **1.4 s** after Ring's own event timestamp, signed and verifiable.
- `GET /v1/devices`, `/status`, `/capabilities` answered first time; JSON:API responses are consistent.
- The webhook docs are unusually precise: raw-body HMAC, hex encoding, `request_id` for idempotency, the retry schedule. The handler was written from the docs alone.
- The `ring-api-helloworld` repo is a good map of the endpoints.
- A private app, its four endpoint URLs and its "Staging Apps" listing took minutes.
- Bedrock API keys plus the Converse API meant tool use and image input over plain HTTPS with no SDK; Nova Pro answered tool calls in about 2 s.
