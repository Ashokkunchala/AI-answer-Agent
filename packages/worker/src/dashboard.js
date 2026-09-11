// Dashboard HTML - Served at /dashboard
// Single control center: chat, playground (all model types), keys, models, tasks, usage, docs.
// Direct mode: no API key needed to use the dashboard — requests run under the
// anonymous identity. API keys exist only for external tool integrations.
// Security notes: all dynamic values are HTML-escaped before innerHTML.
export const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>&#9881;</text></svg>">
<title>DevOps AI Agent</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0b0e14;--sidebar:#0d1117;--card:#151b27;--border:#1e2a3a;--accent:#7c5cfc;--accent2:#a78bfa;--green:#22c55e;--red:#ef4444;--yellow:#eab308;--blue:#3b82f6;--cyan:#06b6d4;--text:#e2e8f0;--text2:#64748b;--input:#111827;--hover:#1a2332}
html,body{height:100%;overflow:hidden}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'SF Mono',monospace;background:var(--bg);color:var(--text)}
.app{display:flex;height:100vh}
.sidebar{width:250px;background:var(--sidebar);border-right:1px solid var(--border);display:flex;flex-direction:column;flex-shrink:0}
.sidebar-header{padding:16px 20px;border-bottom:1px solid var(--border)}
.sidebar-header h1{font-size:1.05em;color:var(--accent2);display:flex;align-items:center;gap:8px}
.sidebar-header p{font-size:.72em;color:var(--text2);margin-top:4px}
.sidebar-nav{flex:1;padding:8px}
.nav-item{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:8px;cursor:pointer;font-size:.88em;color:var(--text2);transition:all .15s}
.nav-item:hover{background:var(--hover);color:var(--text)}
.nav-item.active{background:var(--accent);color:#fff}
.nav-item .icon{width:20px;text-align:center;font-size:1.1em}
.sidebar-footer{padding:12px 16px;border-top:1px solid var(--border);font-size:.75em;color:var(--text2);text-align:center}
.sidebar-footer a{color:var(--accent);text-decoration:none}
.main{flex:1;display:flex;flex-direction:column;overflow:hidden}
.topbar{height:52px;border-bottom:1px solid var(--border);display:flex;align-items:center;padding:0 20px;gap:12px;flex-shrink:0;background:var(--sidebar)}
.topbar h2{font-size:1em;color:var(--text)}
.badge{display:inline-block;padding:3px 10px;border-radius:6px;font-size:.75em;font-weight:600}
.topbar .badge{font-size:.7em;padding:2px 8px;border-radius:10px}
.badge-online{background:#22c55e22;color:var(--green)}
.badge-offline{background:#ef444422;color:var(--red)}
.key-wrap{display:flex;align-items:center;gap:6px}
.key-wrap input{width:200px;padding:6px 10px;font-size:.8em}
.content{flex:1;overflow-y:auto;padding:20px}
.view{display:none}
.view.active{display:flex;flex-direction:column;height:100%}
input,select,textarea{background:var(--input);border:1px solid var(--border);color:var(--text);padding:10px 14px;border-radius:8px;font-family:inherit;font-size:.9em;width:100%;outline:none;transition:border .2s}
input:focus,select:focus,textarea:focus{border-color:var(--accent)}
.btn{background:var(--accent);color:#fff;border:none;padding:10px 20px;border-radius:8px;cursor:pointer;font-family:inherit;font-size:.85em;font-weight:600;transition:all .15s;white-space:nowrap;display:inline-flex;align-items:center;gap:6px}
.btn:hover{opacity:.9;transform:translateY(-1px)}
.btn-danger{background:var(--red)}
.btn-ghost{background:transparent;border:1px solid var(--border);color:var(--text2)}
.btn-ghost:hover{border-color:var(--accent);color:var(--accent2)}
.btn-sm{padding:6px 12px;font-size:.8em}
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:20px;margin-bottom:16px}
.card h3{font-size:.9em;color:var(--accent2);margin-bottom:12px;display:flex;align-items:center;gap:8px}
.grid{display:grid;gap:12px}
.grid-2{grid-template-columns:1fr 1fr}
.grid-3{grid-template-columns:1fr 1fr 1fr}
.grid-4{grid-template-columns:1fr 1fr 1fr 1fr}
.stat{text-align:center;padding:16px 12px;background:var(--input);border-radius:10px}
.stat .num{font-size:1.8em;font-weight:700;color:var(--accent2)}
.stat .label{color:var(--text2);font-size:.75em;margin-top:4px}
table{width:100%;border-collapse:collapse;font-size:.85em}
th{text-align:left;color:var(--text2);font-weight:500;padding:10px 12px;border-bottom:1px solid var(--border)}
td{padding:10px 12px;border-bottom:1px solid var(--border)}
.badge-green{background:#22c55e22;color:var(--green)}
.badge-red{background:#ef444422;color:var(--red)}
.badge-yellow{background:#eab30822;color:var(--yellow)}
.badge-blue{background:#3b82f622;color:var(--blue)}
.badge-purple{background:#7c5cfc22;color:var(--accent2)}
.badge-cyan{background:#06b6d422;color:var(--cyan)}
.key-code{background:var(--input);padding:4px 10px;border-radius:6px;font-size:.8em;color:var(--green);word-break:break-all;font-family:'SF Mono',monospace}
.copy-btn{cursor:pointer;color:var(--accent);font-size:.8em;margin-left:8px}
.copy-btn:hover{color:var(--accent2)}
.form-row{margin-bottom:12px}
.form-row label{display:block;color:var(--text2);font-size:.8em;margin-bottom:6px}
.api-example{position:relative;background:#0a0e14;padding:16px;border-radius:10px;font-size:.8em;overflow-x:auto;color:var(--green);line-height:1.7;font-family:'SF Mono',monospace;border:1px solid var(--border);white-space:pre}
.api-example .c{color:var(--text2)}
.api-example .k{color:var(--yellow)}
.api-example .s{color:var(--cyan)}
.snippet-copy{position:absolute;top:8px;right:10px;cursor:pointer;color:var(--text2);font-size:.75em;background:var(--card);border:1px solid var(--border);border-radius:6px;padding:3px 8px}
.snippet-copy:hover{color:var(--accent2);border-color:var(--accent)}
.empty{text-align:center;padding:40px;color:var(--text2);font-size:.9em}
.hidden{display:none!important}
.toast{position:fixed;top:20px;right:20px;background:var(--green);color:#fff;padding:12px 20px;border-radius:10px;font-size:.85em;z-index:999;animation:slideIn .3s;box-shadow:0 4px 20px rgba(0,0,0,.4);max-width:380px;word-break:break-word}
.toast.error{background:var(--red)}
@keyframes slideIn{from{transform:translateX(120%);opacity:0}to{transform:translateX(0);opacity:1}}
.flex{display:flex;align-items:center;gap:10px}
.mt{margin-top:10px}.mb{margin-bottom:10px}
hr{border:none;border-top:1px solid var(--border);margin:16px 0}

/* Chat */
.chat-wrap{flex:1;display:flex;flex-direction:column;overflow:hidden}
.chat-messages{flex:1;overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:12px}
.msg{max-width:80%;padding:12px 16px;border-radius:14px;font-size:.9em;line-height:1.6;white-space:pre-wrap;word-wrap:break-word}
.msg.user{background:var(--accent);color:#fff;align-self:flex-end;border-bottom-right-radius:4px}
.msg.assistant{background:var(--card);border:1px solid var(--border);align-self:flex-start;border-bottom-left-radius:4px}
.msg.system{background:transparent;color:var(--text2);font-size:.8em;text-align:center;align-self:center;padding:4px 12px}
.msg pre{background:#0a0e14;padding:12px;border-radius:8px;overflow-x:auto;margin:8px 0;font-size:.85em}
.msg code{font-family:'SF Mono',monospace;font-size:.85em}
.msg.user code{background:rgba(255,255,255,.15);padding:1px 5px;border-radius:4px}
.msg.assistant code{background:var(--input);padding:1px 5px;border-radius:4px}
.msg-meta{font-size:.7em;color:var(--text2);margin-top:6px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.chat-input-wrap{padding:16px 20px;border-top:1px solid var(--border);background:var(--sidebar)}
.chat-input-row{display:flex;gap:10px;align-items:flex-end}
.chat-input-row textarea{flex:1;resize:none;min-height:42px;max-height:150px;padding:10px 14px;line-height:1.5}
.chat-input-row .btn{height:42px;padding:0 20px}
.chat-tools{display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;align-items:center}
.chat-tools select{width:auto;padding:6px 10px;font-size:.8em}
.chat-tools label{display:flex;align-items:center;gap:5px;font-size:.8em;color:var(--text2);cursor:pointer}
.model-tag{font-size:.7em;padding:2px 8px;background:var(--blue);color:#fff;border-radius:6px}
.task-tag{font-size:.7em;padding:2px 8px;background:var(--cyan);color:#000;border-radius:6px}
.streaming-indicator{display:inline-flex;gap:3px;align-items:center;padding:4px 8px}
.streaming-indicator span{width:5px;height:5px;background:var(--accent2);border-radius:50%;animation:bounce .6s infinite alternate}
.streaming-indicator span:nth-child(2){animation-delay:.2s}
.streaming-indicator span:nth-child(3){animation-delay:.4s}
@keyframes bounce{to{opacity:.3;transform:translateY(-4px)}}

/* Playground */
.pg-wrap{flex:1;overflow-y:auto;padding:20px}
.pg-output{background:#0a0e14;border:1px solid var(--border);border-radius:10px;padding:16px;min-height:120px;font-size:.88em;line-height:1.6;word-break:break-word}
.pg-output pre{background:var(--input);padding:12px;border-radius:8px;overflow-x:auto;margin:8px 0;font-size:.85em}
.pg-output img{max-width:100%;max-height:420px;border-radius:8px;margin-top:8px}
.pg-output audio{width:100%;margin-top:8px}
.pg-meta{font-size:.75em;color:var(--text2);margin-top:10px;display:flex;gap:8px;flex-wrap:wrap}

/* Model cards */
.model-card{background:var(--input);border:1px solid var(--border);border-radius:10px;padding:14px;transition:border .2s}
.model-card:hover{border-color:var(--accent)}
.model-card .name{font-weight:600;font-size:.9em;margin-bottom:4px}
.model-card .id{font-size:.75em;color:var(--text2);word-break:break-all}
.model-card .caps{display:flex;gap:4px;flex-wrap:wrap;margin-top:8px}
.model-card .cap{font-size:.7em;padding:2px 6px;border-radius:4px;background:var(--card);color:var(--text2);border:1px solid var(--border)}
.filter-bar{display:flex;gap:10px;margin-bottom:16px;align-items:center}
.filter-bar input{flex:1}
.filter-bar select{width:auto}

/* Task cards */
.task-card{background:var(--input);border:1px solid var(--border);border-radius:10px;padding:16px}
.task-card .title{font-weight:600;font-size:.95em;color:var(--accent2);margin-bottom:8px}
.task-card .chain{display:flex;flex-direction:column;gap:6px}
.task-card .chain-item{display:flex;align-items:center;gap:8px;font-size:.8em}
.task-card .chain-item .num{width:20px;height:20px;border-radius:50%;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:.7em;font-weight:700;flex-shrink:0}
.task-card .chain-item .reason{color:var(--text2);font-size:.85em;margin-left:auto}
</style>
</head>
<body>
<div class="app">
  <div class="sidebar">
    <div class="sidebar-header">
      <h1>&#9881; DevOps AI Agent</h1>
      <p>100% Cloudflare Workers AI</p>
    </div>
    <div class="sidebar-nav">
      <div class="nav-item active" data-view="chat"><span class="icon">&#128172;</span> Chat</div>
      <div class="nav-item" data-view="playground"><span class="icon">&#127918;</span> Playground</div>
      <div class="nav-item" data-view="keys"><span class="icon">&#128273;</span> API Keys</div>
      <div class="nav-item" data-view="models"><span class="icon">&#9881;</span> Models</div>
      <div class="nav-item" data-view="tasks"><span class="icon">&#128196;</span> Tasks</div>
      <div class="nav-item" data-view="usage"><span class="icon">&#128200;</span> Usage</div>
      <div class="nav-item" data-view="docs"><span class="icon">&#128214;</span> Integrate</div>
    </div>
    <div class="sidebar-footer">
      <a href="/health" target="_blank">Health Check</a> &middot; v4.0
    </div>
  </div>
  <div class="main">
    <div class="topbar">
      <h2 id="viewTitle">Chat</h2>
      <span class="badge badge-offline" id="statusBadge">Checking...</span>
      <span class="badge badge-cyan">Direct mode &mdash; no key needed</span>
      <div style="flex:1"></div>
      <span style="font-size:.75em;color:var(--text2)">API keys are for external tools &rarr; API Keys tab</span>
    </div>

    <!-- CHAT VIEW -->
    <div class="view active" id="view-chat">
      <div class="chat-wrap">
        <div class="chat-messages" id="chatMessages">
          <div class="msg system">Ask anything about DevOps, cloud, infrastructure, or engineering. No key needed — just type.</div>
        </div>
        <div class="chat-input-wrap">
          <div class="chat-input-row">
            <textarea id="chatInput" placeholder="Type your question..." rows="1"></textarea>
            <button class="btn" onclick="sendChat()" id="sendBtn">Send</button>
          </div>
          <div class="chat-tools">
            <select id="chatModel"><option value="auto">Auto-route</option></select>
            <select id="chatTask">
              <option value="">Auto-detect</option>
              <option value="quick_qa">Quick Q&amp;A</option>
              <option value="code_gen">Code Gen</option>
              <option value="debug">Debug</option>
              <option value="review">Review</option>
              <option value="explain">Explain</option>
              <option value="mentor">Mentor</option>
              <option value="deep_reasoning">Deep Reasoning</option>
              <option value="scripting">Scripting</option>
              <option value="general">General</option>
            </select>
            <label><input type="checkbox" id="chatStream" checked> Stream</label>
            <label>Tokens (0 = max): <input type="number" id="chatMaxTokens" value="0" min="0" style="width:65px;padding:4px 6px;font-size:.8em"></label>
            <button class="btn btn-sm btn-ghost" onclick="clearChat()">Clear chat</button>
          </div>
        </div>
      </div>
    </div>

    <!-- PLAYGROUND VIEW -->
    <div class="view" id="view-playground">
      <div class="pg-wrap">
        <div class="card">
          <h3>&#127918; Model Playground <span class="badge badge-cyan">test any model directly</span></h3>
          <div class="grid grid-2 mb">
            <div class="form-row" style="margin:0"><label>Model</label><select id="pgModel"></select></div>
            <div class="form-row" style="margin:0"><label>&nbsp;</label>
              <div class="flex" style="flex-wrap:wrap">
                <label style="font-size:.8em;color:var(--text2)"><input type="checkbox" id="pgRaw" checked> Raw (no DevOps persona)</label>
                <label style="font-size:.8em;color:var(--text2)">Temp: <input type="number" id="pgTemp" value="0.7" step="0.1" min="0" max="2" style="width:60px;padding:4px 6px;font-size:.8em"></label>
                <label style="font-size:.8em;color:var(--text2)">Max tokens: <input type="number" id="pgMaxTokens" value="0" min="0" style="width:70px;padding:4px 6px;font-size:.8em"></label>
                <label style="font-size:.8em;color:var(--text2)" hidden id="pgStepsWrap">Steps: <input type="number" id="pgSteps" value="8" min="1" max="20" style="width:55px;padding:4px 6px;font-size:.8em"></label>
              </div>
            </div>
          </div>
          <div class="form-row"><label>Prompt</label>
            <textarea id="pgPrompt" rows="3" placeholder="Enter your prompt... (image models: describe the image &bull; TTS: text to speak &bull; translation: text to translate)"></textarea>
          </div>
          <button class="btn" onclick="runPlayground()" id="pgRunBtn">Run</button>
          <div id="pgOutput" class="pg-output mt"><span style="color:var(--text2)">Output appears here.</span></div>
        </div>
        <div class="card">
          <h3>&#129504; Classifier Test <span class="badge badge-cyan">see how requests get routed</span></h3>
          <div class="flex">
            <input id="routeTestInput" placeholder="Type a message to see which task type and models it routes to...">
            <button class="btn btn-sm" onclick="testRoute()">Test</button>
          </div>
          <div id="routeTestResult" class="mt"></div>
        </div>
      </div>
    </div>

    <!-- KEYS VIEW -->
    <div class="view" id="view-keys">
      <div class="content">
        <div class="card">
          <h3>&#10133; Create API Key <span class="badge badge-yellow">for external tools</span></h3>
          <div class="grid grid-2">
            <div class="form-row"><label>Key Name</label><input id="keyName" placeholder="e.g. my-app"></div>
            <div class="form-row"><label>Expires (optional)</label><input id="keyExpiry" type="date"></div>
          </div>
          <div class="grid grid-2">
            <div class="form-row"><label>Tier (label)</label>
              <select id="keyTier"><option value="standard">Standard</option><option value="premium">Premium</option></select>
            </div>
            <div class="form-row"><label>Rate Limit (req/min, 0 = unlimited)</label><input id="keyRateLimit" type="number" value="0" min="0"></div>
          </div>
          <button class="btn" onclick="createKey()">Generate Key</button>
          <div id="newKeyBox" class="hidden mt" style="background:var(--input);padding:14px;border-radius:10px;border:1px solid var(--yellow)">
            <p style="color:var(--yellow);font-size:.85em;margin-bottom:8px">&#9888;&#65039; Save this key now — it won't be shown again!</p>
            <div class="flex"><code id="newKeyDisplay" class="key-code"></code><span class="copy-btn" onclick="copyNewKey()">&#128203; Copy</span></div>
          </div>
        </div>
        <div class="card">
          <div class="flex" style="justify-content:space-between;margin-bottom:12px">
            <h3 style="margin:0">&#128273; API Keys</h3>
            <button class="btn btn-sm btn-ghost" onclick="loadKeys()">&#8635; Refresh</button>
          </div>
          <div id="keysList"></div>
        </div>
      </div>
    </div>

    <!-- MODELS VIEW -->
    <div class="view" id="view-models">
      <div class="content">
        <div class="filter-bar">
          <input id="modelSearch" placeholder="Search models..." oninput="filterModels()">
          <select id="modelCapFilter" onchange="filterModels()">
            <option value="">All capabilities</option>
            <option value="tools">Tools</option>
            <option value="reasoning">Reasoning</option>
            <option value="streaming">Streaming</option>
            <option value="vision">Vision</option>
            <option value="image">Image gen</option>
            <option value="audio">Audio</option>
            <option value="tts">TTS</option>
            <option value="embeddings">Embeddings</option>
            <option value="classification">Classification</option>
            <option value="translation">Translation</option>
          </select>
        </div>
        <div class="grid grid-3" id="modelsGrid"></div>
      </div>
    </div>

    <!-- TASKS VIEW -->
    <div class="view" id="view-tasks">
      <div class="content">
        <div class="grid grid-2" id="tasksGrid"></div>
      </div>
    </div>

    <!-- USAGE VIEW -->
    <div class="view" id="view-usage">
      <div class="content">
        <div class="grid grid-4" id="usageStats">
          <div class="stat"><div class="num" id="uTotalKeys">–</div><div class="label">Total Keys</div></div>
          <div class="stat"><div class="num" id="uActiveKeys">–</div><div class="label">Active Keys</div></div>
          <div class="stat"><div class="num" id="uTodayReqs">0</div><div class="label">Today's Requests</div></div>
          <div class="stat"><div class="num" id="uTodayTokens">0</div><div class="label">Today's Tokens</div></div>
        </div>
        <div class="card mt">
          <h3>&#128200; Today's Usage by Model (this key)</h3>
          <div id="usageByModel"><div class="empty">No requests today yet.</div></div>
        </div>
      </div>
    </div>

    <!-- INTEGRATE / DOCS VIEW -->
    <div class="view" id="view-docs">
      <div class="content">
        <div class="card">
          <h3>&#128214; Endpoints</h3>
          <table>
            <thead><tr><th>Method</th><th>Path</th><th>Auth</th><th>Description</th></tr></thead>
            <tbody>
              <tr><td><span class="badge badge-green">GET</span></td><td>/health</td><td>No</td><td>Health check</td></tr>
              <tr><td><span class="badge badge-green">GET</span></td><td>/dashboard</td><td>No</td><td>This UI</td></tr>
              <tr><td><span class="badge badge-green">GET</span></td><td>/v1/models</td><td>No</td><td>List all models</td></tr>
              <tr><td><span class="badge badge-green">GET</span></td><td>/v1/tasks</td><td>No</td><td>List task routing</td></tr>
              <tr><td><span class="badge badge-blue">POST</span></td><td>/v1/keys</td><td>None</td><td>Create API key (for external tools)</td></tr>
              <tr><td><span class="badge badge-blue">POST</span></td><td>/v1/chat/completions</td><td>Yes</td><td>OpenAI-compatible chat (all model types)</td></tr>
              <tr><td><span class="badge badge-blue">POST</span></td><td>/ask</td><td>Yes</td><td>Simple Q&amp;A</td></tr>
              <tr><td><span class="badge badge-blue">POST</span></td><td>/v1/route</td><td>Yes</td><td>Preview routing</td></tr>
              <tr><td><span class="badge badge-green">GET</span></td><td>/v1/keys</td><td>None</td><td>List keys</td></tr>
              <tr><td><span class="badge badge-blue">POST</span></td><td>/v1/keys/revoke</td><td>None</td><td>Revoke key by id</td></tr>
              <tr><td><span class="badge badge-red">DEL</span></td><td>/v1/keys</td><td>None</td><td>Delete key by id</td></tr>
              <tr><td><span class="badge badge-green">GET</span></td><td>/v1/usage</td><td>Yes</td><td>Usage stats</td></tr>
            </tbody>
          </table>
        </div>
        <div class="card">
          <h3>&#128214; Copy-Paste Integration Snippets <span class="badge badge-yellow">auto-filled with your worker URL</span></h3>
          <p style="font-size:.8em;color:var(--text2);margin-bottom:12px">Snippets use <code>dvops_YOUR_KEY</code> — replace it with a key from the API Keys tab. Keys are only needed for external tools, not for this dashboard.</p>
          <div id="snippets"></div>
        </div>
      </div>
    </div>

  </div>
</div>

<script>
var BASE = location.origin;
var ALL_MODELS = [];
var ALL_TASKS = [];
var chatHistory = [];   // multi-turn memory: [{role, content}]
var pendingSnips = [];

function $(id) { return document.getElementById(id); }

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Direct mode: no API key needed — requests run under the anonymous identity
async function api(method, path, body) {
  var opts = { method: method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  var res = await fetch(BASE + path, opts);
  var data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed (' + res.status + ')');
  return data;
}

async function checkHealth() {
  var badge = $('statusBadge');
  try {
    var r = await fetch(BASE + '/health');
    if (r.ok) { badge.className = 'badge badge-online'; badge.textContent = 'Online'; return; }
  } catch (e) {}
  badge.className = 'badge badge-offline';
  badge.textContent = 'Offline';
}

function toast(msg, err) {
  var t = document.createElement('div');
  t.className = 'toast' + (err ? ' error' : '');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(function() { t.remove(); }, 3500);
}

// ─── Navigation ───
document.querySelectorAll('.nav-item').forEach(function(el) {
  el.addEventListener('click', function() {
    document.querySelectorAll('.nav-item').forEach(function(n) { n.classList.remove('active'); });
    el.classList.add('active');
    var viewId = el.dataset.view;
    document.querySelectorAll('.view').forEach(function(v) { v.classList.remove('active'); });
    $('view-' + viewId).classList.add('active');
    $('viewTitle').textContent = el.textContent.trim();
    if (viewId === 'keys') loadKeys();
    if (viewId === 'usage') loadUsage();
    if (viewId === 'models' && !ALL_MODELS.length) loadModels();
    if (viewId === 'tasks' && !ALL_TASKS.length) loadTasks();
    if (viewId === 'playground') populatePgModels();
    if (viewId === 'docs') renderSnippets();
  });
});

// ─── Chat ───
var chatMessages = $('chatMessages');
var chatInput = $('chatInput');

chatInput.addEventListener('keydown', function(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
});
chatInput.addEventListener('input', function() {
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 150) + 'px';
});

function clearChat() {
  chatHistory = [];
  chatMessages.innerHTML = '<div class="msg system">Conversation cleared.</div>';
}

async function sendChat() {
  var text = chatInput.value.trim();
  if (!text) return;
  chatInput.value = '';
  chatInput.style.height = 'auto';

  addMsg('user', escapeHtml(text));
  chatHistory.push({ role: 'user', content: text });

  var placeholder = addMsg('assistant', '');
  placeholder.innerHTML = '<div class="streaming-indicator"><span></span><span></span><span></span></div>';

  var model = $('chatModel').value;
  var stream = $('chatStream').checked;
  var maxTokens = parseInt($('chatMaxTokens').value) || 0;
  var taskType = $('chatTask').value;

  // Send full conversation history (last 20 turns) for multi-turn context
  var body = {
    messages: chatHistory.slice(-20),
    max_tokens: maxTokens,
    stream: stream,
  };
  if (model !== 'auto') body.model = model;
  if (taskType) body.task_type = taskType;

  try {
    if (stream) {
      var res = await fetch(BASE + '/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        var err = await res.json();
        throw new Error(err.error || 'Request failed');
      }

      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var fullText = '';
      var buffer = '';
      var meta = {};

      while (true) {
        var chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        var lines = buffer.split('\\n');
        buffer = lines.pop();
        for (var i = 0; i < lines.length; i++) {
          var trimmed = lines[i].trim();
          if (!trimmed || trimmed.indexOf('data: ') !== 0) continue;
          var jsonStr = trimmed.slice(6);
          if (jsonStr === '[DONE]') continue;
          try {
            var parsed = JSON.parse(jsonStr);
            if (parsed.error) throw new Error(parsed.error);
            var delta = parsed.choices && parsed.choices[0] && parsed.choices[0].delta && parsed.choices[0].delta.content;
            if (delta) fullText += delta;
            if (parsed.model) meta.model = parsed.model;
            if (parsed.task_type) meta.task_type = parsed.task_type;
          } catch(e) {}
        }
        placeholder.innerHTML = renderMd(fullText);
        chatMessages.scrollTop = chatMessages.scrollHeight;
      }

      chatHistory.push({ role: 'assistant', content: fullText });

      var metaHtml = '';
      if (meta.model) metaHtml += '<span class="model-tag">' + escapeHtml(meta.model) + '</span>';
      if (meta.task_type) metaHtml += '<span class="task-tag">' + escapeHtml(meta.task_type) + '</span>';
      if (metaHtml) placeholder.innerHTML += '<div class="msg-meta">' + metaHtml + '</div>';
    } else {
      var data = await api('POST', '/v1/chat/completions', body);
      var content = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || 'No response';
      chatHistory.push({ role: 'assistant', content: content });

      var metaHtml2 = '';
      if (data.model) metaHtml2 += '<span class="model-tag">' + escapeHtml(data.model) + '</span>';
      if (data.task_type) metaHtml2 += '<span class="task-tag">' + escapeHtml(data.task_type) + '</span>';
      if (data._metadata && data._metadata.latency_ms) metaHtml2 += '<span style="color:var(--text2)">' + parseInt(data._metadata.latency_ms, 10) + 'ms</span>';
      placeholder.innerHTML = renderMd(content) + (metaHtml2 ? '<div class="msg-meta">' + metaHtml2 + '</div>' : '');
    }
    chatMessages.scrollTop = chatMessages.scrollHeight;
  } catch (e) {
    placeholder.innerHTML = '<span style="color:var(--red)">' + escapeHtml(e.message) + '</span>';
  }
}

function addMsg(role, safeHtml) {
  var div = document.createElement('div');
  div.className = 'msg ' + role;
  div.innerHTML = safeHtml || '';
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return div;
}

// Markdown rendering — fenced code blocks are extracted FIRST so that
// bold/italic replacements never mangle code content.
function renderMd(text) {
  if (!text) return '';
  var codes = [];
  var s = escapeHtml(text);
  s = s.replace(/\`\`\`([\\s\\S]*?)\`\`\`/g, function(m, c) {
    codes.push(c);
    return '\\u0000C' + (codes.length - 1) + '\\u0000';
  });
  s = s.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
  s = s.replace(/\\*(.+?)\\*/g, '<em>$1</em>');
  s = s.replace(/\`([^\\n\`]+?)\`/g, '<code>$1</code>');
  s = s.replace(/\\n/g, '<br>');
  s = s.replace(/\\u0000C(\\d+)\\u0000/g, function(m, i) {
    return '<pre><code>' + codes[+i] + '</code></pre>';
  });
  return s;
}

// ─── Playground ───
function populatePgModels() {
  var sel = $('pgModel');
  if (sel.options.length > 1) return; // already populated
  ALL_MODELS.forEach(function(m) {
    sel.innerHTML += '<option value="' + escapeHtml(m.id) + '">' + escapeHtml(m.name) + ' (' + escapeHtml((m.caps || []).join(',')) + ')</option>';
  });
  sel.onchange = pgModelChanged;
  pgModelChanged();
}

function pgModelChanged() {
  var val = $('pgModel').value;
  var m = ALL_MODELS.find(function(x) { return x.id === val; });
  var caps = m && m.caps || [];
  $('pgStepsWrap').classList.toggle('hidden', caps.indexOf('image') < 0);
}

async function runPlayground() {
  var prompt = $('pgPrompt').value.trim();
  if (!prompt) { toast('Enter a prompt', true); return; }

  var model = $('pgModel').value;
  var out = $('pgOutput');
  out.innerHTML = '<div class="streaming-indicator"><span></span><span></span><span></span></div>';

  var body = {
    model: model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: parseInt($('pgMaxTokens').value) || 0,
    temperature: parseFloat($('pgTemp').value),
  };
  if ($('pgRaw').checked) body.raw = true;

  var m = ALL_MODELS.find(function(x) { return x.id === model; });
  var caps = m && m.caps || [];
  if (caps.indexOf('image') >= 0) body.num_steps = parseInt($('pgSteps').value) || 8;

  try {
    var t0 = Date.now();
    var data = await api('POST', '/v1/chat/completions', body);
    var ms = Date.now() - t0;
    renderPlaygroundOutput(data, ms);
  } catch (e) {
    out.innerHTML = '<span style="color:var(--red)">' + escapeHtml(e.message) + '</span>';
  }
}

function renderPlaygroundOutput(data, ms) {
  var out = $('pgOutput');
  var html = '';
  var att = data.attachments && data.attachments[0];

  if (att && att.type === 'image' && att.data) {
    html += '<img src="data:' + escapeHtml(att.mime_type || 'image/png') + ';base64,' + att.data + '" alt="generated image">';
  } else if (att && att.type === 'audio' && att.data) {
    html += '<audio controls src="data:' + escapeHtml(att.mime_type || 'audio/mp3') + ';base64,' + att.data + '"></audio>';
  } else if (data.embedding_data) {
    var dims = Array.isArray(data.embedding_data) ? data.embedding_data.length : 0;
    var vec = Array.isArray(data.embedding_data) && Array.isArray(data.embedding_data[0]) ? data.embedding_data[0] : data.embedding_data;
    html += '<strong>Embedding vector</strong>: ' + dims + ' input(s), dimensionality ' + (vec ? vec.length : '?') + '<br>';
    html += '<pre>' + escapeHtml(JSON.stringify((vec || []).slice(0, 8)) + ' ...') + '</pre>';
  } else {
    var content = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    html += renderMd(content);
  }

  var meta = '<div class="pg-meta">';
  if (data.model) meta += '<span class="model-tag">' + escapeHtml(data.model) + '</span>';
  if (data.task_type) meta += '<span class="task-tag">' + escapeHtml(data.task_type) + '</span>';
  if (ms != null) meta += '<span>' + ms + 'ms</span>';
  meta += '</div>';
  out.innerHTML = html + meta;
}

async function testRoute() {
  var text = $('routeTestInput').value.trim();
  if (!text) { toast('Type a message first', true); return; }
  var el = $('routeTestResult');
  el.innerHTML = '<span style="color:var(--text2)">Testing...</span>';
  try {
    var data = await api('POST', '/v1/route', { messages: [{ role: 'user', content: text }] });
    var h = '<div class="task-card"><div class="title">' + escapeHtml(data.task_label) + ' <span class="badge badge-cyan">' + escapeHtml(data.task_type) + '</span></div><div class="chain">';
    (data.chain || []).forEach(function(c, i) {
      h += '<div class="chain-item"><span class="num">' + (i + 1) + '</span><span>' + escapeHtml(c.model) + '</span><span class="reason">' + escapeHtml(c.reason || '') + '</span></div>';
    });
    h += '</div></div>';
    el.innerHTML = h;
  } catch (e) {
    el.innerHTML = '<span style="color:var(--red)">' + escapeHtml(e.message) + '</span>';
  }
}

// ─── Keys ───
async function loadKeys() {
  try {
    var data = await api('GET', '/v1/keys');
    var keys = data.keys || [];
    $('uTotalKeys').textContent = keys.length;
    $('uActiveKeys').textContent = keys.filter(function(k) { return !k.revoked; }).length;
    if (!keys.length) {
      $('keysList').innerHTML = '<div class="empty">No keys yet. Create one above.</div>';
      return;
    }
    var h = '<table><thead><tr><th>Key</th><th>Name</th><th>Tier</th><th>Rate</th><th>Status</th><th></th></tr></thead><tbody>';
    keys.forEach(function(k) {
      var badge = k.revoked ? '<span class="badge badge-red">Revoked</span>' : '<span class="badge badge-green">Active</span>';
      var tierBadge = '<span class="badge badge-yellow">' + escapeHtml(k.tier || 'standard') + '</span>';
      var action = k.revoked
        ? ''
        : '<button class="btn btn-sm btn-danger" onclick="revokeKey(\\'' + escapeHtml(k.id) + '\\')">Revoke</button>'
          + ' <button class="btn btn-sm btn-ghost" onclick="deleteKey(\\'' + escapeHtml(k.id) + '\\')">Delete</button>';
      h += '<tr><td><code class="key-code">' + escapeHtml(k.key_preview) + '</code></td>'
        + '<td>' + escapeHtml(k.name) + '</td>'
        + '<td>' + tierBadge + '</td>'
        + '<td>' + (k.rate_limit > 0 ? parseInt(k.rate_limit, 10) + '/min' : 'Unlimited') + '</td>'
        + '<td>' + badge + '</td>'
        + '<td>' + action + '</td></tr>';
    });
    h += '</tbody></table>';
    $('keysList').innerHTML = h;
  } catch (e) { toast(e.message, true); }
}

async function createKey() {
  try {
    var payload = {
      name: $('keyName').value || 'unnamed',
      expires_at: $('keyExpiry').value || null,
      tier: $('keyTier').value,
      rate_limit: parseInt($('keyRateLimit').value) || 0,
    };
    var data = await api('POST', '/v1/keys', payload);
    $('newKeyDisplay').textContent = data.key;
    $('newKeyBox').classList.remove('hidden');
    $('keyName').value = '';
    renderSnippets();
    toast('Key created! Copy it now — shown only once.');
    loadKeys();
  } catch (e) { toast(e.message, true); }
}

function copyNewKey() {
  navigator.clipboard.writeText($('newKeyDisplay').textContent);
  toast('Copied!');
}

async function revokeKey(id) {
  if (!confirm('Revoke key ' + id + '?')) return;
  try {
    var r = await api('POST', '/v1/keys/revoke', { id: id });
    toast(r.success ? 'Revoked' : (r.error || 'Failed'));
    loadKeys();
  } catch (e) { toast(e.message, true); }
}

async function deleteKey(id) {
  if (!confirm('Permanently DELETE key ' + id + '?')) return;
  try {
    var r = await api('DELETE', '/v1/keys', { id: id });
    toast(r.success ? 'Deleted' : (r.error || 'Failed'));
    loadKeys();
  } catch (e) { toast(e.message, true); }
}

// ─── Models ───
async function loadModels() {
  try {
    var data = await fetch(BASE + '/v1/models').then(function(r) { return r.json(); });
    ALL_MODELS = data.data || [];
    renderModels(ALL_MODELS);
    var sel = $('chatModel');
    sel.innerHTML = '<option value="auto">Auto-route</option>';
    ALL_MODELS.forEach(function(m) {
      sel.innerHTML += '<option value="' + escapeHtml(m.id) + '">' + escapeHtml(m.name) + '</option>';
    });
    populatePgModels();
  } catch (e) { toast(e.message, true); }
}

function renderModels(models) {
  var grid = $('modelsGrid');
  if (!models.length) { grid.innerHTML = '<div class="empty">No models found</div>'; return; }
  grid.innerHTML = models.map(function(m) {
    return '<div class="model-card"><div class="name">' + escapeHtml(m.name) + '</div>'
      + '<div class="id">' + escapeHtml(m.model_id || m.id) + '</div>'
      + '<div class="caps">' + (m.caps || []).map(function(c) { return '<span class="cap">' + escapeHtml(c) + '</span>'; }).join('') + '</div></div>';
  }).join('');
}

function filterModels() {
  var q = $('modelSearch').value.toLowerCase();
  var cap = $('modelCapFilter').value;
  var filtered = ALL_MODELS;
  if (q) filtered = filtered.filter(function(m) { return m.name.toLowerCase().indexOf(q) >= 0 || m.id.toLowerCase().indexOf(q) >= 0; });
  if (cap) filtered = filtered.filter(function(m) { return (m.caps || []).indexOf(cap) >= 0; });
  renderModels(filtered);
}

// ─── Tasks ───
async function loadTasks() {
  try {
    var data = await fetch(BASE + '/v1/tasks').then(function(r) { return r.json(); });
    ALL_TASKS = data.tasks || [];
    var grid = $('tasksGrid');
    if (!ALL_TASKS.length) { grid.innerHTML = '<div class="empty">No tasks</div>'; return; }
    grid.innerHTML = ALL_TASKS.map(function(t) {
      return '<div class="task-card"><div class="title">' + escapeHtml(t.label) + '</div><div class="chain">' + t.models.map(function(m, i) {
        return '<div class="chain-item"><span class="num">' + (i + 1) + '</span><span>' + escapeHtml(m.model || m.model_id) + '</span><span class="reason">' + escapeHtml(m.reason || '') + '</span></div>';
      }).join('') + '</div></div>';
    }).join('');
  } catch (e) { toast(e.message, true); }
}

// ─── Usage ───
async function loadUsage() {
  try {
    var data = await api('GET', '/v1/usage');
    $('uTodayReqs').textContent = (data.usage && data.usage.requests) || 0;
    $('uTodayTokens').textContent = (data.usage && data.usage.tokens) || 0;

    var models = (data.usage && data.usage.models) || {};
    var names = Object.keys(models);
    if (!names.length) {
      $('usageByModel').innerHTML = '<div class="empty">No requests today yet.</div>';
    } else {
      var h = '<table><thead><tr><th>Model</th><th>Requests</th></tr></thead><tbody>';
      names.sort(function(a, b) { return models[b] - models[a]; }).forEach(function(name) {
        h += '<tr><td><span class="model-tag">' + escapeHtml(name) + '</span></td><td>' + models[name] + '</td></tr>';
      });
      h += '</tbody></table>';
      $('usageByModel').innerHTML = h;
    }
  } catch (e) { toast(e.message, true); }
  loadKeys();
}

// ─── Integration snippets (real URL + connected key, copy buttons) ───
function snippetBlock(title, code) {
  var id = 'snip_' + Math.random().toString(36).slice(2, 8);
  pendingSnips.push({ id: id, code: code });
  return '<h3 style="font-size:.85em;margin:14px 0 6px">' + escapeHtml(title) + '</h3>'
    + '<div class="api-example" id="' + id + '"><span class="snippet-copy" onclick="copySnippet(\\'' + id + '\\')">&#128203; copy</span></div>';
}
var pendingSnips = [];

function renderSnippets() {
  pendingSnips = [];
  var k = 'dvops_YOUR_KEY'; // paste a key from the API Keys tab
  var b = BASE;
  var h = '';

  h += snippetBlock('cURL — chat (auto-routed)', [
    'curl -X POST ' + b + '/v1/chat/completions \\\\',
    '  -H "Authorization: Bearer ' + k + '" \\\\',
    '  -H "Content-Type: application/json" \\\\',
    '  -d \\'{"messages":[{"role":"user","content":"write terraform for VPC"}]}\\'',
  ].join('\\n'));

  h += snippetBlock('Python — OpenAI SDK', [
    'import openai',
    'client = openai.OpenAI(',
    '  api_key="' + k + '",',
    '  base_url="' + b + '/v1",',
    ')',
    'resp = client.chat.completions.create(',
    '  model="auto",',
    '  messages=[{"role": "user", "content": "explain K8s"}],',
    ')',
    'print(resp.choices[0].message.content)',
  ].join('\\n'));

  h += snippetBlock('Node.js — OpenAI SDK', [
    'import OpenAI from "openai";',
    'const client = new OpenAI({',
    '  apiKey: "' + k + '",',
    '  baseURL: "' + b + '/v1",',
    '});',
    'const resp = await client.chat.completions.create({',
    '  model: "auto",',
    '  messages: [{ role: "user", content: "debug my pod crashloop" }],',
    '});',
    'console.log(resp.choices[0].message.content);',
  ].join('\\n'));

  h += snippetBlock('Any OpenAI-compatible tool (Cursor, OpenCode, Aider...)', [
    'Base URL: ' + b + '/v1',
    'API Key:  ' + k,
    'Model:    auto   (or any model id from the Models tab)',
  ].join('\\n'));

  h += snippetBlock('Streaming (SSE)', [
    'curl -N -X POST ' + b + '/v1/chat/completions \\\\',
    '  -H "Authorization: Bearer ' + k + '" \\\\',
    '  -H "Content-Type: application/json" \\\\',
    '  -d \\'{"stream":true,"messages":[{"role":"user","content":"hello"}]}\\'',
  ].join('\\n'));

  h += snippetBlock('Image generation', [
    'curl -X POST ' + b + '/v1/chat/completions \\\\',
    '  -H "Authorization: Bearer ' + k + '" \\\\',
    '  -H "Content-Type: application/json" \\\\',
    '  -d \\'{"model":"flux-1-schnell","raw":true,"messages":[{"role":"user","content":"a cute robot"}]}\\'',
    '# response.attachments[0].data = base64 PNG',
  ].join('\\n'));

  $('snippets').innerHTML = h;
  // The code is already included in the snippetBlock output, so we just need to ensure
  // the copy buttons work correctly (they're already set up in snippetBlock)
}

function copySnippet(id) {
  var s = pendingSnips.find(function(x) { return x.id === id; });
  if (s) { navigator.clipboard.writeText(s.code); toast('Copied!'); }
}

// ─── Init ───
(async function init() {
  checkHealth();
  setInterval(checkHealth, 30000);
  loadModels();
})();
</script>
</body>
</html>`;
