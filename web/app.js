// DoorPass manager dashboard, plus a simulated Alexa+ that talks to the DoorPass MCP server over
// Streamable HTTP and hosts its MCP App card (including the card's Let in / Keep closed buttons).

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
let TZ;
const tm = (ms) => new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: TZ });
const tms = (ms) => new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", timeZone: TZ });
const KEY = new URLSearchParams(location.hash.slice(1)).get("key") ?? "";
let S = null;
const seen = new Set();

function doorOpen(s) {
  const last = [...s.log].reverse().find((l) => l.kind === "open" || l.kind === "relock");
  return last && last.kind === "open" && Date.now() - last.at < 15_000;
}

function render(s) {
  const first = !S;
  S = s;
  TZ = s.tz;
  $("#site").textContent = `· ${s.site.name}`;
  const r = s.ring;
  $("#ring-chip").className = "chip" + (r.connected ? " on" : "");
  $("#ring-text").textContent = r.connected ? `Ring · ${r.device.name} (${r.via})` : `Ring · ${/401/.test(r.error) ? "token expired" : r.error || "not connected"}`;
  $("#lock-chip").className = "chip " + (s.lock.kind === "switchbot" ? "on" : "sim");
  $("#lock-text").textContent = s.lock.kind === "switchbot" ? `${s.lock.name}` : "Simulated lock";
  const st = $("#staffed");
  st.textContent = s.staffed ? "Staff on site: doorbell only announces" : "Unstaffed: door runs itself";
  st.classList.toggle("staffed", s.staffed);

  const open = doorOpen(s);
  $("#door").className = "panel door " + (open ? "open" : "locked");
  $("#door-state").textContent = open ? "Open" : "Locked";
  const lastOpen = [...s.log].reverse().find((l) => l.kind === "open");
  $("#door-sub").textContent = lastOpen ? `Last opened ${tm(lastOpen.at)}` : "";
  const lat = lastOpen?.latencyMs;
  $("#latency").hidden = lat == null;
  if (lat != null) $("#latency-v").textContent = `${(lat / 1000).toFixed(1)} s`;

  const req = s.requests[0];
  $("#request").innerHTML = req
    ? `<div class="req"><b>Someone is at the door</b><div class="m">${esc(req.reason)} · rang ${tms(req.at)} · closes in <span id="left"></span></div>${KEY ? `<div class="btns"><button class="in" data-decide="1">Let in</button><button data-decide="0">Keep closed</button></div>` : ""}</div>`
    : "";
  document.querySelectorAll("[data-decide]").forEach((b) => (b.onclick = () => manage("/api/manage/decide", { requestId: req.id, approve: b.dataset.decide === "1" })));

  $("#bookings").innerHTML =
    s.bookings
      .map((b) => {
        const m = s.members.find((x) => x.id === b.memberId);
        const [cls, label] = m && m.status !== "active" ? [m.status, `membership ${m.status}`] : b.live ? ["live", "can enter now"] : b.start > s.now ? ["", "later"] : ["", "ended"];
        return `<li><div>${esc(b.name)} <span class="sub">${esc(b.room)} · ${tm(b.start)}–${tm(b.end)}</span></div><span class="tag ${cls}">${label}</span></li>`;
      })
      .join("") || "<li>No bookings.</li>";
  $("#members").innerHTML = s.members
    .map((m) => `<li><div>${esc(m.name)} <span class="sub">${esc(m.plan)}</span></div>${m.status !== "active" ? `<span class="tag ${m.status}">${m.status}</span>` : ""}${m.pass ? `<a href="${m.pass}" target="_blank" rel="noopener">pass ↗</a>` : ""}</li>`)
    .join("");

  if (first) s.log.forEach((l) => seen.add(l.id));
  $("#log").innerHTML = s.log
    .slice()
    .reverse()
    .map((l) => {
      const fresh = !seen.has(l.id);
      seen.add(l.id);
      const ev = (l.evidence ?? []).map((e) => `<span>${esc(e.split(":")[0])}</span>`).join("") + (l.latencyMs != null ? `<span>${(l.latencyMs / 1000).toFixed(1)} s</span>` : "");
      return `<li class="${fresh ? "new" : ""}"><time>${tms(l.at)}</time><div><span class="k k-${l.kind}">${esc(l.kind)}</span>${esc(l.text)}${(l.flags ?? []).map((f) => ` <span class="flag">⚠ ${esc(f)}</span>`).join("")}${ev ? `<div class="ev">${ev}</div>` : ""}</div></li>`;
    })
    .join("");
  $("#api").innerHTML = r.log.slice().reverse().map((a) => `<li>${tms(a.at)} <b>${a.method}</b> ${esc(a.path)} → ${a.status} (${a.ms} ms)</li>`).join("") || "<li>—</li>";
}

