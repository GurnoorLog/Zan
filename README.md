# BankaiAgent

An AI browser agent that controls Google Chrome via CDP (Chrome DevTools Protocol). It runs inside the [Zan](https://github.com/zyx0814/Zan) chat UI at `localhost:3100` — you type a task, the agent opens a new browser tab and executes it step by step.

## Architecture

```
Zan Chat UI (localhost:3100)
       |
   WebSocket (bridge injected into index.html)
       |
  server.ts  ← HTTP + WebSocket server
       |
  spawns agent.ts as child process
       |
  agent.ts  ← AI agent with browser tools
       |
  Puppeteer + CDP (port 9222) → Chrome
```

- **server.ts** — Serves the Zan chat UI, injects a WebSocket bridge into `index.html`, manages Chrome lifecycle, forwards API keys from the UI to the agent.
- **agent.ts** — The AI agent loop. Uses `@ai-sdk/vercel-ai` with NVIDIA NIM API (default: `meta/llama-3.1-70b-instruct`). Has ~20 tools for browser control.
- **nvidia.env** — NVIDIA NIM credentials + model config. **Do not commit.**
- **public/** — Zan's pre-built Next.js static export. The bridge is injected at serve time.

## Requirements

- [Bun](https://bun.sh) runtime
- Google Chrome (or Brave/Edge)
- NVIDIA NIM API key (set in `nvidia.env`)

## Setup

1. Clone the repo
2. Place your `nvidia.env` in the project root:
   ```
   NVIDIA_API_KEY=nvapi-xxxxx
   NIM_MODEL=meta/llama-3.1-70b-instruct
   NGC_API_KEY=nvapi-xxxxx
   ```
3. Install dependencies:
   ```
   bun install
   ```

## Running

### Option A: Double-click `start.bat`
Kills old server, starts a new one, opens the chat UI. Press any key to stop.

### Option B: Terminal
```bash
bun run server.ts
```
Opens http://localhost:3100.

### Option C: Dev mode (auto-restart on changes)
```bash
bun run dev
```

## How to Use

1. Open http://localhost:3100
2. Click the ⚙️ gear icon (bottom-right) to set your Gemini API key (for image generation)
3. Select an AI buddy from the pill selector (Zan = NVIDIA NIM, Gemini = Google Gemini)
4. Type a task like "open gmail and send an email to test@example.com saying hello"
5. Watch the agent open a new tab and execute steps — the Steps panel shows progress
6. Click ⏹ Stop Agent to abort

## Available Tools (agent.ts)

| Tool | Description |
|---|---|
| `navigate` | Go to a URL (auto-resolves Google Drive, Docs, Sheets, Slides to create pages) |
| `search` | Search Google, Amazon, YouTube, eBay, Reddit, GitHub, etc. |
| `click` | Click by CSS selector, visible text, or aria-label |
| `type` | Type text into input fields (supports CSS selector, element id, or active element) |
| `press_enter` | Press Enter to submit |
| `select_option` | Select a dropdown option by selector + visible text |
| `keyboard` | Send keyboard shortcuts (e.g. `alt + c then t` for Drive create → Doc) |
| `get_page_info` | Get URL, title, inputs, buttons, links with CSS selectors |
| `analyze_dom` | Deep DOM scan of all interactive elements |
| `extract` | Get visible text from page or element |
| `scroll` | Scroll up/down/top/bottom |
| `wait` | Wait N seconds |
| `list_tabs` | List all open tabs |
| `switch_tab` | Switch to tab by index |
| `new_tab` | Open a new tab (optionally with a URL) |
| `knowledge` | Research/writing via NVIDIA NIM |
| `call_gemini` | Call Gemini 2.0 Flash API |
| `generate_image` | Generate image via Gemini 2.0 Flash Image Generation (or Qwen-Image NIM fallback) |
| `wait_for_login` | Wait for user to complete login |
| `ask_user` | Prompt the user for input |

## Known Behaviors

- **Amazon checkout**: Agent must click a product first (clicking "Add to Cart" on search results is blocked)
- **Gmail**: First load takes ~30s (CDP timeout with 2 retries)
- **Google Drive**: `keyboard({keys: "alt + c then t"})` → new tab opens → auto-switch
- **Image generation**: Gemini API returns 429 if prepayment credits are depleted

## Key Bindings

- `Ctrl+A` in Puppeteer: not a valid key — use `down('Control')` + `press('a')` + `up('Control')`
- Invalid CSS selectors (like `#:nth-child(1)` from Gmail DOM) are caught and fall back to keyboard typing

## Configuration

All environment variables can be set in `nvidia.env`:

| Variable | Default | Description |
|---|---|---|
| `NVIDIA_API_KEY` | — | NVIDIA NIM API key (required) |
| `NIM_MODEL` | `meta/llama-3.1-8b-instruct` | LLM model to use |
| `PROVIDER` | `auto` | `nvidia`, `ollama`, or `auto` |
| `NIM_BASE_URL` | `https://integrate.api.nvidia.com/v1` | NIM API base URL |
| `CDP_PORT` | `9222` | Chrome DevTools Protocol port |
| `MAX_STEPS` | `50` | Max tool calls per task |
| `NO_LAUNCH` | — | Set to `1` to skip auto-launching Chrome |
| `BROWSER_PATH` | — | Override browser executable path |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama base URL (fallback) |

