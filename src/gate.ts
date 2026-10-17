// The gate: who gets in, decided from three facts.
//   1. Someone is physically at this door: a Ring doorbell press (presence).
//   2. They hold a booking for now: the booking system (permission).
//   3. They have the member's phone: a tap on their pass within a minute of the press (identity).
// All three → the lock opens by itself. Missing one → the manager gets a one-tap request.
// A ring nobody answers expires closed. Every decision is logged with its evidence.

import type { Lock, LockState } from "./lock.ts";

const SEC = 1000;
const MIN = 60 * SEC;

export interface Site {
  id: string;
  name: string;
  kind: string;
  doorDeviceId: string;
  /** Local hours when staff are on site; inside them DoorPass only announces visitors. */
  staffed?: { from: number; to: number };
  tz: string;
}
export interface Member { id: string; name: string; status: "active" | "expired" | "suspended"; passToken: string; plan: string }
export interface Booking { id: string; memberId: string; start: number; end: number; room: string }
export interface Ring { id: string; at: number; deviceId: string; handled: boolean; requestId?: string }
export interface Request {
  id: string;
  at: number;
  ringId?: string;
  memberId?: string;
  reason: string;
  status: "pending" | "approved" | "denied" | "expired";
  expiresAt: number;
  decidedBy?: string;
  decidedAt?: number;
}
export type LogKind = "ring" | "open" | "confirm" | "relock" | "deny" | "request" | "approve" | "expire" | "pass" | "enter" | "notify" | "lock-error";
export interface LogEntry {
  id: string;
  at: number;
  kind: LogKind;
  text: string;
  memberId?: string;
  bookingId?: string;
  ringId?: string;
  requestId?: string;
  lock?: LockState;
  /** Doorbell press to lock confirmed open, in ms. */
  latencyMs?: number;
  evidence?: string[];
  flags?: string[];
}
export interface GateState {
  site: Site;
  members: Member[];
  bookings: Booking[];
  rings: Ring[];
  requests: Request[];
  taps: { memberId: string; at: number }[];
  log: LogEntry[];
  seen: string[];
  /** When the door last opened, for counting who walks in. */
  openedAt?: number;
}

export const RULES = {
  /** A doorbell press and a pass tap pair up if they're this close together. */
  pairMs: 60 * SEC,
  /** A booking opens the door this early. */
  earlyMs: 10 * MIN,
  /** A manager request left unanswered closes. */
  requestMs: 90 * SEC,
  /** The lock turns back after this long. */
  relockMs: 10 * SEC,
  /** Human motion this soon after opening is someone walking in. */
  enterMs: 30 * SEC,
};

export type Outcome =
  | { action: "open"; memberId?: string; bookingId?: string; latencyMs?: number; lock: LockState }
  | { action: "wait-pass"; memberIds: string[] }
  | { action: "wait-ring" }
  | { action: "request"; requestId: string; reason: string }
  | { action: "deny"; reason: string }
  | { action: "notify" }
  | { action: "ignored" };

export class Gate {
  s: GateState;
  lock: Lock;
  onChange: (e?: LogEntry) => void = () => {};
  private relockTimer?: ReturnType<typeof setTimeout>;
  private n = 0;

  constructor(state: GateState, lock: Lock) {
    this.s = state;
    this.lock = lock;
  }

  member(id?: string) {
    return this.s.members.find((m) => m.id === id);
  }

  private log(now: number, e: Omit<LogEntry, "id" | "at">): LogEntry {
    const full = { id: `L${now}-${++this.n}`, at: now, ...e };
    this.s.log.push(full);
    if (this.s.log.length > 1000) this.s.log.splice(0, 200);
    this.onChange(full);
    return full;
  }

  /** Bookings that let someone in right now. */
  live(now: number, memberId?: string) {
    return this.s.bookings.filter((b) => (!memberId || b.memberId === memberId) && now >= b.start - RULES.earlyMs && now <= b.end && this.member(b.memberId)?.status === "active");
  }

  staffedNow(now: number) {
    const st = this.s.site.staffed;
    if (!st) return false;
    const h = Number(new Date(now).toLocaleString("en-US", { hour: "numeric", hour12: false, timeZone: this.s.site.tz })) % 24;
    return st.from <= st.to ? h >= st.from && h < st.to : h >= st.from || h < st.to;
  }

