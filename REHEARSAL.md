# Failure rehearsal

Run against the live server (real Ring account, real SwitchBot lock) on 2026-10-17. None of these opens the door.

| Case | What we did | What happened | Who is told |
|---|---|---|---|
| Lock offline | Demo "Lock offline", Maya taps her pass, doorbell pressed | `The lock didn't accept the command (lock is offline). Door stays closed.` | Door log; Maya's pass switches from the countdown to "The lock didn't respond… Call the manager" |
| Nobody answers | Doorbell, booked member doesn't tap, manager doesn't answer | Request opened, then after 90 s: `No answer in 90 seconds. The door stayed locked.` | Door log, Alexa card |
| Expired membership | Sam taps his pass | Refused: `Your membership is expired.` | Sam's pass shows the reason; door log |
| Replayed webhook | A correctly signed doorbell event, 20 minutes old | Answered 200 (so Ring stops retrying) and ignored | Nothing logged |
| Forged webhook | Bad `X-Signature` | 401 before the body is parsed | — |
| Restart while open | (unit test) Server comes back with the lock unlocked | Locks it and logs why | Door log |
| Late doorbell webhook | (unit test) Tap made after the press, webhook delivered later | Still pairs and opens | — |
| Staff on site | (unit test) Member taps during staffed hours | Pass says to ring for staff; the door doesn't open by pass | Member's pass |
| Stranger asks Alexa to open | `/api/ask` "let them in" without the manager key | The model isn't offered the door tools at all | — |

## Known limits

- **Presence is the doorbell, not a face.** A member who taps from somewhere else while a stranger presses the doorbell would open the door. The 60 s window and the Ring photo on every opening make this visible in the log, not impossible.
- **Cloud dependency.** Ring, SwitchBot and DoorPass all talk over the internet. If it's down, the door stays locked (fail-secure) and members use the physical key.
- **Tailgating** is flagged from Ring person-motion events; Ring's motion cooldown can miss a second person.
