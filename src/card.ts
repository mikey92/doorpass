// The MCP App card (ui://doorpass/door-card): rendered by the host in a sandboxed iframe, fed tool
// results over postMessage, and able to call let_them_in / keep_door_closed back through the host.

export function doorCardHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--bg:#0d1117;--card:#161d27;--ink:#eef3f7;--mute:#91a2b3;--ok:#3ecf8e;--warn:#f5b84b;--bad:#ff6b6b;--blue:#5fb3ff}
*{box-sizing:border-box}body{margin:0;font:15px/1.4 -apple-system,system-ui,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--ink)}
.wrap{padding:16px}h1{font-size:19px;margin:0}.sub{color:var(--mute);margin:2px 0 14px;font-size:13px}
.req{border:1px solid var(--warn);background:#2a2214;border-radius:14px;padding:14px;margin-bottom:12px}
.req b{display:block;font-size:17px;margin-bottom:4px}.req .m{color:#e8d3a6}
.btns{display:flex;gap:10px;margin-top:12px}button{flex:1;font:inherit;font-weight:600;border:0;border-radius:12px;padding:12px;cursor:pointer}
.in{background:var(--ok);color:#06150f}.no{background:#2b3440;color:var(--ink)}
.calm{border:1px solid #233041;border-radius:14px;padding:14px;margin-bottom:12px;color:var(--mute)}
ol{list-style:none;padding:0;margin:0}li{padding:8px 0;border-top:1px solid #1f2935;font-size:13px}
li time{color:var(--mute);margin-right:6px}.flag{color:var(--warn)}.open{color:var(--ok)}.deny,.expire,.lock-error{color:var(--bad)}
.booked{font-size:13px;color:var(--mute);margin-bottom:10px}
</style></head><body><div class="wrap" id="root"><p class="sub">Waiting for DoorPass…</p></div>
<script>
let TZ;const tm=ms=>new Date(ms).toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",timeZone:TZ});
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
let id=1;const call=(name,args)=>parent.postMessage({jsonrpc:"2.0",id:id++,method:"tools/call",params:{name,arguments:args}},"*");
function render(d){
  if(!d||!("request" in d))return;TZ=d.tz;
  const r=document.getElementById("root");
  let h="<h1>"+esc(d.site)+"</h1><p class='sub'>Front door · "+(d.staffed?"staff on site":"unstaffed")+" · "+tm(d.now)+"</p>";
  if(d.request){
    const left=Math.max(0,Math.round((d.request.expiresAt-d.now)/1000));
    h+="<div class='req'><b>Someone is at the door</b><div class='m'>"+esc(d.request.reason)+" · rang "+tm(d.request.at)+" · closes in "+left+" s</div><div class='btns'><button class='in' data-a='let_them_in'>Let in</button><button class='no' data-a='keep_door_closed'>Keep closed</button></div></div>";
  } else h+="<div class='calm'>Nobody is waiting. The door handles booked members by itself.</div>";
  if(d.booked&&d.booked.length)h+="<div class='booked'>Booked now: "+d.booked.map(b=>esc(b.name)+" ("+esc(b.room)+")").join(", ")+"</div>";
  h+="<ol>"+(d.recent||[]).map(l=>"<li class='"+esc(l.kind)+"'><time>"+tm(l.at)+"</time>"+esc(l.text)+(l.flags&&l.flags.length?" <span class='flag'>⚠ "+esc(l.flags.join(", "))+"</span>":"")+"</li>").join("")+"</ol>";
  r.innerHTML=h;
  r.querySelectorAll("button[data-a]").forEach(b=>b.onclick=()=>{b.disabled=true;call(b.dataset.a,{requestId:d.request.id})});
}
addEventListener("message",e=>{const m=e.data||{};
  if(m.method==="ui/notifications/tool-result")render(m.params&&(m.params.structuredContent||m.params));
  else if(m.result&&m.result.structuredContent)render(m.result.structuredContent);
});
parent.postMessage({jsonrpc:"2.0",id:id++,method:"ui/initialize",params:{appInfo:{name:"DoorPass door card",version:"0.1.0"},appCapabilities:{},protocolVersion:"2026-01-26"}},"*");
</script></body></html>`;
}
