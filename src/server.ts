// DoorPass server: Ring webhooks and member passes in, lock commands and an audit log out, plus the
// MCP endpoint for Alexa+.
//
//   RING_CREDENTIALS_FILE   app-credentials CSV from the Ring Developer Console (Client ID/Secret, HMAC key)
//   RING_TOKEN / RING_TOKEN_FILE   a Playground token, used until a Ring account is linked
//   SWITCHBOT_FILE          {"token","secret","deviceId"} for the real lock; without it a simulated lock is used
//   PORT (8842), HOST (127.0.0.1), DATA (./data/state.json), DOORPASS_TZ (America/Los_Angeles)

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Gate, time, type LogEntry } from "./gate.ts";
import { RingClient, parseWebhook, verify } from "./ring.ts";
import { Store, demoState } from "./store.ts";
import { buildMcp } from "./mcp.ts";
import { makeWebhook, deliver } from "./simulate.ts";
import { Linker, readCredentials } from "./link.ts";
import { SimulatedLock, SwitchBotLock, type Lock } from "./lock.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WEB = join(ROOT, "web");
const PORT = Number(process.env.PORT ?? 8842);
const TZ = process.env.DOORPASS_TZ ?? "America/Los_Angeles";
const DATA = process.env.DATA ?? join(ROOT, "data/state.json");
const HOME = process.env.HOME ?? "";
const MAX_BODY = 64 * 1024;
const SIM_DOOR = "sim.ring.device.front-door";

function localSecret(name: string): string {
  const f = join(ROOT, "data", name);
  if (!existsSync(f)) {
    mkdirSync(join(ROOT, "data"), { recursive: true });
    writeFileSync(f, randomBytes(18).toString("base64url"), { mode: 0o600 });
  }
  return readFileSync(f, "utf8").trim();
}

const creds = readCredentials(process.env.RING_CREDENTIALS_FILE ?? join(HOME, ".config/ring-hack/carebell_app_credentials.csv"));
const KEY = creds?.hmacKey ?? process.env.RING_HMAC_KEY ?? localSecret("hmac.key");
/** The manager's key: approvals, settings and the demo controls. The dashboard takes it as #key=… */
const MANAGER_KEY = process.env.MANAGER_KEY ?? localSecret("manager.key");
const AGENCY_PASSCODE = process.env.AGENCY_PASSCODE ?? localSecret("link.passcode");

// Every Ring and lock API call, without secrets, for the dashboard and the video.
const apiLog: { at: number; method: string; path: string; status: number; ms: number }[] = [];
const loggedFetch: typeof fetch = async (input, init) => {
  const t0 = Date.now();
  const url = new URL(String(input));
  const r = await fetch(input, init);
  const path = (url.host === "api.amazonvision.com" ? "" : url.host) + url.pathname.replace(/ava1\.ring\.(device|account)\.\w{8}\w+/g, (m) => m.slice(0, 26) + "…").replace(/(\/devices\/)([0-9A-F]{8,})/i, "$1…");
  apiLog.push({ at: Date.now(), method: init?.method ?? "GET", path, status: r.status, ms: Date.now() - t0 });
  if (apiLog.length > 60) apiLog.shift();
  return r;
};

function makeLock(): Lock {
  const f = process.env.SWITCHBOT_FILE ?? join(HOME, ".config/doorpass/switchbot.json");
  if (existsSync(f)) {
    try {
      const c = JSON.parse(readFileSync(f, "utf8"));
      if (c.token && c.secret && c.deviceId) return new SwitchBotLock({ ...c, name: c.name ?? "SwitchBot Lock Vision", fetchFn: loggedFetch });
    } catch {
      /* fall through */
    }
  }
  return new SimulatedLock();
}
const lock = makeLock();

const linker = creds ? new Linker(creds, join(ROOT, "data/tokens.json"), loggedFetch) : undefined;
function playgroundToken(): string | undefined {
  if (process.env.RING_TOKEN) return process.env.RING_TOKEN;
  const f = process.env.RING_TOKEN_FILE ?? join(HOME, ".config/ring-hack/playground_token");
  return existsSync(f) ? readFileSync(f, "utf8").trim() : undefined;
}
async function token(): Promise<string> {
  return (await linker?.token().catch(() => undefined)) ?? playgroundToken() ?? "";
}
const ring = new RingClient(token, undefined, loggedFetch);
const ringStatus = { connected: false, via: "" as "" | "linked account" | "playground", device: null as null | { id: string; name: string; online: boolean }, error: "" };

