// DoorPass manager dashboard, plus a simulated Alexa+ that talks to the DoorPass MCP server over
// Streamable HTTP and hosts its MCP App card (including the card's Let in / Keep closed buttons).

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
let TZ;
const tm = (ms) => new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: TZ });
const tms = (ms) => new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", timeZone: TZ });
const SANDBOX = document.documentElement.dataset.sandbox === "1";
// In the judges' sandbox every visitor gets the manager controls (the server accepts any key there).
const KEY = new URLSearchParams(location.hash.slice(1)).get("key") ?? (SANDBOX ? "sandbox" : "");
let S = null;
const seen = new Set();

function doorOpen(s) {
  const last = [...s.log].reverse().find((l) => l.kind === "open" || l.kind === "relock");
  return last && last.kind === "open" && Date.now() - last.at < 15_000;
}

const LOCKED = '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><rect x="5" y="11" width="14" height="10" rx="2.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';
const OPENED = '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><rect x="5" y="11" width="14" height="10" rx="2.5"/><path d="M8 11V8a4 4 0 0 1 7.6-1.7"/></svg>';
const GLYPH = { ring: "🔔", pass: "📱", open: "✓", confirm: "✓", relock: "🔒", request: "?", approve: "✓", deny: "✕", expire: "⏱", enter: "👤", notify: "🔔", "lock-error": "!" };
const sec = (ms) => `${(ms / 1000).toFixed(1)} s`;
// Ring's photo of whoever pressed the doorbell (manager view only).
const snap = (ringId) => {
  const f = ringId && S?.snaps?.[ringId];
  return f ? `/api/snap/${encodeURIComponent(f)}?key=${encodeURIComponent(KEY)}` : "";
};

