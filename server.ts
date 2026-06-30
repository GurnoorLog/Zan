import { serve } from "bun";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 3100;
const CDP_PORT = parseInt(process.env.CDP_PORT || "9222");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json",
};

function serveFile(path: string): Response {
  const full = join(__dirname, "public", path);
  if (!existsSync(full)) return new Response("Not found", { status: 404 });
  const ext = full.substring(full.lastIndexOf("."));
  const body = readFileSync(full);

  if (path === "/index.html" || path === "/") {
    const bridge = `
<style>
#bankai-stop-btn {
  position: fixed; bottom: 100px; right: 24px; z-index: 99999;
  display: none; align-items: center; gap: 6px;
  padding: 10px 18px; border: none; border-radius: 999px;
  background: #ef4444; color: #fff; font-size: 14px; font-weight: 600;
  cursor: pointer; box-shadow: 0 4px 12px rgba(239,68,68,0.4);
  transition: transform 0.15s, opacity 0.15s;
  font-family: system-ui, -apple-system, sans-serif;
}
#bankai-stop-btn:hover { transform: scale(1.05); background: #dc2626; }
#bankai-stop-btn:active { transform: scale(0.95); }
#bankai-todo {
  position: fixed; top: 80px; right: 24px; z-index: 99999;
  background: rgba(15,15,20,0.88); backdrop-filter: blur(12px);
  border: 1px solid rgba(0,200,255,0.25); border-radius: 12px;
  padding: 14px 16px; min-width: 240px; max-width: 320px;
  font-family: system-ui, -apple-system, sans-serif;
  display: none;
  box-shadow: 0 8px 32px rgba(0,0,0,0.5);
}
#bankai-todo h3 {
  margin: 0 0 8px 0; font-size: 13px; font-weight: 700;
  color: #00ccff; letter-spacing: 0.5px; text-transform: uppercase;
}
#bankai-todo-list { margin: 0; padding: 0; list-style: none; }
#bankai-todo-list li {
  padding: 4px 0; font-size: 12px; line-height: 1.4;
  color: rgba(255,255,255,0.85); display: flex; gap: 8px; align-items: flex-start;
}
#bankai-todo-list li .icon { flex-shrink: 0; width: 16px; text-align: center; }
#bankai-todo-list li.done { color: rgba(255,255,255,0.4); }
#bankai-todo-list li.done .icon { color: #22c55e; }
#bankai-todo-list li.active .icon { color: #00ccff; }
</style>
<button id="bankai-stop-btn">⏹ Stop Agent</button>
<div id="bankai-todo"><h3>Steps</h3><ul id="bankai-todo-list"></ul></div>
<div id="bankai-settings-panel" style="position:fixed;bottom:160px;right:24px;z-index:99999;background:rgba(15,15,20,0.92);backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,0.15);border-radius:12px;padding:16px;min-width:300px;font-family:system-ui,sans-serif;display:none;box-shadow:0 8px 32px rgba(0,0,0,0.5)">
  <h3 style="margin:0 0 12px 0;font-size:13px;font-weight:700;color:#00ccff;letter-spacing:0.5px;text-transform:uppercase">⚙️ Settings</h3>
  <p style="margin:0 0 12px 0;font-size:11px;color:rgba(255,255,255,0.5)">Set your AI provider API keys here. Forwarded to the agent for each task.</p>
  <label style="display:block;font-size:11px;color:rgba(255,255,255,0.6);margin-bottom:4px">Gemini API Key (for images + Gemini buddy)</label>
  <input id="bankai-gemini-key" type="password" style="width:100%;padding:8px 12px;border:1px solid rgba(255,255,255,0.15);border-radius:8px;background:rgba(0,0,0,0.3);color:#fff;font-size:13px;outline:none;box-sizing:border-box;margin-bottom:10px" placeholder="AIzaSy...">
  <button id="bankai-save-keys" style="padding:8px 16px;border:none;border-radius:8px;background:#00ccff;color:#000;font-size:13px;font-weight:600;cursor:pointer;width:100%">Save & Close</button>
</div>
<button id="bankai-settings-btn" title="API Settings" style="position:fixed;bottom:60px;right:24px;z-index:99999;width:40px;height:40px;border-radius:50%;border:1px solid rgba(255,255,255,0.15);background:rgba(15,15,20,0.8);backdrop-filter:blur(8px);color:#fff;font-size:18px;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 12px rgba(0,0,0,0.3);animation:pulse-gear 2s ease-in-out infinite">⚙️</button>
<style>
@keyframes pulse-gear {
  0%, 100% { box-shadow: 0 4px 12px rgba(0,0,0,0.3); }
  50% { box-shadow: 0 4px 20px rgba(0,204,255,0.4); }
}
#bankai-settings-btn:hover { animation: none; background: rgba(0,204,255,0.2); }
</style>
<script>
(function() {
  let ws = null;
  let reconnectTimer = null;

  const stopBtn = document.getElementById('bankai-stop-btn');
  function showStop() { if (stopBtn) stopBtn.style.display = 'flex'; }
  function hideStop() { if (stopBtn) stopBtn.style.display = 'none'; }

  stopBtn && (stopBtn.onclick = function() {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'stop' }));
    }
    if (typeof window.setZanStatus === 'function') {
      window.setZanStatus('idle');
    }
    hideStop();
    if (typeof window.addZanMessage === 'function') {
      window.addZanMessage('⏹ Agent stopped');
    }
  });

  const todo = {
    ul: document.getElementById('bankai-todo-list'),
    panel: document.getElementById('bankai-todo'),
    items: [],
    add(step) {
      const li = document.createElement('li');
      li.dataset.step = step;
      li.innerHTML = '<span class="icon">⏳</span><span>' + step + '</span>';
      this.ul.appendChild(li);
      this.items.push(li);
      this.panel.style.display = 'block';
    },
    done(step) {
      for (const li of this.items) {
        if (li.dataset.step === step) {
          li.className = 'done';
          li.querySelector('.icon').textContent = '✅';
          break;
        }
      }
    },
    err(step) {
      for (const li of this.items) {
        if (li.dataset.step === step) {
          li.className = 'done';
          li.querySelector('.icon').textContent = '❌';
          break;
        }
      }
    },
    active(idx) {
      for (const li of this.items) li.className = '';
      if (this.items[idx]) this.items[idx].className = 'active';
    },
    clear() {
      this.ul.innerHTML = '';
      this.items = [];
      this.panel.style.display = 'none';
    }
  };
  let currentStepIdx = 0;
  let lastToolCall = '';

  function connect() {
    ws = new WebSocket('ws://' + location.host + '/ws');
    ws.onopen = () => { console.log('[Bridge] WS connected'); };
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'log') {
          const text = msg.text || '';
          
          const stepMatch = text.match(/Step (\d+) tool: (\w+)/);
          if (stepMatch) {
            const stepNum = parseInt(stepMatch[1]);
            const toolName = stepMatch[2];
            const args = text.substring(text.indexOf('{'));

            let displayArgs = '';
            try {
              const parsed = JSON.parse(args);
              displayArgs = parsed.text || parsed.query || parsed.url || parsed.selector || parsed.ariaLabel || '';
              if (displayArgs.length > 40) displayArgs = displayArgs.slice(0, 40) + '...';
            } catch {}
            const label = toolName + (displayArgs ? ': ' + displayArgs : '');
            
            if (stepNum !== todo.items.length - 1) {
              todo.add(label);
              currentStepIdx = todo.items.length - 1;
              lastToolCall = toolName;
            } else {
              
              const lastLi = todo.items[todo.items.length - 1];
              if (lastLi) {
                lastLi.querySelector('span:last-child').textContent = label;
                lastToolCall = toolName;
              }
            }
          }
          const stepResultMatch = text.match(/Step (\d+) result:/);
          if (stepResultMatch) {
            const stepNum = parseInt(stepResultMatch[1]);
            const isError = text.includes('Error') || text.includes('error');
            if (stepNum < todo.items.length) {
              if (isError) todo.err(stepNum);
              else todo.done(stepNum);
            }
          }
          if (text.startsWith('LOG:')) {
            if (typeof window.addZanMessage === 'function') {
              window.addZanMessage(text.slice(4));
            }
          } else if (text.startsWith('DONE:')) {
            if (typeof window.addZanMessage === 'function') {
              window.addZanMessage('✅ ' + text.slice(5));
            }
            if (typeof window.setZanStatus === 'function') {
              window.setZanStatus('idle');
            }
            hideStop();
          } else if (text.startsWith('ERR:')) {
            if (typeof window.addZanMessage === 'function') {
              window.addZanMessage('❌ ' + text.slice(4));
            }
            if (typeof window.setZanStatus === 'function') {
              window.setZanStatus('idle');
            }
            hideStop();
          } else if (text.startsWith('SYSTEM:')) {
            if (typeof window.addZanMessage === 'function') {
              window.addZanMessage('⚙️ ' + text.slice(7));
            }
          } else if (text.startsWith('ASK_USER:')) {
            if (typeof window.addZanMessage === 'function') {
              window.addZanMessage('❓ ' + text.slice(9).split('|')[0]);
            }
          }
        } else if (msg.type === 'status') {
          console.log('[Bridge] Status:', msg.text);
        } else if (msg.type === 'error') {
          if (typeof window.addZanMessage === 'function') {
            window.addZanMessage('⚠️ ' + msg.text);
          }
        }
      } catch(err) { console.error('[Bridge] parse err:', err); }
    };
    ws.onclose = () => {
      reconnectTimer = setTimeout(connect, 2000);
    };
    ws.onerror = () => { ws && ws.close(); };
  }

  function loadApiKeys() {
    try { return JSON.parse(localStorage.getItem('bankai_api_keys') || '{}'); } catch { return {}; }
  }
  function saveApiKeys(keys) {
    localStorage.setItem('bankai_api_keys', JSON.stringify(keys));
  }

  const settingsBtn = document.getElementById('bankai-settings-btn');
  const settingsPanel = document.getElementById('bankai-settings-panel');
  if (settingsBtn && settingsPanel) {
    settingsBtn.onclick = () => {
      const isOpen = settingsPanel.style.display === 'block';
      settingsPanel.style.display = isOpen ? 'none' : 'block';
      if (!isOpen) {
        const keys = loadApiKeys();
        const geminiInput = document.getElementById('bankai-gemini-key');
        if (geminiInput) geminiInput.value = keys.gemini || '';
      }
    };
    document.getElementById('bankai-save-keys')?.addEventListener('click', () => {
      const geminiInput = document.getElementById('bankai-gemini-key');
      const keys = loadApiKeys();
      if (geminiInput) keys.gemini = geminiInput.value.trim();
      saveApiKeys(keys);
      settingsPanel.style.display = 'none';
    });
  }

  function detectBuddyFromDom() {
    try {
      
      const labels = document.querySelectorAll('span');
      for (const label of labels) {
        if (label.textContent === 'AI Buddy') {
          const parent = label.parentElement;
          if (parent) {
            const nameSpan = parent.querySelector('span:first-child');
            if (nameSpan && nameSpan.textContent) {
              return nameSpan.textContent.trim().toLowerCase();
            }
          }
        }
      }
      
      const grid = document.querySelector('[class*="grid-cols-3"]');
      if (grid) {
        const activeBtn = grid.querySelector('[class*="ring-foreground"]');
        if (activeBtn) {
          const label = activeBtn.querySelector('[class*="text-xs"]');
          if (label && label.textContent) return label.textContent.trim().toLowerCase();
        }
      }
    } catch (e) { console.error('[Bridge] detectBuddy err:', e); }
    return 'zan';
  }

  window.getCurrentBuddy = function() {
    return detectBuddyFromDom() || 'zan';
  };

  window.addEventListener('zan-send', function(e) {
    const msg = e.detail && e.detail.content;
    if (!msg || !msg.trim()) return;
    if (typeof window.setZanStatus === 'function') {
      window.setZanStatus('loading');
    }
    showStop();
    if (ws && ws.readyState === WebSocket.OPEN) {
      const buddy = window.getCurrentBuddy();
      const keys = loadApiKeys();
      ws.send(JSON.stringify({ type: 'task', text: msg, buddy, apiKeys: keys }));
    } else {
      if (typeof window.addZanMessage === 'function') {
        window.addZanMessage('⚠️ Not connected to server. Retrying...');
      }
      connect();
    }
  });

  connect();
})();
</script>`;
    const injected = body.toString().replace("</body>", bridge + "</body>");
    return new Response(injected, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  return new Response(body, {
    headers: { "Content-Type": MIME[ext] || "application/octet-stream" },
  });
}

const BROWSER_PATHS: [string, string, string][] = [
  ["chrome",  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",     ""],
  ["chrome",  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",""],
  ["chrome",  join(process.env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe"), ""],
  ["brave",   "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe", ""],
  ["brave",   "C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe", ""],
  ["brave",   join(process.env.LOCALAPPDATA || "", "BraveSoftware\\Brave-Browser\\Application\\brave.exe"), ""],
  ["edge",    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", ""],
  ["edge",    join(process.env.LOCALAPPDATA || "", "Microsoft\\Edge\\Application\\msedge.exe"), ""],
  ["chromium","C:\\Program Files\\Chromium\\Application\\chrome.exe",           ""],
  ["msedge",  join(process.env.LOCALAPPDATA || "", "Microsoft\\Edge SxS\\Application\\msedge.exe"), ""],
];

function findBrowser(): { name: string; path: string } | null {
  const envPath = process.env.BROWSER_PATH;
  if (envPath && existsSync(envPath)) {
    const name = envPath.includes("brave") ? "Brave" : envPath.includes("edge") ? "Edge" : "Chrome";
    return { name, path: envPath };
  }
  for (const [name, p] of BROWSER_PATHS) {
    if (existsSync(p)) return { name: name.charAt(0).toUpperCase() + name.slice(1), path: p };
  }
  return null;
}

function launchBrowser() {
  if (process.env.NO_LAUNCH === "1") return;
  const found = findBrowser();
  if (!found) {
    console.log("No browser found. Start one manually with --remote-debugging-port=" + CDP_PORT);
    return;
  }

  const dataDir = join(__dirname, ".browser-data");
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

  const devPort = process.env.ZAN_DEV_PORT;
  const url = devPort ? `http://localhost:${devPort}` : `http://localhost:${PORT}`;

  const extPath = "C:\\Users\\tambe\\AppData\\Local\\Google\\Chrome\\User Data\\Profile 3\\Extensions\\gipfclelhppmafdlajajjkfepiiccnfd\\1.0.3_0";

  const args = [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${dataDir}`,
    `--load-extension=${extPath}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--start-maximized",
    "--disable-popup-blocking",
    "--new-window",
    url,
  ];

  console.log(`Launching ${found.name} at ${found.path}`);
  console.log(`CDP on port ${CDP_PORT}, browser opens at ${url}`);

  const proc = spawn(found.path, args, {
    detached: true,
    stdio: "ignore",
  });
  proc.unref();

  proc.on("error", (err) => {
    console.error(`Failed to launch ${found.name}: ${err.message}`);
  });
}

let agentProcess: ReturnType<typeof spawn> | null = null;
let agentRunning = false;

function startAgent(task: string, apiKeys: Record<string, string>, buddy: string, sendToWs: (msg: string) => void, onDone: () => void) {
  if (agentRunning) {
    sendToWs("SYSTEM:An agent is already running. Wait for it to finish.");
    return;
  }

  const agentPath = join(__dirname, "agent.ts");
  if (!existsSync(agentPath)) {
    sendToWs("SYSTEM:agent.ts not found at " + agentPath);
    return;
  }

  const bunPath = process.env.BUN_PATH || (() => {
    try {
      const result = Bun.which("bun");
      if (result) return result;
    } catch {}
    return "C:\\Users\\tambe\\.bun\\bin\\bun.exe";
  })();
  agentRunning = true;
  sendToWs("SYSTEM:Launching agent...");

  agentProcess = spawn(bunPath, ["run", agentPath, task], {
    cwd: __dirname,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, AI_BUDDY: buddy, ...Object.fromEntries(Object.entries(apiKeys).map(([k, v]) => [`API_KEY_${k.toUpperCase()}`, v])) },
  });

  let buffer = "";

  agentProcess.stdout?.on("data", (data: Buffer) => {
    const text = data.toString();
    buffer += text;

    if (buffer.includes("__ASK_USER__:")) {
      const idx = buffer.indexOf("__ASK_USER__:");
      const payload = buffer.substring(idx + 13).trim();
      const parts = payload.split("|");
      const question = parts.shift() || "Question";
      sendToWs(`ASK_USER:${question}|${parts.join("|")}`);
      buffer = buffer.substring(0, idx);
      return;
    }

    if (text.includes("TASK COMPLETE:")) {
      const tidx = text.indexOf("TASK COMPLETE:");
      const reason = text.substring(tidx + 14).trim();
      sendToWs(`DONE:${reason}`);
      stopAgent();
      onDone();
      return;
    }

    const lines = buffer.split("\n");
    buffer = lines.pop() || ""; 
    for (const line of lines) {
      if (line.trim()) sendToWs(`LOG:${line.trim()}`);
    }
  });

  agentProcess.stderr?.on("data", (data: Buffer) => {
    sendToWs(`ERR:${data.toString().trim()}`);
  });

  agentProcess.on("close", (code) => {
    agentRunning = false;
    agentProcess = null;
    if (buffer.trim()) sendToWs(`LOG:${buffer.trim()}`);
    sendToWs(`DONE:Agent exited with code ${code}`);
    onDone();
  });

  agentProcess.on("error", (err) => {
    agentRunning = false;
    agentProcess = null;
    sendToWs(`ERR:Failed to start agent: ${err.message}`);
    onDone();
  });
}

function sendToAgent(text: string) {
  if (agentProcess?.stdin?.writable) {
    agentProcess.stdin.write(text + "\n");
  }
}

function stopAgent() {
  if (agentProcess) {
    agentProcess.kill();
    agentProcess = null;
  }
  agentRunning = false;
}

interface WSClient {
  send(msg: string): void;
  readyState: number;
}

const clients = new Set<WSClient>();

function broadcast(msg: string) {
  for (const c of clients) {
    try { c.send(msg); } catch {}
  }
}

const server = Bun.serve({
  port: PORT,
  websocket: {
    open(ws) {
      clients.add(ws);
      ws.send(JSON.stringify({ type: "status", text: "connected" }));
    },
    message(ws, raw) {
      try {
        const msg = JSON.parse(raw.toString());
        switch (msg.type) {
          case "task":
            startAgent(msg.text, msg.apiKeys || {}, msg.buddy || 'zan', (m) => {
              ws.send(JSON.stringify({ type: "log", text: m }));
            }, () => {});
            break;
          case "answer":
            sendToAgent(msg.text);
            break;
          case "stop":
            stopAgent();
            ws.send(JSON.stringify({ type: "log", text: "SYSTEM:Agent stopped" }));
            break;
        }
      } catch (e) {
        ws.send(JSON.stringify({ type: "error", text: String(e) }));
      }
    },
    close(ws) {
      clients.delete(ws);
    },
  },
  fetch(req, server) {
    const url = new URL(req.url);

    if (url.pathname === "/ws") {
      return server.upgrade(req) || new Response("Upgrade failed", { status: 400 });
    }

    if (url.pathname === "/") return serveFile("/index.html");
    return serveFile(url.pathname);
  },
});

console.log(`BankaiAgent running at http://localhost:${PORT}`);

launchBrowser();
