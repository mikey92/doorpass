import { test } from "node:test";
import assert from "node:assert/strict";
import { Gate, emptyGate, RULES } from "../src/gate.ts";
import { SimulatedLock } from "../src/lock.ts";

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 18, 7, 0); // 00:00 PT, unstaffed

function setup(staffed?: { from: number; to: number }) {
  const s = emptyGate({ id: "s1", name: "Night Owl Rooms", kind: "music practice rooms", doorDeviceId: "door", tz: "America/Los_Angeles", staffed });
  s.members.push(
    { id: "maya", name: "Maya", status: "active", passToken: "p-maya", plan: "Monthly" },
    { id: "sam", name: "Sam", status: "expired", passToken: "p-sam", plan: "Monthly" },
    { id: "jo", name: "Jordan", status: "active", passToken: "p-jo", plan: "Pay as you go" },
  );
  s.bookings.push({ id: "b1", memberId: "maya", start: T0, end: T0 + 60 * MIN, room: "Room 2" }, { id: "b2", memberId: "jo", start: T0 + 120 * MIN, end: T0 + 180 * MIN, room: "Room 1" });
  const lock = new SimulatedLock(0);
  const g = new Gate(s, lock);
  return { g, lock };
}
let n = 0;
const ring = (at: number, deviceId = "door") => ({ id: `r${++n}`, deviceId, at });

