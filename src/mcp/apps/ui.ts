/**
 * MCP Apps (spec 2026-01-26) UI for the staffing tools. Each app tool points at a
 * ui:// resource; the host renders that HTML in a sandboxed iframe and sends it the tool's
 * structuredContent. The page loads nothing from the network (inline CSS and JS only), so
 * its CSP declares no domains, and it never talks to this server directly.
 */

export const APP_MIME_TYPE = 'text/html;profile=mcp-app';
export const APP_VIEWS = ['schedule', 'allocation'] as const;
export type AppView = (typeof APP_VIEWS)[number];

const TITLES: Record<AppView, string> = {
  schedule: 'Conversation → site schedule',
  allocation: 'Cleaner / supervisor / trainer allocation',
};
/** The tool each view re-runs through the host if the host never sends a result. */
const TOOL_FOR_VIEW: Record<AppView, string> = {
  schedule: 'conversation_to_site_schedule',
  allocation: 'staff_allocation_board',
};

export const appUri = (view: AppView): string => `ui://tanda-workforce/${view}.html`;

export function viewForUri(uri: string): AppView | null {
  return APP_VIEWS.find((v) => appUri(v) === uri) ?? null;
}

/** Tool _meta: the spec's nested key plus the legacy flat key some hosts still read. */
export function appToolMeta(view: AppView): Record<string, unknown> {
  return { ui: { resourceUri: appUri(view) }, 'ui/resourceUri': appUri(view) };
}

export function appResources(): Array<Record<string, unknown>> {
  return APP_VIEWS.map((v) => ({ uri: appUri(v), name: TITLES[v], description: `Interactive view for ${TOOL_FOR_VIEW[v]}`, mimeType: APP_MIME_TYPE }));
}

export function appResourceContents(view: AppView): Record<string, unknown> {
  return {
    uri: appUri(view),
    mimeType: APP_MIME_TYPE,
    text: renderAppHtml(view),
    _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: true } },
  };
}

const CSS = String.raw`
:root{--blue:#0b4ea2;--ink:#1b2430;--mute:#5d6b7c;--line:#e3e8ef;--bg:#fff;--soft:#f4f7fb;--ok:#1f8a4c;--warn:#b26a00}
@media (prefers-color-scheme:dark){:root{--ink:#e8edf3;--mute:#9aa8b8;--line:#2c3644;--bg:#141a22;--soft:#1b2330;--blue:#5b9bff;--warn:#e0a040}}
*{box-sizing:border-box}body{margin:0;font:14px/1.45 -apple-system,Segoe UI,Roboto,sans-serif;color:var(--ink);background:var(--bg)}
.w{padding:14px}h1{font-size:17px;margin:0 0 2px}h2{font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--mute);margin:16px 0 6px}
.sub{color:var(--mute);font-size:12px}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}
.card{border:1px solid var(--line);border-radius:10px;padding:10px;background:var(--soft)}
.big{font-size:20px;font-weight:700}table{width:100%;border-collapse:collapse;font-size:13px}td,th{padding:5px 6px;border-bottom:1px solid var(--line);text-align:left}th{color:var(--mute);font-weight:600}
.pill{display:inline-block;padding:1px 8px;border-radius:99px;font-size:11px;background:var(--soft);border:1px solid var(--line);white-space:nowrap}
.pill.t{border-color:var(--blue);color:var(--blue)}.pill.lead{border-color:var(--ok);color:var(--ok)}
button{font:inherit;border:1px solid var(--blue);background:var(--blue);color:#fff;border-radius:8px;padding:6px 12px;cursor:pointer}button.g{background:transparent;color:var(--blue)}
select{font:inherit;padding:3px 6px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--ink)}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.chip{border:1px solid var(--line);border-radius:8px;padding:6px 8px;margin:3px 0;display:flex;justify-content:space-between;gap:8px;background:var(--bg)}
.chip.tap{cursor:pointer}.chip.on{border-color:var(--ok);background:color-mix(in srgb,var(--ok) 12%,var(--bg))}
.chip .r{text-align:right;white-space:nowrap}.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px}
.bar{height:8px;background:var(--line);border-radius:9px;overflow:hidden}.bar>i{display:block;height:100%;background:var(--ok)}
.note{font-size:12px;color:var(--mute);margin-top:10px}.warn{font-size:12px;color:var(--warn);margin-top:6px}#err{color:var(--warn)}
`;

