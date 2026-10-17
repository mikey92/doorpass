// State on disk, and the demo space: a 24-hour music practice studio with nobody at the desk at night.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { emptyGate, type GateState } from "./gate.ts";

const MIN = 60_000;

export class Store {
  path: string;
  state: GateState;
  constructor(path: string, seed: () => GateState) {
    this.path = path;
    let loaded: GateState | undefined;
    try {
      loaded = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as GateState) : undefined;
    } catch {
      loaded = undefined;
    }
    this.state = loaded ?? seed();
  }
  save() {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path + ".tmp", JSON.stringify(this.state, null, 1), { mode: 0o600 });
    renameSync(this.path + ".tmp", this.path);
  }
}

const token = () => randomBytes(9).toString("base64url");

/** Night Owl Rooms: nobody at the desk; the Ring doorbell and the members' passes run the door. Staffed mode is a toggle. */
export function demoState(now: number, doorDeviceId: string, tz = "America/Los_Angeles"): GateState {
  const s = emptyGate({ id: "night-owl", name: "Night Owl Rooms", kind: "24-hour music practice rooms", doorDeviceId, tz });
  s.members.push(
    { id: "maya", name: "Maya Chen", status: "active", passToken: token(), plan: "Monthly · unlimited" },
    { id: "jordan", name: "Jordan Lee", status: "active", passToken: token(), plan: "Pay per hour" },
    { id: "sam", name: "Sam Ortiz", status: "expired", passToken: token(), plan: "Monthly · lapsed Oct 1" },
    { id: "priya", name: "Priya Nair", status: "active", passToken: token(), plan: "Monthly · unlimited" },
  );
  rollDemoBookings(s, now);
  return s;
}

/** Demo bookings are relative to "now", so a judge opening the live site days later still sees Maya booked. */
export function rollDemoBookings(s: GateState, now: number) {
  if (s.site.id !== "night-owl") return;
  const at = (m: number) => now + m * MIN;
  s.bookings = [
    { id: "b-maya", memberId: "maya", start: at(-5), end: at(115), room: "Room 2 · drums" },
    { id: "b-jordan", memberId: "jordan", start: at(90), end: at(150), room: "Room 1 · piano" },
    { id: "b-sam", memberId: "sam", start: at(-5), end: at(55), room: "Room 3 · guitar" },
    { id: "b-priya", memberId: "priya", start: at(240), end: at(360), room: "Room 2 · drums" },
  ];
}