  /** A Ring doorbell press at the site door (from a verified webhook). */
  async ring(e: { id: string; deviceId: string; at: number }, now = e.at): Promise<Outcome> {
    if (e.deviceId !== this.s.site.doorDeviceId) return { action: "ignored" };
    if (this.s.seen.includes(e.id)) return { action: "ignored" };
    this.s.seen.push(e.id);
    if (this.s.seen.length > 5000) this.s.seen.splice(0, 1000);
    const ring: Ring = { id: e.id, at: e.at, deviceId: e.deviceId, handled: false };
    this.s.rings.push(ring);
    if (this.s.rings.length > 500) this.s.rings.splice(0, 100);

    if (this.staffedNow(now)) {
      ring.handled = true;
      const names = this.live(now).map((b) => this.member(b.memberId)!.name);
      this.log(now, { kind: "notify", ringId: ring.id, text: names.length ? `Doorbell: ${names.join(" or ")} (booked now). Staff on site.` : "Doorbell: no booking now. Staff on site." });
      return { action: "notify" };
    }

    // Pair with a pass tap from the last minute.
    const tap = [...this.s.taps].reverse().find((t) => e.at - t.at <= RULES.pairMs && e.at - t.at >= -5 * SEC && this.live(now, t.memberId).length);
    if (tap) {
      // A tap opens the door once.
      this.s.taps = this.s.taps.filter((t) => t !== tap);
      return this.open(now, ring, tap.memberId, "doorbell + booking + pass");
    }

    const live = this.live(now);
    this.log(now, {
      kind: "ring",
      ringId: ring.id,
      text: live.length ? `Doorbell pressed. Waiting for ${live.map((b) => this.member(b.memberId)!.name).join(" or ")} to tap their pass.` : "Doorbell pressed. No booking right now.",
      evidence: [`ring:${ring.id}`],
    });
    // Nobody booked: the manager decides. Booked: the member's pass decides, the manager can too.
    const req = this.request(now, ring, live.length ? "Booked member hasn't tapped their pass yet" : "No booking right now");
    return live.length ? { action: "wait-pass", memberIds: live.map((b) => b.memberId) } : { action: "request", requestId: req.id, reason: req.reason };
  }

  private request(now: number, ring: Ring | undefined, reason: string, memberId?: string): Request {
    const req: Request = { id: `R${now}-${++this.n}`, at: now, ringId: ring?.id, memberId, reason, status: "pending", expiresAt: now + RULES.requestMs };
    this.s.requests.push(req);
    if (this.s.requests.length > 300) this.s.requests.splice(0, 50);
    if (ring) ring.requestId = req.id;
    this.log(now, { kind: "request", requestId: req.id, ringId: ring?.id, memberId, text: `Manager asked: ${reason}.` });
    return req;
  }

  /** A member taps "I'm at the door" on their pass. */
  async tap(passToken: string, now: number): Promise<Outcome> {
    const m = this.s.members.find((x) => x.passToken === passToken);
    if (!m) return { action: "deny", reason: "Unknown pass" };
    if (m.status !== "active") {
      this.log(now, { kind: "deny", memberId: m.id, text: `${m.name}'s pass was refused: membership ${m.status}.` });
      return { action: "deny", reason: `Your membership is ${m.status}.` };
    }
    const b = this.live(now, m.id)[0];
    if (!b) {
      const next = this.s.bookings.filter((x) => x.memberId === m.id && x.start > now).sort((a, c) => a.start - c.start)[0];
      this.log(now, { kind: "deny", memberId: m.id, text: `${m.name}'s pass was refused: no booking now.` });
      return { action: "deny", reason: next ? `Your booking starts at ${time(next.start, this.s.site.tz)}. The door opens 10 minutes before.` : "You have no booking right now." };
    }
    const ring = [...this.s.rings].reverse().find((r) => !r.handled && now - r.at <= RULES.pairMs);
    if (ring) return this.open(now, ring, m.id, "doorbell + booking + pass");
    this.s.taps.push({ memberId: m.id, at: now });
    if (this.s.taps.length > 200) this.s.taps.splice(0, 50);
    this.log(now, { kind: "pass", memberId: m.id, bookingId: b.id, text: `${m.name} tapped their pass. Waiting for the doorbell.` });
    return { action: "wait-ring" };
  }

  /** The manager answers a request. */
  async decide(requestId: string, approve: boolean, by: string, now: number): Promise<Outcome> {
    const req = this.s.requests.find((r) => r.id === requestId);
    if (!req || req.status !== "pending") return { action: "deny", reason: "That request is no longer open." };
    if (now > req.expiresAt) {
      this.expire(now);
      return { action: "deny", reason: "That request expired." };
    }
    req.status = approve ? "approved" : "denied";
    req.decidedBy = by;
    req.decidedAt = now;
    const ring = this.s.rings.find((r) => r.id === req.ringId);
    if (!approve) {
      if (ring) ring.handled = true;
      this.log(now, { kind: "deny", requestId: req.id, ringId: req.ringId, text: `${by} kept the door closed.` });
      return { action: "deny", reason: "Denied by the manager" };
    }
    this.log(now, { kind: "approve", requestId: req.id, ringId: req.ringId, text: `${by} let the visitor in.` });
    return this.open(now, ring, req.memberId, `approved by ${by}`);
  }

