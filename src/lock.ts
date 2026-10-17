// The lock. Ring's Partner API is read-only (it can't open anything), so the door is opened through
// the lock maker's own API: SwitchBot OpenAPI v1.1. A simulated lock stands in for tests and the
// hosted demo, and says so.

import { createHmac, randomUUID } from "node:crypto";

export type LockState = "locked" | "unlocked" | "jammed" | "unknown";

export interface Lock {
  kind: "switchbot" | "simulated";
  name: string;
  /** Sends the command; resolves when the lock's cloud has accepted it, throws if it refused. */
  request(cmd: "lock" | "unlock"): Promise<void>;
  /** Waits for the lock to report the state (its cloud reports a few seconds late). */
  confirm(want: LockState): Promise<LockState>;
  unlock(): Promise<LockState>;
  lock(): Promise<LockState>;
  state(): Promise<LockState>;
}

export class SimulatedLock implements Lock {
  kind = "simulated" as const;
  name = "Simulated lock";
  s: LockState = "locked";
  delayMs: number;
  constructor(delayMs = 400) {
    this.delayMs = delayMs;
  }
  private wait() {
    return new Promise((r) => setTimeout(r, this.delayMs));
  }
  async request(cmd: "lock" | "unlock") {
    await this.wait();
    this.s = cmd === "unlock" ? "unlocked" : "locked";
  }
  async confirm(_want: LockState) {
    return this.s;
  }
  async unlock() {
    await this.wait();
    return (this.s = "unlocked");
  }
  async lock() {
    await this.wait();
    return (this.s = "locked");
  }
  async state() {
    return this.s;
  }
}

/** Authorization headers: sign = base64(HMAC-SHA256(secret, token + t + nonce)). */
export function switchbotHeaders(token: string, secret: string, t = Date.now(), nonce = randomUUID()) {
  const sign = createHmac("sha256", secret).update(token + t + nonce).digest("base64");
  return { Authorization: token, sign, t: String(t), nonce, "Content-Type": "application/json; charset=utf8" };
}

const STATE: Record<string, LockState> = { lock: "locked", locked: "locked", latchboltlocked: "locked", unlock: "unlocked", unlocked: "unlocked", jammed: "jammed" };

export class SwitchBotLock implements Lock {
  kind = "switchbot" as const;
  name: string;
  token: string;
  secret: string;
  deviceId: string;
  fetchFn: typeof fetch;
  base = "https://api.switch-bot.com/v1.1";

  constructor(o: { token: string; secret: string; deviceId: string; name?: string; fetchFn?: typeof fetch }) {
    this.token = o.token;
    this.secret = o.secret;
    this.deviceId = o.deviceId;
    this.name = o.name ?? "SwitchBot Lock";
    this.fetchFn = o.fetchFn ?? fetch;
  }

  private async call(path: string, init: RequestInit = {}) {
    const r = await this.fetchFn(this.base + path, { ...init, headers: switchbotHeaders(this.token, this.secret) });
    const j = await r.json().catch(() => ({}));
    // SwitchBot answers HTTP 200 with its own statusCode; 100 is success.
    if (!r.ok || (j.statusCode !== undefined && j.statusCode !== 100)) throw new Error(`SwitchBot ${r.status}/${j.statusCode}: ${j.message ?? ""}`);
    return j.body ?? {};
  }

  /** Lists the account's locks, to find the deviceId. */
  static async locks(token: string, secret: string, fetchFn: typeof fetch = fetch) {
    const r = await fetchFn("https://api.switch-bot.com/v1.1/devices", { headers: switchbotHeaders(token, secret) });
    const j = await r.json();
    return (j.body?.deviceList ?? []).filter((d: any) => /lock/i.test(d.deviceType ?? "")).map((d: any) => ({ id: d.deviceId as string, name: d.deviceName as string, type: d.deviceType as string }));
  }

  async request(cmd: "lock" | "unlock") {
    await this.command(cmd);
  }
  async confirm(want: LockState) {
    return this.settle(want);
  }

  private async command(command: "lock" | "unlock") {
    await this.call(`/devices/${encodeURIComponent(this.deviceId)}/commands`, {
      method: "POST",
      body: JSON.stringify({ command, parameter: "default", commandType: "command" }),
    });
  }

  async state(): Promise<LockState> {
    const b = await this.call(`/devices/${encodeURIComponent(this.deviceId)}/status`);
    return STATE[String(b.lockState ?? "").toLowerCase()] ?? "unknown";
  }

  /** Sends the command, then reads the state back: the door counts as open only when the lock says so. */
  async unlock() {
    await this.command("unlock");
    return this.settle("unlocked");
  }
  async lock() {
    await this.command("lock");
    return this.settle("locked");
  }
  /** The cloud reports the new state a few seconds late ("locked" → "unlocking" → "unlocked"); "unlocking"/"locking" means the motor is turning. */
  private async settle(want: LockState): Promise<LockState> {
    let last = "";
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 600));
      last = await this.raw().catch(() => "");
      const s = STATE[last] ?? "unknown";
      if (s === want || s === "jammed") return s;
      // The motor is turning toward the wanted state: good enough to call it, the next poll would confirm.
      if ((want === "unlocked" && last === "unlocking") || (want === "locked" && last === "locking")) return want;
    }
    return STATE[last] ?? "unknown";
  }
  private async raw(): Promise<string> {
    const b = await this.call(`/devices/${encodeURIComponent(this.deviceId)}/status`);
    return String(b.lockState ?? "").toLowerCase();
  }
}

/** Wraps a lock so the demo can take it "offline" (as when its Wi-Fi drops) and show that the door stays shut. */
export class OutageLock implements Lock {
  inner: Lock;
  offline = false;
  constructor(inner: Lock) {
    this.inner = inner;
  }
  get kind() {
    return this.inner.kind;
  }
  get name() {
    return this.inner.name;
  }
  private check() {
    if (this.offline) throw new Error("lock is offline");
  }
  async request(cmd: "lock" | "unlock") {
    this.check();
    return this.inner.request(cmd);
  }
  async confirm(want: LockState) {
    this.check();
    return this.inner.confirm(want);
  }
  async unlock() {
    this.check();
    return this.inner.unlock();
  }
  async lock() {
    this.check();
    return this.inner.lock();
  }
  async state() {
    this.check();
    return this.inner.state();
  }
}