const store = new Store(DATA, () => demoState(Date.now(), SIM_DOOR, TZ));
const gate = new Gate(store.state, lock);

// Live updates for the dashboard and member passes.
// Manager streams get member pass links; public ones (judges, member passes) don't.
const streams = new Map<ServerResponse, boolean>();
const push = (kind: string, data: unknown) => {
  for (const [s, full] of streams) {
    const d = kind === "state" ? snapshot(full) : data;
    s.write(`event: ${kind}\ndata: ${JSON.stringify(d)}\n\n`);
  }
};
setInterval(() => streams.forEach((_, s) => s.write(": ping\n\n")), 25_000);
gate.onChange = (e?: LogEntry) => {
  store.save();
  if (e) push("log", e);
  push("state", null);
};

function snapshot(full = false) {
  const now = Date.now();
  return {
    now,
    tz: TZ,
    site: gate.s.site,
    staffed: gate.staffedNow(now),
    lock: { kind: lock.kind, name: lock.name },
    members: gate.s.members.map((m) => ({ id: m.id, name: m.name, status: m.status, plan: m.plan, pass: full ? `/pass/${m.passToken}` : null })),
    manager: full,
    bookings: gate.s.bookings.filter((b) => b.end >= now - 3_600_000).sort((a, b) => a.start - b.start).map((b) => ({ ...b, name: gate.member(b.memberId)?.name, live: gate.live(now, b.memberId).some((x) => x.id === b.id) })),
    requests: gate.s.requests.filter((r) => r.status === "pending"),
    log: gate.s.log.slice(-40),
    ring: { ...ringStatus, log: apiLog.slice(-14) },
  };
}

async function connectRing() {
  if (!(await token())) {
    ringStatus.connected = false;
    ringStatus.error = "no token";
    return;
  }
  try {
    const [d] = await ring.devices();
    if (!d) throw new Error("no devices shared with DoorPass");
    ringStatus.connected = true;
    ringStatus.via = linker?.tokens.some((t) => t.status === "completed") ? "linked account" : "playground";
    ringStatus.device = { id: d.id, name: d.name, online: await ring.online(d.id) };
    ringStatus.error = "";
    if (gate.s.site.doorDeviceId !== d.id) {
      gate.s.site.doorDeviceId = d.id;
      store.save();
    }
  } catch (e) {
    ringStatus.connected = false;
    ringStatus.error = (e as Error).message.replace(/Bearer \S+/g, "").slice(0, 120);
  }
}

class TooLarge extends Error {}
const body = (req: IncomingMessage) =>
  new Promise<Buffer>((ok, bad) => {
    const parts: Buffer[] = [];
    let n = 0;
    req
      .on("data", (c: Buffer) => {
        n += c.length;
        if (n <= MAX_BODY) parts.push(c);
      })
      .on("end", () => (n > MAX_BODY ? bad(new TooLarge()) : ok(Buffer.concat(parts))))
      .on("error", bad);
  });
const jsonBody = async (req: IncomingMessage) => {
  try {
    return JSON.parse((await body(req)).toString() || "{}");
  } catch (e) {
    if (e instanceof TooLarge) throw e;
    return {};
  }
};
const json = (res: ServerResponse, code: number, data: unknown) => res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(data));
const same = (a: string | undefined, b: string) => !!a && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json" };