  /** Requests nobody answered close. */
  expire(now: number) {
    for (const r of this.s.requests)
      if (r.status === "pending" && now > r.expiresAt) {
        r.status = "expired";
        const ring = this.s.rings.find((x) => x.id === r.ringId);
        if (ring && !ring.handled) {
          ring.handled = true;
          this.log(now, { kind: "expire", requestId: r.id, ringId: r.ringId, text: "No answer in 90 seconds. The door stayed locked." });
        }
      }
  }

  private async open(now: number, ring: Ring | undefined, memberId: string | undefined, why: string): Promise<Outcome> {
    if (ring) {
      ring.handled = true;
      // A request still open for this ring is settled by the opening.
      const req = this.s.requests.find((r) => r.id === ring.requestId && r.status === "pending");
      if (req) {
        req.status = "approved";
        req.decidedBy = why;
        req.decidedAt = now;
      }
    }
    const m = this.member(memberId);
    const b = memberId ? this.live(now, memberId)[0] : undefined;
    // Open as soon as the lock's cloud accepts the command; its own confirmation follows a few seconds later.
    try {
      await this.lock.request("unlock");
    } catch (err) {
      this.log(now, { kind: "lock-error", memberId, ringId: ring?.id, text: `The lock didn't accept the command (${(err as Error).message.slice(0, 80)}). Door stays closed.` });
      return { action: "deny", reason: "The lock didn't respond" };
    }
    const latencyMs = ring ? Math.max(0, Date.now() - ring.at) : undefined;
    const state: LockState = "unlocked";
    this.s.openedAt = now;
    this.log(now, {
      kind: "open",
      memberId,
      bookingId: b?.id,
      ringId: ring?.id,
      lock: "unlocked",
      latencyMs,
      evidence: [ring ? `ring:${ring.id}` : "", b ? `booking:${b.id}` : "", `lock:${this.lock.kind}`].filter(Boolean),
      text: `Door opened for ${m ? `${m.name}${b ? ` (${b.room}, ${time(b.start, this.s.site.tz)}–${time(b.end, this.s.site.tz)})` : ""}` : "a visitor"}: ${why}.`,
    });
    this.lock
      .confirm("unlocked")
      .then((st) => {
        const ms = ring ? Date.now() - ring.at : undefined;
        if (st === "unlocked") this.log(Date.now(), { kind: "confirm", ringId: ring?.id, lock: st, latencyMs: ms, text: `${this.lock.name} reported unlocked${ms != null ? ` (${(ms / 1000).toFixed(1)} s after the doorbell)` : ""}.` });
        else this.log(Date.now(), { kind: "lock-error", ringId: ring?.id, lock: st, text: `${this.lock.name} reported "${st}" instead of unlocked. Check the door.` });
      })
      .catch(() => {});
    clearTimeout(this.relockTimer);
    this.relockTimer = setTimeout(() => this.relock(Date.now()), RULES.relockMs);
    return { action: "open", memberId, bookingId: b?.id, latencyMs, lock: state };
  }

  async relock(now: number) {
    try {
      const st = await this.lock.lock();
      this.log(now, { kind: "relock", lock: st, text: st === "locked" ? "Locked again." : `Lock reported "${st}" when re-locking.` });
    } catch (err) {
      this.log(now, { kind: "lock-error", text: `Re-lock failed (${(err as Error).message.slice(0, 80)}).` });
    }
  }

  /** Person motion at the door right after an opening: someone walking in. Two or more is flagged. */
  motion(e: { id: string; deviceId: string; at: number; subType?: string }, now = e.at) {
    if (e.deviceId !== this.s.site.doorDeviceId || e.subType !== "human" || this.s.seen.includes(e.id)) return;
    this.s.seen.push(e.id);
    if (!this.s.openedAt || e.at - this.s.openedAt > RULES.enterMs || e.at < this.s.openedAt) return;
    const entries = this.s.log.filter((l) => l.kind === "enter" && l.at >= this.s.openedAt!).length + 1;
    this.log(now, { kind: "enter", flags: entries > 1 ? ["possible tailgating"] : [], text: entries > 1 ? `Another person at the door ${Math.round((e.at - this.s.openedAt) / SEC)} s after it opened. Possible tailgating.` : "Someone walked in." });
  }

  stopTimers() {
    clearTimeout(this.relockTimer);
  }
}

export function time(ms: number, tz: string) {
  return new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz });
}

export function emptyGate(site: Site): GateState {
  return { site, members: [], bookings: [], rings: [], requests: [], taps: [], log: [], seen: [] };
}