const JS = String.raw`
var rid=0,pend={},rendered=false,lastArgs={};
function post(m){try{window.parent.postMessage(m,"*")}catch(e){}}
function rpc(method,params){var id=++rid;post({jsonrpc:"2.0",id:id,method:method,params:params||{}});return new Promise(function(res,rej){pend[id]={res:res,rej:rej};setTimeout(function(){if(pend[id]){delete pend[id];rej("timeout")}},8000)})}
window.addEventListener("message",function(e){var m=e.data;if(!m||m.jsonrpc!=="2.0")return;
 if(m.id!=null&&pend[m.id]&&!m.method){var p=pend[m.id];delete pend[m.id];m.error?p.rej(m.error):p.res(m.result);return}
 if(m.method==="ui/notifications/tool-input"){lastArgs=(m.params&&m.params.arguments)||{}}
 if(m.method==="ui/notifications/tool-result"&&m.params){if(m.params.structuredContent&&m.params.structuredContent.view){draw(m.params.structuredContent)}else if(m.params.isError){fail(textOf(m.params))}}});
function textOf(r){try{return r.content.map(function(c){return c.text||""}).join(" ")}catch(e){return "The tool returned an error."}}
function fail(msg){rendered=true;document.getElementById("app").innerHTML="<div id=err>"+esc(msg)+"</div>";size()}
function sendChat(text){rpc("ui/message",{role:"user",content:[{type:"text",text:text}]}).catch(function(){try{navigator.clipboard.writeText(text)}catch(e){};alert("Copied. Paste into chat:\n\n"+text)})}
function size(){post({jsonrpc:"2.0",method:"ui/notifications/size-changed",params:{width:document.body.scrollWidth,height:document.body.scrollHeight}})}
if(window.ResizeObserver){new ResizeObserver(size).observe(document.body)}
function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]})}
function draw(d){rendered=true;var el=document.getElementById("app");el.innerHTML=R[d.view](d);if(B[d.view])B[d.view](d);size()}
function mon(p){return p.tenure?p.tenure.total_months:-1}
function person(p,tap,role){return "<div class='chip"+(tap?" tap":"")+"'"+(tap?" data-k='"+role+":"+p.id+"' data-n=\""+esc(p.name)+"\" data-r="+role:"")+"><span>"+esc(p.name)+(p.lead?" <span class='pill lead'>lead</span>":"")+"<br><span class=sub>"+esc(p.site)+"</span></span><span class=r><span class='pill t'>"+esc(p.tenure_label)+"</span><br><span class=sub>"+p.week_hours+" h this wk</span></span></div>"}
function warns(d){return (d.warnings||[]).map(function(w){return "<div class=warn>"+esc(w)+"</div>"}).join("")}
var R={},B={};
R.schedule=function(d){var h="<h1>"+esc(d.site_name)+" &mdash; draft schedule</h1><div class=sub>"+esc(d.site_address)+" &middot; Route: "+(d.routeMatch?"<span class=pill>"+esc(d.routeMatch.client||d.routeMatch.name)+"</span>":"<span class=pill>not checked</span>")+" &middot; Tanda: "+(d.tandaMatch?"<span class=pill>"+esc(d.tandaMatch.name)+"</span>":"<span class=pill>site not created</span>")+"</div>";
 h+="<div class=cards style='margin-top:10px'><div class=card><div class=sub>Shift</div><div class=big>"+esc(d.start)+"&ndash;"+esc(d.end)+"</div><div class=sub>"+d.shiftHours+" hrs &middot; "+esc(d.days.join(", "))+"</div></div><div class=card><div class=sub>Crew</div><div class=big>"+d.cleaners+" cleaner"+(d.cleaners>1?"s":"")+"</div><div class=sub>"+d.supVisits+" supervisor checks/wk</div></div><div class=card><div class=sub>Labor</div><div class=big>"+d.weeklyHours+" h/wk</div><div class=sub>"+d.monthlyHours+" h/mo</div></div></div>";
 h+="<h2>Week</h2><table><tr><th>Day</th><th>Role</th><th>Time</th><th>Hrs</th></tr>";d.shifts.forEach(function(s){h+="<tr><td>"+esc(s.day)+"</td><td>"+esc(s.role)+"</td><td>"+esc(s.start)+"&ndash;"+esc(s.end)+"</td><td>"+s.hours+"</td></tr>"});h+="</table>";
 function li(a){return a.length?a.map(function(p){return person(p,false)}).join(""):"<div class=sub>None suggested</div>"}
 h+="<h2>Suggested staff &middot; week of "+esc(d.week.from)+"</h2><div class=cols><div><b>Cleaners</b>"+li(d.suggested.cleaners)+"</div><div><b>Supervisor</b>"+li(d.suggested.supervisor)+"</div><div><b>Trainer</b>"+li(d.suggested.trainer)+"</div></div>"+warns(d);
 if(d.notes)h+="<h2>Notes from conversation</h2><div>"+esc(d.notes)+"</div>";
 h+="<div class=row style='margin-top:12px'><button id=alloc>Open allocation board</button><button class=g id=sop>Generate launch SOP</button></div><div class=note>"+esc(d.load_basis)+" Tenure is time since each person's start date. Draft only: nothing is written to Tanda.</div>";return h};
B.schedule=function(d){document.getElementById("alloc").onclick=function(){sendChat("Open the staff allocation board for "+d.site_name+" with "+d.cleaners+" cleaners needed and "+(d.shiftHours*d.days.length)+" hours per cleaner per week, for the week of "+d.week.from+".")};document.getElementById("sop").onclick=function(){sendChat("Run the site launch SOP for "+d.site_name+".")}};
R.allocation=function(d){var h="<h1>Staff allocation"+(d.focus?" &mdash; "+esc(d.focus.name):"")+"</h1><div class=sub>Week "+esc(d.week.from)+" to "+esc(d.week.to)+" &middot; tap people to assign. Need: "+d.need.cleaners+" cleaners &middot; 1 supervisor"+(d.need.trainer?" &middot; 1 trainer":"")+"</div><div class=bar style='margin:8px 0'><i id=prog style='width:0'></i></div>";
 h+="<div class=row>Sort <select id=sort><option value=load>Load (lightest first)</option><option value=tenure>Tenure (longest first)</option><option value=new>Tenure (newest first)</option><option value=name>Name</option></select> Tenure <select id=minten><option value=0>Any</option><option value=6>6 months+</option><option value=12>1 year+</option><option value=24>2 years+</option><option value=60>5 years+</option></select></div>"+warns(d);
 h+="<div class=cols id=pools style='margin-top:8px'></div><div class=row style='margin-top:12px'><button id=done>Send assignment to chat</button></div><h2>Sites this week</h2><table><tr><th>Site</th><th>Cleaners</th><th>Sup.</th><th>Hrs wk</th></tr>";
 d.sites.slice(0,20).forEach(function(s){h+="<tr><td>"+esc(s.name)+"</td><td>"+s.cleaners+"</td><td>"+s.supervisors+"</td><td>"+s.week_hours+"</td></tr>"});h+="</table><div class=note>"+esc(d.note)+" Tenure is time since each person's start date. Draft only: nothing is written to Tanda.</div>";return h};
B.allocation=function(d){var pick={},names={};var roles=[["supervisor","Supervisors"],["trainer","Trainers"],["cleaner","Cleaners"],["trainee","Trainees"]];
 [["cleaner",d.recommendation.cleaners],["supervisor",d.recommendation.supervisor],["trainer",d.recommendation.trainer]].forEach(function(r){r[1].forEach(function(p){pick[r[0]+":"+p.id]=1})});
 var lead={};d.recommendation.cleaners.forEach(function(p){if(p.lead)lead[p.id]=1});
 var sortSel=document.getElementById("sort"),tenSel=document.getElementById("minten");sortSel.value=d.sort_by==="tenure"?"tenure":d.sort_by==="name"?"name":"load";
 function order(list){var s=sortSel.value,a=list.slice();a.sort(function(x,y){if(s==="tenure")return mon(y)-mon(x)||x.week_hours-y.week_hours;if(s==="new")return mon(x)-mon(y)||x.week_hours-y.week_hours;if(s==="name")return x.name.localeCompare(y.name);return x.week_hours-y.week_hours||mon(y)-mon(x)});return a}
 function paint(){var min=+tenSel.value,h="";roles.forEach(function(r){var list=order(d.pools[r[0]]).filter(function(p){return pick[r[0]+":"+p.id]||mon(p)>=min||min===0});h+="<div><b>"+r[1]+"</b> <span class=sub>("+list.length+")</span>";list.forEach(function(p){var q=p;if(r[0]==="cleaner"&&lead[p.id]){q={};for(var k in p)q[k]=p[k];q.lead=true}names[r[0]+":"+p.id]=p;h+=person(q,true,r[0])});if(!list.length)h+="<div class=sub>No one matches</div>";h+="</div>"});
  var c=document.getElementById("pools");c.innerHTML=h;c.querySelectorAll(".chip").forEach(function(n){n.onclick=function(){var k=n.getAttribute("data-k");pick[k]=!pick[k];upd()}});upd()}
 function upd(){var n=0;document.querySelectorAll("#pools .chip").forEach(function(c){var on=!!pick[c.getAttribute("data-k")];c.classList.toggle("on",on);if(on)n++});var t=d.need.cleaners+1+d.need.trainer;document.getElementById("prog").style.width=Math.min(100,n/t*100)+"%";size()}
 sortSel.onchange=paint;tenSel.onchange=paint;paint();
 document.getElementById("done").onclick=function(){var by={};Object.keys(pick).forEach(function(k){if(!pick[k]||!names[k])return;var r=k.split(":")[0],p=names[k];(by[r]=by[r]||[]).push(p.name+" ("+p.tenure_label+" tenure, "+p.week_hours+" h this week)")});
  sendChat("Allocation for "+(d.focus?d.focus.name:"the new site")+", week of "+d.week.from+": "+Object.keys(by).map(function(k){return k+"s: "+by[k].join(", ")}).join("; ")+". Summarize this as a shift plan for my review. Do not write anything to Tanda.")}};
if(EMBED){draw(EMBED)}else{
 rpc("ui/initialize",{protocolVersion:"2026-01-26",appInfo:{name:"Tanda Workforce staffing",version:"1.0.0"},appCapabilities:{}}).then(function(){post({jsonrpc:"2.0",method:"ui/notifications/initialized",params:{}})}).catch(function(){});
 setTimeout(function(){if(rendered)return;rpc("tools/call",{name:TOOL,arguments:lastArgs||{}}).then(function(r){if(rendered)return;if(r&&r.structuredContent&&r.structuredContent.view){draw(r.structuredContent)}else{fail(r?textOf(r):"No data came back.")}}).catch(function(){if(!rendered)fail("Couldn't load the data. Ask Claude to run the tool again.")})},4000)}
`;

/** JSON that is safe inside a <script> block. */
const inline = (v: unknown): string => JSON.stringify(v).replace(/</g, '\\u003c');

/** The page for one view. `embed` pre-loads a result (tests and local previews only). */
export function renderAppHtml(view: AppView, embed?: unknown): string {
  return (
    '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<title>${TITLES[view].replace(/[<>&]/g, '')}</title><style>${CSS}</style></head>` +
    '<body><div class="w" id="app"><div class="sub">Loading…</div></div>' +
    `<script>var VIEW=${inline(view)},TOOL=${inline(TOOL_FOR_VIEW[view])},EMBED=${embed === undefined ? 'null' : inline(embed)};${JS}</script></body></html>`
  );
}