test("doorbell, then pass tap within a minute: the lock opens by itself", async (t) => {
  const { g, lock } = setup();
  t.after(() => g.stopTimers());
  assert.equal((await g.ring(ring(T0 + MIN))).action, "wait-pass");
  const o = await g.tap("p-maya", T0 + MIN + 20_000);
  assert.equal(o.action, "open");
  assert.equal(lock.s, "unlocked");
  assert.match(g.s.log.findLast((l) => l.kind === "open")!.text, /Door opened for Maya \(Room 2/);
  assert.equal(g.s.requests.at(-1)!.status, "approved", "the manager request for that ring is settled");
});

test("pass first, then the doorbell: also opens", async (t) => {
  const { g } = setup();
  t.after(() => g.stopTimers());
  assert.equal((await g.tap("p-maya", T0)).action, "wait-ring");
  assert.equal((await g.ring(ring(T0 + 30_000))).action, "open");
});

test("a pass tap alone never opens the door", async (t) => {
  const { g, lock } = setup();
  t.after(() => g.stopTimers());
  await g.tap("p-maya", T0);
  assert.equal(lock.s, "locked");
});

test("a tap too long after the doorbell doesn't pair", async (t) => {
  const { g, lock } = setup();
  t.after(() => g.stopTimers());
  await g.ring(ring(T0));
  assert.equal((await g.tap("p-maya", T0 + RULES.pairMs + 1000)).action, "wait-ring");
  assert.equal(lock.s, "locked");
});

test("no booking now: the manager is asked, and approval opens", async (t) => {
  const { g, lock } = setup();
  t.after(() => g.stopTimers());
  const o = await g.ring(ring(T0 + 70 * MIN));
  assert.equal(o.action, "request");
  const r = await g.decide((o as any).requestId, true, "Alex (manager)", T0 + 70 * MIN + 10_000);
  assert.equal(r.action, "open");
  assert.equal(lock.s, "unlocked");
});

test("an unanswered request expires and the door stays locked", async (t) => {
  const { g, lock } = setup();
  t.after(() => g.stopTimers());
  const o = (await g.ring(ring(T0 + 70 * MIN))) as any;
  g.expire(T0 + 70 * MIN + RULES.requestMs + 1);
  assert.equal(g.s.requests.at(-1)!.status, "expired");
  assert.equal((await g.decide(o.requestId, true, "late", T0 + 75 * MIN)).action, "deny");
  assert.equal(lock.s, "locked");
});

test("expired membership and early arrival are refused with a reason", async (t) => {
  const { g } = setup();
  t.after(() => g.stopTimers());
  assert.match(((await g.tap("p-sam", T0)) as any).reason, /expired/);
  assert.match(((await g.tap("p-jo", T0)) as any).reason, /starts at/);
});

test("staffed hours: the doorbell only announces", async (t) => {
  const { g, lock } = setup({ from: 0, to: 24 });
  t.after(() => g.stopTimers());
  assert.equal((await g.ring(ring(T0))).action, "notify");
  assert.equal(lock.s, "locked");
});

test("other doors and repeated events are ignored", async (t) => {
  const { g } = setup();
  t.after(() => g.stopTimers());
  assert.equal((await g.ring(ring(T0, "other"))).action, "ignored");
  const r = ring(T0);
  await g.ring(r);
  assert.equal((await g.ring(r)).action, "ignored");
});

test("two people walking in after one opening is flagged", async (t) => {
  const { g } = setup();
  t.after(() => g.stopTimers());
  await g.tap("p-maya", T0);
  await g.ring(ring(T0 + 1000));
  g.motion({ id: "m1", deviceId: "door", at: T0 + 4000, subType: "human" });
  g.motion({ id: "m2", deviceId: "door", at: T0 + 9000, subType: "human" });
  assert.deepEqual(g.s.log.at(-1)!.flags, ["possible tailgating"]);
});

test("a lock that doesn't respond keeps the door closed and says so", async (t) => {
  const { g, lock } = setup();
  t.after(() => g.stopTimers());
  lock.request = async () => {
    throw new Error("offline");
  };
  await g.tap("p-maya", T0);
  const o = await g.ring(ring(T0 + 1000));
  assert.equal(o.action, "deny");
  assert.ok(g.s.log.some((l) => l.kind === "lock-error"));
});

test("one pass tap opens the door once; the next ring goes to the manager", async (t) => {
  const { g } = setup();
  t.after(() => g.stopTimers());
  await g.tap("p-maya", T0);
  assert.equal((await g.ring(ring(T0 + 1000))).action, "open");
  assert.equal((await g.ring(ring(T0 + 20_000))).action, "wait-pass");
});

test("the door opens on the lock's acknowledgement; its confirmation is logged after", async (t) => {
  const { g } = setup();
  t.after(() => g.stopTimers());
  await g.tap("p-maya", T0);
  await g.ring(ring(T0 + 1000));
  await new Promise((r) => setTimeout(r, 5));
  const kinds = g.s.log.map((l) => l.kind);
  assert.ok(kinds.indexOf("open") < kinds.indexOf("confirm"));
});

test("a doorbell webhook that arrives late still pairs with a tap made after the press", async (t) => {
  const { g } = setup();
  t.after(() => g.stopTimers());
  // Pressed at T0+60s, tapped at T0+80s, webhook delivered (retry) at T0+90s.
  assert.equal((await g.tap("p-maya", T0 + 80_000)).action, "wait-ring");
  assert.equal((await g.ring(ring(T0 + 60_000), T0 + 90_000)).action, "open");
});

test("a double tap waits as one tap: the second doorbell doesn't open", async (t) => {
  const { g } = setup();
  t.after(() => g.stopTimers());
  await g.tap("p-maya", T0);
  await g.tap("p-maya", T0 + 2_000);
  assert.equal((await g.ring(ring(T0 + 10_000))).action, "open");
  assert.equal((await g.ring(ring(T0 + 20_000))).action, "wait-pass");
});

test("a manager's approval doesn't report a doorbell-to-lock time", async (t) => {
  const { g } = setup();
  t.after(() => g.stopTimers());
  const r = await g.ring(ring(T0 + 70 * MIN));
  assert.equal(r.action, "request");
  const o = await g.decide((r as { requestId: string }).requestId, true, "Manager", T0 + 70 * MIN + 30_000);
  assert.equal(o.action, "open");
  assert.equal(g.s.log.findLast((l) => l.kind === "open")!.latencyMs, undefined);
});

test("after a restart with the door unlocked, it locks", async (t) => {
  const { g, lock } = setup();
  t.after(() => g.stopTimers());
  await lock.unlock();
  await g.recover(T0);
  assert.equal(lock.s, "locked");
});

test("staff on site: a pass tap doesn't open, it says to ring for staff", async (t) => {
  const { g, lock } = setup({ from: 0, to: 24 });
  t.after(() => g.stopTimers());
  const o = await g.tap("p-maya", T0 + MIN);
  assert.equal(o.action, "deny");
  assert.match((o as { reason: string }).reason, /Staff are on site/);
  assert.equal(lock.s, "locked");
});

test("a lock that's offline: pass + doorbell still leave the door shut, logged for that member", async (t) => {
  const { OutageLock, SimulatedLock } = await import("../src/lock.ts");
  const s = setup().g.s;
  const lock = new OutageLock(new SimulatedLock(0));
  lock.offline = true;
  const g = new Gate(s, lock);
  t.after(() => g.stopTimers());
  await g.tap("p-maya", T0 + MIN);
  const o = await g.ring(ring(T0 + MIN + 5_000));
  assert.equal(o.action, "deny");
  const err = g.s.log.findLast((l) => l.kind === "lock-error")!;
  assert.equal(err.memberId, "maya");
  assert.match(err.text, /Door stays closed/);
});