function linkPage(params: URLSearchParams, message = "") {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect Ring to DoorPass</title>
<link rel="stylesheet" href="/styles.css"><main class="panel narrow"><h2>Connect your Ring doorbell to DoorPass</h2>
<p class="muted">Sign in as the space's manager. DoorPass will receive doorbell presses and motion from the doors you chose in the Ring app, and nothing else.</p>
${message ? `<p class="warn">${esc(message)}</p>` : ""}
<form method="post" class="stack"><input type="hidden" name="nonce" value="${esc(params.get("nonce") ?? "")}"><input type="hidden" name="time" value="${esc(params.get("time") ?? "")}">
<label>Work email<input name="email" type="email" required></label><label>Manager passcode<input name="passcode" type="password" required></label>
<button class="primary">Sign in and connect</button></form></main>`;
}

async function route(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://x");
  const p = url.pathname;

  // Ring webhooks: verify the raw body, answer, then act.
  if (req.method === "POST" && p === "/webhooks/ring") {
    const raw = await body(req);
    if (!verify(KEY, raw, req.headers["x-signature"] as string)) return json(res, 401, { error: "Invalid signature" });
    let hook;
    try {
      hook = parseWebhook(raw);
    } catch {
      return json(res, 400, { error: "Unknown payload" });
    }
    json(res, 200, { status: "processed" });
    if (gate.s.seen.includes(hook.meta.request_id)) return;
    gate.s.seen.push(hook.meta.request_id);
    const a = hook.data.attributes;
    const e = { id: hook.data.id, deviceId: a.source, at: a.timestamp, subType: a.sub_type };
    push("ring", { type: hook.data.type, subType: a.sub_type, at: a.timestamp, receivedAt: Date.now() });
    if (hook.data.type === "button_press") await gate.ring(e, Date.now());
    else if (hook.data.type === "motion_detected") gate.motion(e, Date.now());
    else if (hook.data.type === "device_offline" || hook.data.type === "device_online") {
      ringStatus.device && (ringStatus.device.online = hook.data.type === "device_online");
      push("state", null);
    }
    return;
  }

  // Ring one-way account linking.
  if (req.method === "POST" && p === "/ring/token") {
    if (!linker) return json(res, 503, { error: "Ring app credentials not configured" });
    const raw = (await body(req)).toString();
    let code: string | undefined;
    try {
      const j = JSON.parse(raw);
      code = j.code ?? j.authorization_code;
    } catch {
      const f = new URLSearchParams(raw);
      code = f.get("code") ?? f.get("authorization_code") ?? undefined;
    }
    if (!code) return json(res, 400, { error: "missing code" });
    try {
      await linker.exchange(code);
      return json(res, 200, { status: "ok" });
    } catch (e) {
      console.error("token exchange:", (e as Error).message);
      return json(res, 502, { error: "exchange failed" });
    }
  }
  if (p === "/ring/link") {
    if (req.method !== "POST") return res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(linkPage(url.searchParams));
    const f = new URLSearchParams((await body(req)).toString());
    if (!same(f.get("passcode") ?? undefined, AGENCY_PASSCODE) || !/^[^@\s]+@[^@\s]+$/.test(f.get("email") ?? ""))
      return res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" }).end(linkPage(f, "That email or passcode isn't right."));
    if (!linker) return res.writeHead(503).end("Ring app credentials not configured");
    const r = await linker.claim(f.get("nonce") ?? "", f.get("time") ?? "", f.get("email")!);
    if (typeof r === "string") return res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" }).end(linkPage(f, r));
    await connectRing();
    push("state", null);
    return res.writeHead(303, { Location: "/?linked=1" }).end();
  }

  if (p === "/mcp") {
    let raw: unknown;
    if (req.method === "POST") {
      try {
        raw = JSON.parse((await body(req)).toString());
      } catch (e) {
        if (e instanceof TooLarge) return json(res, 413, { error: "too large" });
        return json(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      }
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const server = buildMcp(gate, Date.now, () => push("state", snapshot()));
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    return transport.handleRequest(req, res, raw);
  }

  const isManager = same(url.searchParams.get("key") ?? (req.headers["x-manager-key"] as string | undefined), MANAGER_KEY);
  if (p === "/api/state") return json(res, 200, snapshot(isManager));
  if (p === "/api/stream") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(`event: state\ndata: ${JSON.stringify(snapshot(isManager))}\n\n`);
    streams.set(res, isManager);
    req.on("close", () => streams.delete(res));
    return;
  }

  // Member passes: the token in the URL is the credential (like a hotel key link).
  const pm = p.match(/^\/api\/pass\/([\w-]{8,40})(\/tap)?$/);
  if (pm) {
    const m = gate.s.members.find((x) => x.passToken === pm[1]);
    if (!m) return json(res, 404, { error: "unknown pass" });
    if (pm[2] && req.method === "POST") {
      const o = await gate.tap(m.passToken, Date.now());
      return json(res, 200, o);
    }
    const now = Date.now();
    const b = gate.live(now, m.id)[0] ?? gate.s.bookings.filter((x) => x.memberId === m.id && x.end >= now).sort((a, c) => a.start - c.start)[0];
    const last = [...gate.s.log].reverse().find((l) => l.memberId === m.id);
    return json(res, 200, { site: gate.s.site.name, tz: TZ, member: { name: m.name, status: m.status, plan: m.plan }, booking: b ? { room: b.room, start: b.start, end: b.end, live: gate.live(now, m.id).some((x) => x.id === b.id) } : null, last: last ? { kind: last.kind, text: last.text, at: last.at } : null, staffed: gate.staffedNow(now) });
  }
  if (/^\/pass\/[\w-]{8,40}$/.test(p)) return res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(readFileSync(join(WEB, "pass.html")));

  // Manager actions and demo controls need the manager key.
  if (req.method === "POST" && (p.startsWith("/api/manage/") || p.startsWith("/api/demo/"))) {
    if (!same(req.headers["x-manager-key"] as string | undefined, MANAGER_KEY)) return json(res, 403, { error: "manager key required" });
    const b = await jsonBody(req);
    if (p === "/api/manage/decide") {
      if (typeof b.requestId !== "string") return json(res, 400, { error: "requestId" });
      return json(res, 200, await gate.decide(b.requestId, !!b.approve, "Manager (dashboard)", Date.now()));
    }
    if (p === "/api/manage/staffed") {
      gate.s.site.staffed = b.on ? { from: 0, to: 24 } : undefined;
      gate.onChange();
      return json(res, 200, { staffed: gate.staffedNow(Date.now()) });
    }
    if (p === "/api/demo/ring" || p === "/api/demo/motion") {
      const hook = p.endsWith("ring") ? makeWebhook("button_press", gate.s.site.doorDeviceId) : makeWebhook("motion_detected", gate.s.site.doorDeviceId, { subType: "human" });
      return json(res, 200, { status: await deliver(`http://127.0.0.1:${PORT}/webhooks/ring`, KEY, hook) });
    }
    if (p === "/api/demo/reset") {
      gate.stopTimers();
      const fresh = demoState(Date.now(), gate.s.site.doorDeviceId, TZ);
      Object.assign(gate.s, { ...fresh, site: { ...fresh.site, staffed: undefined }, seen: gate.s.seen });
      gate.onChange();
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: "not found" });
  }

  const file = normalize(join(WEB, p === "/" ? "index.html" : p));
  if (file.startsWith(WEB + sep) && existsSync(file)) {
    res.writeHead(200, { "Content-Type": TYPES[file.slice(file.lastIndexOf("."))] ?? "application/octet-stream" });
    return res.end(readFileSync(file));
  }
  json(res, 404, { error: "not found" });
}

createServer((req, res) =>
  route(req, res).catch((e) => {
    if (e instanceof TooLarge) return json(res, 413, { error: "too large" });
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: "server error" });
  }),
).listen(PORT, process.env.HOST ?? "127.0.0.1", async () => {
  console.log(`DoorPass on http://localhost:${PORT}  (MCP /mcp, Ring /webhooks/ring /ring/token /ring/link)`);
  console.log(`Lock: ${lock.name} (${lock.kind}); Ring app credentials ${creds ? "loaded" : "missing"}`);
  await connectRing();
  console.log(ringStatus.connected ? `Ring: "${ringStatus.device?.name}" via ${ringStatus.via}` : `Ring: not connected (${ringStatus.error})`);
  setInterval(() => {
    const before = gate.s.requests.filter((r) => r.status === "pending").length;
    gate.expire(Date.now());
    if (gate.s.requests.filter((r) => r.status === "pending").length !== before) gate.onChange();
  }, 2_000);
  setInterval(async () => {
    await connectRing();
    push("state", null);
  }, 60_000);
  void time;
});