function render(s) {
  const first = !S;
  S = s;
  TZ = s.tz;
  $("#site").textContent = s.site.name;
  const r = s.ring;
  $("#ring-chip").className = "chip" + (r.connected ? " on" : r.error === "simulated" ? " sim" : "");
  $("#ring-text").textContent = r.connected ? `Ring · ${r.device.name}` : `Ring · ${/401/.test(r.error) ? "token expired" : r.error || "not connected"}`;
  $("#lock-chip").className = "chip " + (s.lock.offline ? "" : s.lock.kind === "switchbot" ? "on" : "sim");
  $("#lock-text").textContent = (s.lock.kind === "switchbot" ? s.lock.name : "Simulated lock") + (s.lock.offline ? " · offline" : "");
  $("#mode-off").setAttribute("aria-pressed", String(!s.staffed));
  $("#mode-on").setAttribute("aria-pressed", String(!!s.staffed));

  const open = doorOpen(s);
  $("#door").className = "door " + (open ? "open" : "locked");
  $("#door-icon").innerHTML = open ? OPENED : LOCKED;
  $("#door-state").textContent = open ? "Open" : "Locked";
  const lastOpen = [...s.log].reverse().find((l) => l.kind === "open");
  $("#door-sub").textContent = lastOpen ? `Last opened ${tm(lastOpen.at)}` : s.staffed ? "Staff on site · the doorbell only announces" : "Runs itself · nobody at the desk";
  // Timings come from the last opening the doorbell itself caused (a manager's approval has no doorbell timing).
  const timedOpen = [...s.log].reverse().find((l) => l.kind === "open" && l.latencyMs != null);
  const lat = timedOpen?.latencyMs;
  const conf = timedOpen ? s.log.find((l) => l.kind === "confirm" && l.ringId === timedOpen.ringId && l.latencyMs != null) : null;
  $("#metrics").hidden = lat == null && !conf;
  $("#latency-v").textContent = lat != null ? sec(lat) : "—";
  $("#confirm-v").textContent = conf ? sec(conf.latencyMs) : "—";

  const req = s.requests[0];
  $("#request").innerHTML = req
    ? `<div class="req">${snap(req.ringId) ? `<img class="req-snap" src="${snap(req.ringId)}" alt="Ring photo of the visitor">` : ""}${S.notes?.[req.ringId] ? `<p class="note">${esc(S.notes[req.ringId])}</p>` : ""}<b>Someone is at the door</b><div class="m">${esc(req.reason)} · rang ${tms(req.at)} · closes in <span id="left"></span></div>${KEY ? `<div class="btns"><button class="in" data-decide="1">Let in</button><button data-decide="0">Keep closed</button></div>` : ""}</div>`
    : "";
  document.querySelectorAll("[data-decide]").forEach((b) => (b.onclick = () => manage("/api/manage/decide", { requestId: req.id, approve: b.dataset.decide === "1" })));

  $("#bookings").innerHTML =
    s.bookings
      .map((b) => {
        const m = s.members.find((x) => x.id === b.memberId);
        const [cls, label] = m && m.status !== "active" ? ["bad", `Membership ${m.status}`] : b.live ? ["live", "Now"] : b.start > s.now ? ["", "Later"] : ["", "Ended"];
        return `<div class="row"><div class="main">${esc(b.name)}<small>${esc(b.room)} · ${tm(b.start)}–${tm(b.end)}</small></div><span class="badge ${cls}">${label}</span></div>`;
      })
      .join("") || `<div class="row"><div class="main muted">No bookings today</div></div>`;
  $("#members").innerHTML = s.members
    .map((m) => `<div class="row"><div class="main">${esc(m.name)}<small>${esc(m.plan)}</small></div>${m.status !== "active" ? `<span class="badge bad">${esc(m.status)}</span>` : ""}${m.pass ? `<a href="${esc(m.pass)}" target="_blank" rel="noopener">Pass</a>` : ""}</div>`)
    .join("");

  if (first) s.log.forEach((l) => seen.add(l.id));
  $("#log").innerHTML =
    s.log
      .slice()
      .reverse()
      .map((l) => {
        const fresh = !seen.has(l.id);
        seen.add(l.id);
        const ev = (l.evidence ?? []).map((e) => `<span>${esc(e.split(":")[0])}</span>`).join("") + (l.latencyMs != null ? `<span>${sec(l.latencyMs)}</span>` : "");
        const flags = (l.flags ?? []).map((f) => ` <span class="flag">⚠ ${esc(f)}</span>`).join("");
        const photo = ["ring", "request", "open", "notify"].includes(l.kind) ? snap(l.ringId) : "";
        return `<div class="row ic-row${fresh ? " new" : ""}"><div class="glyph g-${esc(l.kind)}" title="${esc(l.kind)}">${GLYPH[l.kind] ?? "•"}</div><div class="main">${esc(l.text)}${flags}${ev ? `<div class="ev">${ev}</div>` : ""}${photo ? `<a href="${photo}" target="_blank" rel="noopener"><img class="log-snap" src="${photo}" alt="Ring photo"></a>${S.notes?.[l.ringId] ? `<div class="note">${esc(S.notes[l.ringId])}</div>` : ""}` : ""}</div><time>${tms(l.at)}</time></div>`;
      })
      .join("") || `<div class="row"><div class="main muted">Nothing yet tonight</div></div>`;
  $("#api").innerHTML = r.log.slice().reverse().map((a) => `<li><time>${tms(a.at)}</time> <b>${esc(a.method)}</b> ${esc(a.path)} → ${esc(a.status)} <span class="muted">${esc(a.ms)} ms</span></li>`).join("") || "<li class=\"muted\">No calls yet</li>";
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
$("#mode-off").onclick = () => KEY && S.staffed && manage("/api/manage/staffed", { on: false });
$("#mode-on").onclick = () => KEY && !S.staffed && manage("/api/manage/staffed", { on: true });
if (!KEY) document.querySelectorAll(".seg button").forEach((b) => (b.disabled = true));
if (KEY) $("#demo").hidden = false;
if (SANDBOX) $("#sandbox-banner").hidden = false;
document.querySelectorAll("[data-demo]").forEach((b) => (b.onclick = () => manage(`/api/demo/${b.dataset.demo}`, {})));

// ---- Alexa+ (simulated): MCP client over Streamable HTTP, hosting the MCP App card ----
let rpcId = 1;
const mcpLog = (dir, m) => ($("#mcp-log").textContent = `${dir} ${JSON.stringify(m).slice(0, 360)}\n` + $("#mcp-log").textContent.slice(0, 4000));
async function mcp(method, params) {
  const msg = { jsonrpc: "2.0", id: rpcId++, method, params };
  mcpLog("→", msg);
  const r = await fetch("/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25", ...(KEY ? { Authorization: `Bearer ${KEY}` } : {}) }, body: JSON.stringify(msg) });
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
let agent = true; // Amazon Bedrock agent; falls back to fixed phrases if the server has no Bedrock key.
function say(text) {
  $("#reply").textContent = text;
  if ("speechSynthesis" in window) {
    speechSynthesis.cancel();
    speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  }
}
async function askAgent(said) {
  $("#said").textContent = `“Alexa, ${said}”`;
  $("#reply").textContent = "…";
  $("#steps").hidden = true;
  const r = await fetch(`/api/ask${KEY ? `?key=${encodeURIComponent(KEY)}` : ""}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ said }) });
  if (r.status === 503) return false;
  const j = await r.json();
  if (!r.ok) {
    $("#reply").textContent = j.error || "Alexa couldn't answer.";
    return true;
  }
  $("#steps").innerHTML = j.steps.map((s) => `<li>${esc(s.tool)}</li>`).join("") + `<li>${esc(j.model.replace(/^us\./, ""))} · ${(j.ms / 1000).toFixed(1)} s</li>`;
  $("#steps").hidden = false;
  $("#brain").textContent = "Amazon Bedrock agent · real MCP server";
  say(j.text);
  show(await mcp("tools/call", { name: "who_is_at_door", arguments: {} }), false);
  return true;
}
async function ask(k) {
  const [tool, said] = SAY[k];
  try {
    if (agent && (await askAgent(said))) return;
    agent = false;
    $("#said").textContent = `“Alexa, ${said}”`;
    show(await mcp("tools/call", { name: tool, arguments: k === "log" ? { hours: 12 } : {} }));
    if (k === "in" || k === "out") show(await mcp("tools/call", { name: "who_is_at_door", arguments: {} }), false);
  } catch (e) {
    $("#reply").textContent = `DoorPass isn't answering (${e.message}).`;
  }
}
// Without the manager key, Alexa can tell you who's there but not open the door.
if (!KEY) document.querySelectorAll('[data-q="in"], [data-q="out"]').forEach((b) => b.remove());
document.querySelectorAll("[data-q]").forEach((b) => (b.onclick = () => ask(b.dataset.q)));
$("#ask-form").onsubmit = async (e) => {
  e.preventDefault();
  const said = $("#ask-input").value.trim();
  if (!said) return;
  $("#ask-input").value = "";
  try {
    if (!(await askAgent(said))) $("#reply").textContent = "Free questions need the Bedrock agent; try the buttons.";
  } catch (err) {
    $("#reply").textContent = `Alexa couldn't answer (${err.message}).`;
  }
};
// Speak instead of typing (Chrome and Safari).
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
if (!SR) $("#mic").hidden = true;
else
  $("#mic").onclick = () => {
    const rec = new SR();
    rec.lang = "en-US";
    rec.interimResults = false;
    $("#mic").classList.add("on");
    rec.onresult = (e) => {
      $("#ask-input").value = e.results[0][0].transcript.replace(/^alexa,?\s*/i, "");
      $("#ask-form").requestSubmit();
    };
    rec.onend = () => $("#mic").classList.remove("on");
    rec.start();
  };

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