setInterval(() => {
  const req = S?.requests[0];
  const el = $("#left");
  if (req && el) el.textContent = `${Math.max(0, Math.round((req.expiresAt - Date.now()) / 1000))} s`;
  if (S) {
    const open = doorOpen(S);
    if (($("#door-state").textContent === "Open") !== open) render(S);
  }
}, 500);

new EventSource(`/api/stream${KEY ? `?key=${encodeURIComponent(KEY)}` : ""}`).addEventListener("state", (e) => render(JSON.parse(e.data)));

const manage = (path, body) =>
  fetch(path, { method: "POST", headers: { "Content-Type": "application/json", "X-Manager-Key": KEY }, body: JSON.stringify(body) }).then((r) => {
    if (r.status === 403) alert("Manager actions need the key in the address (#key=…).");
    return r.json();
  });
$("#staffed").onclick = () => KEY && manage("/api/manage/staffed", { on: !S.staffed });
if (KEY) $("#demo").hidden = false;
document.querySelectorAll("[data-demo]").forEach((b) => (b.onclick = () => manage(`/api/demo/${b.dataset.demo}`, {})));

// ---- Alexa+ (simulated): MCP client over Streamable HTTP, hosting the MCP App card ----
let rpcId = 1;
const mcpLog = (dir, m) => ($("#mcp-log").textContent = `${dir} ${JSON.stringify(m).slice(0, 360)}\n` + $("#mcp-log").textContent.slice(0, 4000));
async function mcp(method, params) {
  const msg = { jsonrpc: "2.0", id: rpcId++, method, params };
  mcpLog("→", msg);
  const r = await fetch("/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25" }, body: JSON.stringify(msg) });
  const j = await r.json();
  mcpLog("←", j);
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
const frame = $("#card");
const cardReady = new Promise((ok) => (frame.onload = ok));
(async () => {
  try {
    await mcp("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "doorpass-alexa-sim", version: "0.1.0" } });
    frame.srcdoc = (await mcp("resources/read", { uri: "ui://doorpass/door-card" })).contents[0].text;
    await cardReady;
    show(await mcp("tools/call", { name: "who_is_at_door", arguments: {} }), false);
  } catch (e) {
    $("#reply").textContent = `The card didn't load (${e.message}).`;
  }
})();

function show(res, speak = true) {
  const text = res.content.map((c) => c.text).join(" ");
  $("#reply").textContent = text;
  if (res.structuredContent && "request" in res.structuredContent) frame.contentWindow.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: res }, "*");
  if (speak && "speechSynthesis" in window) {
    speechSynthesis.cancel();
    speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  }
}

const SAY = { who: ["who_is_at_door", "who's at the studio door?"], in: ["let_them_in", "let them in."], out: ["keep_door_closed", "keep it closed."], log: ["door_log", "who came in tonight?"] };
async function ask(k) {
  const [tool, said] = SAY[k];
  $("#said").textContent = `“Alexa, ${said}”`;
  $("#reply").textContent = "…";
  try {
    show(await mcp("tools/call", { name: tool, arguments: k === "log" ? { hours: 12 } : {} }));
    if (k === "in" || k === "out") show(await mcp("tools/call", { name: "who_is_at_door", arguments: {} }), false);
  } catch (e) {
    $("#reply").textContent = `DoorPass isn't answering (${e.message}).`;
  }
}
document.querySelectorAll("[data-q]").forEach((b) => (b.onclick = () => ask(b.dataset.q)));

// The card's buttons call tools through the host, as MCP Apps do.
addEventListener("message", async (e) => {
  if (e.source !== frame.contentWindow) return;
  const m = e.data || {};
  if (m.method === "tools/call" && ["let_them_in", "keep_door_closed"].includes(m.params?.name)) {
    $("#said").textContent = m.params.name === "let_them_in" ? "(tapped Let in on the card)" : "(tapped Keep closed on the card)";
    const res = await mcp("tools/call", m.params);
    show(res);
    frame.contentWindow.postMessage({ jsonrpc: "2.0", id: m.id, result: res }, "*");
  }
});
// A new ring refreshes the card, the way an Alexa+ notification would surface it.
new EventSource("/api/stream").addEventListener("log", async (e) => {
  const l = JSON.parse(e.data);
  if (["request", "open", "expire", "deny"].includes(l.kind)) show(await mcp("tools/call", { name: "who_is_at_door", arguments: {} }), false);
});
