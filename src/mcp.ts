// DoorPass for Alexa+: an MCP server (Streamable HTTP, protocol 2025-11-25; older clients negotiate
// down) for the space's manager. "Alexa, who's at the studio door?" → who_is_at_door, with an MCP App
// card that carries Let in / Keep closed buttons; "Let them in" → let_them_in.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type Gate, time } from "./gate.ts";
import { doorCardHtml } from "./card.ts";

const CARD = "ui://doorpass/door-card";

export function buildMcp(gate: Gate, now: () => number, afterChange: () => void, manager = "Manager (Alexa)") {
  const server = new McpServer(
    { name: "doorpass", version: "0.1.0" },
    { instructions: "DoorPass runs the front door of an unstaffed space with a Ring doorbell, the booking system and a smart lock. Answer in one or two spoken sentences; the card shows the detail. Only call let_them_in after the manager clearly says to." },
  );
  const tz = gate.s.site.tz;
  const ui = { ui: { resourceUri: CARD } };

  const door = () => {
    const t = now();
    gate.expire(t);
    const req = [...gate.s.requests].reverse().find((r) => r.status === "pending");
    const ring = req ? gate.s.rings.find((r) => r.id === req.ringId) : [...gate.s.rings].reverse()[0];
    const live = gate.live(t).map((b) => ({ name: gate.member(b.memberId)!.name, room: b.room, until: b.end }));
    const recent = gate.s.log.slice(-6).reverse().map((l) => ({ at: l.at, kind: l.kind, text: l.text, flags: l.flags ?? [] }));
    return { site: gate.s.site.name, now: t, tz, staffed: gate.staffedNow(t), request: req ? { id: req.id, reason: req.reason, at: req.at, expiresAt: req.expiresAt } : null, lastRing: ring ? ring.at : null, booked: live, recent };
  };

  // The request a tool should act on: the one named if it is still open, otherwise the open one.
  // (An agent may pass a made-up id; it must not turn into a silent no-op.)
  const openRequest = (requestId?: string) => {
    const pending = gate.s.requests.filter((r) => r.status === "pending");
    return (pending.find((r) => r.id === requestId) ?? pending.at(-1))?.id;
  };

  server.registerResource("door-card", CARD, { mimeType: "text/html;profile=mcp-app", description: "The door: who rang, why, and Let in / Keep closed." }, async () => ({
    contents: [{ uri: CARD, mimeType: "text/html;profile=mcp-app", text: doorCardHtml() }],
  }));

  server.registerTool(
    "who_is_at_door",
    { title: "Who's at the door?", description: "Who rang the doorbell, whether they have a booking, and whether DoorPass is waiting for the manager.", inputSchema: {}, _meta: ui },
    async () => {
      const d = door();
      const ago = d.lastRing ? Math.round((d.now - d.lastRing) / 1000) : null;
      const text = d.request
        ? `Someone rang ${ago} seconds ago. ${d.request.reason}. ${d.booked.length ? `Booked now: ${d.booked.map((b) => b.name).join(", ")}.` : ""} Say "let them in" or "keep it closed".`
        : d.lastRing
          ? `The last ring was ${ago! < 120 ? `${ago} seconds ago` : `at ${time(d.lastRing, tz)}`}. Nothing is waiting for you.`
          : "Nobody has rung today.";
      return { content: [{ type: "text", text }], structuredContent: d };
    },
  );

  server.registerTool(
    "let_them_in",
    {
      title: "Let them in",
      description: "Open the door for the visitor DoorPass is asking about. Only when the manager says so.",
      inputSchema: { requestId: z.string().optional().describe("Defaults to the open request") },
      _meta: ui,
    },
    async ({ requestId }) => {
      const id = openRequest(requestId);
      if (!id) return { content: [{ type: "text", text: "Nobody is waiting at the door." }], structuredContent: door() };
      const o = await gate.decide(id, true, manager, now());
      afterChange();
      const text = o.action === "open" ? "The door is open. It locks again in a few seconds." : `I couldn't open it: ${"reason" in o ? o.reason : o.action}.`;
      return { content: [{ type: "text", text }], structuredContent: door() };
    },
  );

  server.registerTool(
    "keep_door_closed",
    { title: "Keep it closed", description: "Refuse the visitor DoorPass is asking about.", inputSchema: { requestId: z.string().optional() }, _meta: ui },
    async ({ requestId }) => {
      const id = openRequest(requestId);
      if (!id) return { content: [{ type: "text", text: "Nobody is waiting at the door." }], structuredContent: door() };
      const o = await gate.decide(id, false, manager, now());
      afterChange();
      const text = o.action === "deny" && o.reason === "Denied by the manager" ? "Okay, the door stays locked." : `Nothing to refuse: ${"reason" in o ? o.reason : o.action}.`;
      return { content: [{ type: "text", text }], structuredContent: door() };
    },
  );

  server.registerTool(
    "door_log",
    {
      title: "Who came in?",
      description: "Door openings, refusals and flags (like possible tailgating) over a recent period.",
      inputSchema: { hours: z.number().min(1).max(72).optional().describe("How far back, default 12") },
    },
    async ({ hours }) => {
      const since = now() - (hours ?? 12) * 3_600_000;
      const rows = gate.s.log.filter((l) => l.at >= since && ["open", "deny", "expire", "enter", "lock-error"].includes(l.kind));
      const opens = rows.filter((l) => l.kind === "open").length;
      const flags = rows.filter((l) => l.flags?.length);
      const text = `${opens} openings in the last ${hours ?? 12} hours${flags.length ? `, ${flags.length} flagged (${flags.map((f) => f.flags!.join(", ")).join("; ")})` : ", nothing flagged"}.`;
      return { content: [{ type: "text", text }], structuredContent: { rows: rows.slice(-40).map((l) => ({ at: l.at, kind: l.kind, text: l.text, flags: l.flags ?? [], latencyMs: l.latencyMs })) } };
    },
  );

  server.registerTool(
    "todays_bookings",
    { title: "Bookings", description: "Who is booked from now on, and who is in now.", inputSchema: {} },
    async () => {
      const t = now();
      const rows = gate.s.bookings
        .filter((b) => b.end >= t)
        .sort((a, b) => a.start - b.start)
        .map((b) => ({ name: gate.member(b.memberId)!.name, status: gate.member(b.memberId)!.status, room: b.room, start: b.start, end: b.end }));
      return { content: [{ type: "text", text: rows.map((r) => `${time(r.start, tz)}–${time(r.end, tz)} ${r.name}, ${r.room}${r.status !== "active" ? ` (membership ${r.status})` : ""}`).join("\n") || "No more bookings today." }], structuredContent: { rows } };
    },
  );

  return server;
}
