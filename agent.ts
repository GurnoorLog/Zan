import { generateText, tool, stepCountIs, hasToolCall, NoContentGeneratedError, EmptyResponseBodyError } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import puppeteer, { type Page, type Browser } from "puppeteer-core";
import { z } from "zod";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { loadPreferences, savePreference, buildPreferencesPrompt, learnFromTask } from "./preferences";

const CDP_PORT = parseInt(process.env.CDP_PORT || "9222");
const MAX_STEPS = parseInt(process.env.MAX_STEPS || "50");
const MAX_EMPTY_RETRIES = parseInt(process.env.MAX_EMPTY_RETRIES || "3");

const NIM_BASE_URL =
  process.env.NIM_BASE_URL || "https://integrate.api.nvidia.com/v1";

function loadNvidiaApiKey(): string | null {
  if (process.env.NVIDIA_API_KEY) return process.env.NVIDIA_API_KEY.trim();
  return readEnvFile("NVIDIA_API_KEY");
}

function loadNgcApiKey(): string | null {
  if (process.env.NGC_API_KEY) return process.env.NGC_API_KEY.trim();
  return readEnvFile("NGC_API_KEY");
}

function readEnvFile(key: string): string | null {
  const envFile = process.env.NVIDIA_ENV_FILE ||
    join(process.cwd(), "nvidia.env");
  if (!existsSync(envFile)) return null;
  const raw = readFileSync(envFile, "utf8").trim();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith(key + "=")) {
      const eq = trimmed.indexOf("=");
      return trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "") || null;
    }
  }
  return null;
}

function readEnvVar(key: string): string | null {
  const val = process.env[key];
  if (val) return val.trim();
  return readEnvFile(key);
}

function buildModel() {
  const provider = (readEnvVar("PROVIDER") || "auto").toLowerCase();
  const wantsNim = provider === "nvidia" || provider === "nim" ||
    (provider === "auto" && !!loadNvidiaApiKey());

  if (wantsNim) {
    const apiKey = loadNvidiaApiKey();
    if (!apiKey) {
      log(
        "NVIDIA_API_KEY not found in env or nvidia.env — falling back to Ollama."
      );
    } else {
      const modelId =
        readEnvVar("NIM_MODEL") || "meta/llama-3.1-8b-instruct";
      log(`Using NVIDIA NIM model: ${modelId}`);
      const nim = createOpenAICompatible({
        name: "nvidia-nim",
        baseURL: NIM_BASE_URL,
        apiKey,
      });
      return nim.chatModel(modelId);
    }
  }

  const ollamaUrl = process.env.OLLAMA_URL || "http://localhost:11434";
  const modelId = process.env.MODEL || "devstral:latest";
  log(`Using Ollama model: ${modelId} @ ${ollamaUrl}`);
  const ol = createOpenAICompatible({
    name: "ollama",
    baseURL: `${ollamaUrl}/v1`,
  });
  return ol.chatModel(modelId);
}

const model = buildModel();

function log(msg: string) {
  console.log(msg);
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: Timer | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    const result = await Promise.race([promise, timeout]);
    return result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function askUser(question: string, options?: string, preference_key?: string): Promise<string> {
  const opts = options ? options.split(",").map((s) => s.trim()) : [];
  const line = `__ASK_USER__:${question}${opts.length ? "|" + opts.join("|") : ""}`;
  process.stdout.write(line + "\n");
  const rl = createInterface({ input: process.stdin });
  const answer = await new Promise<string>((resolve) => {
    rl.once("line", (line) => {
      rl.close();
      resolve(line.trim());
    });
  });
  if (preference_key && answer) {
    savePreference(preference_key, answer.toLowerCase());
  }
  return answer;
}

async function connectBrowser(): Promise<{ browser: Browser; page: Page }> {
  let browser: Browser | null = null;
  for (let i = 0; i < 60; i++) {
    try {
      browser = await puppeteer.connect({
        browserURL: `http://localhost:${CDP_PORT}`,
        defaultViewport: null,
      });
      break;
    } catch {
      await sleep(1000);
    }
  }
  if (!browser) throw new Error("Could not connect to browser via CDP");

  log(`Connected to CDP on port ${CDP_PORT}`);

  const page = await browser.newPage();
  log("Opened a new tab for the task");

  return { browser, page };
}

function normalizeUrl(input: string): string | null {
  if (!input) return null;
  let s = input.trim();
  s = s.replace(/^["'`]+|["'`]+$/g, "");
  s = s.replace(/\s+/g, "");

  if (s.startsWith("http://") || s.startsWith("https://")) return s;
  if (s.startsWith("www.")) return "https://" + s;

  const looksLikeDomain = /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/.*)?$/i.test(s);
  if (looksLikeDomain) return "https://" + s;

  return null;
}

async function getPageState(page: Page): Promise<string> {
  try {
    const info = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll("input, textarea, select"))
        .map((el) => {
          const e = el as HTMLInputElement;
          return {
            id: e.id, name: e.name, placeholder: e.placeholder, type: e.type,
            ariaLabel: e.getAttribute("aria-label"),
          };
        }).filter((i) => i.id || i.name || i.placeholder).slice(0, 8);
      const buttons = Array.from(document.querySelectorAll('button, [role="button"], [role="menuitem"], [role="option"], input[type="submit"], .menu-item, [data-action="a-dropdown-button"]'))
        .map((el) => ({
          text: (el as HTMLElement).innerText?.trim().slice(0, 50) || (el as HTMLInputElement).value || "",
          id: el.id || "", ariaLabel: el.getAttribute("aria-label") || "",
        })).filter((b) => b.text || b.ariaLabel).slice(0, 15);
      return { url: window.location.href, title: document.title, inputs, buttons };
    });
    return ` | Inputs: [${info.inputs.map((i) => `#${i.id}`).join(", ")}] | Buttons: [${info.buttons.map((b) => b.text || b.ariaLabel).join(", ")}]`;
  } catch { return ""; }
}

async function refreshPage(page: Page, browser: Browser): Promise<Page> {
  try {
    await page.evaluate(() => 1);
    return page;
  } catch {
    const pages = await browser.pages();
    for (const p of pages) {
      try {
        const u = await p.url();
        if (u && u !== "about:blank") return p;
      } catch {}
    }
    return pages[pages.length - 1] || page;
  }
}

async function ensureOverlay(page: Page) {
  try {
    await page.evaluate(() => {
      if (document.getElementById("__bk_overlay")) return;
      if (!document.body) {
        const observer = new MutationObserver(() => {
          if (document.body && !document.getElementById("__bk_overlay")) {
            inject();
            observer.disconnect();
          }
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
        return;
      }
      inject();
      function inject() {
        const style = document.createElement("style");
        style.id = "__bk_s";
        style.textContent = `
          #__bk_overlay{position:fixed;inset:0;pointer-events:none;z-index:2147483647}
          #__bk_cur{position:fixed;left:0;top:0;width:22px;height:22px;pointer-events:none;z-index:2147483647;filter:drop-shadow(0 0 4px rgba(0,200,255,.7))}
          #__bk_cur svg{width:22px;height:22px}
          #__bk_ring{position:fixed;border-radius:50%;border:3px solid #00ccff;pointer-events:none;z-index:2147483647;opacity:0;transform:scale(.5);left:0;top:0;width:0;height:0}
          #__bk_type_badge{position:fixed;background:rgba(0,0,0,.75);color:#fff;padding:6px 12px;border-radius:8px;font:13px/1.4 monospace;pointer-events:none;z-index:2147483647;opacity:0;white-space:pre;backdrop-filter:blur(8px);border:1px solid rgba(0,200,255,.4);max-width:400px;overflow:hidden}
        `;
        document.head.appendChild(style);
        const ov = document.createElement("div");
        ov.id = "__bk_overlay";
        ov.innerHTML = `
          <div id="__bk_cur"><svg viewBox="0 0 22 22"><path d="M3 2l14 8-6 2-2 6z" fill="rgba(255,255,255,.85)" stroke="#00ccff" stroke-width="1.2" stroke-linejoin="round"/><circle cx="12" cy="11" r="2" fill="#00ccff" opacity=".6"/></svg></div>
          <div id="__bk_ring"></div>
          <div id="__bk_type_badge"></div>
        `;
        document.body.appendChild(ov);
      }
    });
  } catch {
    
  }
}

async function moveCursor(page: Page, x: number, y: number) {
  await page.evaluate(
    ({ x, y }) => {
      const c = document.getElementById("__bk_cur");
      if (!c) return;
      c.style.transition =
        "left 0.25s cubic-bezier(0.25,0.46,0.45,0.94), top 0.25s cubic-bezier(0.25,0.46,0.45,0.94)";
      c.style.left = x + "px";
      c.style.top = y + "px";
    },
    { x, y }
  );
  await sleep(40);
}

async function clickEffect(page: Page, x: number, y: number) {
  await page.evaluate(
    ({ x, y }) => {
      const ring = document.getElementById("__bk_ring");
      if (!ring) return;
      ring.style.transition = "none";
      ring.style.left = (x - 18) + "px";
      ring.style.top = (y - 18) + "px";
      ring.style.width = "36px";
      ring.style.height = "36px";
      ring.style.opacity = "1";
      ring.style.transform = "scale(0.5)";
      ring.offsetHeight;
      ring.style.transition =
        "all 0.45s cubic-bezier(0.25,0.46,0.45,0.94)";
      ring.style.width = "80px";
      ring.style.height = "80px";
      ring.style.left = (x - 40) + "px";
      ring.style.top = (y - 40) + "px";
      ring.style.opacity = "0";
      ring.style.transform = "scale(1.5)";
    },
    { x, y }
  );
  await sleep(250);
}

async function showTyping(page: Page, x: number, y: number, text: string) {
  await page.evaluate(
    ({ x, y, t }) => {
      const b = document.getElementById("__bk_type_badge");
      if (!b) return;
      b.style.left = (x + 16) + "px";
      b.style.top = y + "px";
      b.style.opacity = "1";
      b.style.transition = "none";
      b.textContent = "";
      let i = 0;
      function typeChar() {
        if (i >= t.length) return;
        b.textContent += t[i] === " " ? "\u00A0" : t[i];
        i++;
        setTimeout(typeChar, 30 + Math.random() * 40);
      }
      typeChar();
    },
    { x, y, t: text }
  );
  await sleep(Math.min(text.length * 10, 400));
}

async function hideTyping(page: Page) {
  await page.evaluate(() => {
    const b = document.getElementById("__bk_type_badge");
    if (b) b.style.opacity = "0";
  });
}

async function animateToElement(page: Page, selector: string): Promise<{ x: number; y: number }> {
  const box = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, selector);
  if (box) {
    await moveCursor(page, box.x, box.y);
  }
  return box || { x: 0, y: 0 };
}

function buildTools(browser: Browser, page: Page) {
  return {
    navigate: tool({
      description:
        "Navigate the current page to a FULL URL (must start with http:// or https://, or be a domain like amazon.com). For search queries, use the 'search' tool instead.",
      inputSchema: z.object({
        url: z
          .string()
          .describe(
            "Full URL like https://www.amazon.com or a domain like amazon.com. DO NOT pass empty strings or search terms here."
          ),
      }),
      execute: async ({ url }) => {
        const resolved = normalizeUrl(url);
        if (!resolved) {
          return `Error: '${url}' is not a valid URL. Use the 'search' tool for search queries, or pass a full URL like https://www.amazon.com.`;
        }
        
        let targetUrl = resolved;
        if (targetUrl.includes("drive.google.com") && !targetUrl.includes("/drive/my-drive")) {
          targetUrl = "https://drive.google.com/drive/my-drive";
        } else if (targetUrl.includes("docs.google.com") && !targetUrl.includes("/document/")) {
          targetUrl = "https://docs.google.com/document/create";
        } else if (targetUrl.includes("sheets.google.com") && !targetUrl.includes("/spreadsheet/")) {
          targetUrl = "https://sheets.google.com/spreadsheet/create";
        } else if (targetUrl.includes("slides.google.com") && !targetUrl.includes("/presentation/")) {
          targetUrl = "https://slides.google.com/presentation/create";
        }

        let navErr: Error | null = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            await page.goto(targetUrl, { waitUntil: "networkidle0", timeout: 30000 });
            navErr = null;
            break;
          } catch (e: any) {
            navErr = e;
            log(`Navigation warning (attempt ${attempt + 1}): ${e.message}`);
            await sleep(1000);
          }
        }
        if (navErr) {
          log(`Navigation may not have fully loaded: ${navErr.message}`);
        }
        page = await refreshPage(page, browser);
        await sleep(800);
        const state = await getPageState(page);
        return `Navigated to ${targetUrl}. Page title: "${await page.title()}"${state}`;
      },
    }),

    search: tool({
      description:
        "Search the web. Use this when the user wants to find something. For YouTube searches (music/video), use site='youtube.com'.",
      inputSchema: z.object({
        query: z.string().describe("The search query text"),
        site: z
          .string()
          .optional()
          .describe("Optional site to search on (e.g. 'amazon.com', 'youtube.com')"),
      }),
      execute: async ({ query, site }) => {
        if (!query || !query.trim()) {
          return "Error: search query is empty. Provide a non-empty query.";
        }
        let url: string;
        if (site) {
          const s = site.toLowerCase();
          if (s.includes("youtube")) {
            url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
          } else if (s.includes("amazon")) {
            url = `https://www.amazon.com/s?k=${encodeURIComponent(query)}`;
          } else if (s.includes("aliexpress") || s.includes("alibaba")) {
            url = `https://www.aliexpress.com/wholesale?SearchText=${encodeURIComponent(query)}`;
          } else if (s.includes("ebay")) {
            url = `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(query)}`;
          } else if (s.includes("walmart")) {
            url = `https://www.walmart.com/search?q=${encodeURIComponent(query)}`;
          } else if (s.includes("github")) {
            url = `https://github.com/search?q=${encodeURIComponent(query)}&type=repositories`;
          } else if (s.includes("reddit")) {
            url = `https://www.reddit.com/search/?q=${encodeURIComponent(query)}`;
          } else if (s.includes("google")) {
            url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
          } else if (s.includes("bing")) {
            url = `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
          } else {
            url = normalizeUrl(site) || `https://${site}`;
          }
        } else {
          url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
        }
        try {
          await page.goto(url, { waitUntil: "networkidle0", timeout: 30000 });
        } catch (e: any) {
          log(`Search navigation warning: ${e.message}`);
        }
        page = await refreshPage(page, browser);
        await sleep(800);
        const state = await getPageState(page);
        if (site && site.toLowerCase().includes("youtube")) {
          return `Navigated to YouTube search results for "${query}"${state}. | Tip: click a video title to play it.`;
        }
        const siteHints: Record<string, string> = {
          amazon: " | Use click(text='Sort') to find sorting options, or click(text='Add to Cart') on a product.",
          aliexpress: " | Look for sort/filter options to organize by price.",
          ebay: " | Look for the sort dropdown to organize results.",
          github: " | Browse the search results.",
        };
        const siteKey = site ? Object.keys(siteHints).find(k => site.toLowerCase().includes(k)) : undefined;
        const hint = siteKey ? siteHints[siteKey] : "";
        return `Searched ${site || "Google"} for "${query}". Page title: "${await page.title()}"${state}${hint}`;
      },
    }),

    click: tool({
      description:
        "Click an element on the page by CSS selector, visible text, or aria-label. Use get_page_info or analyze_dom first to find the correct selector/identifier.",
      inputSchema: z.object({
        text: z
          .string()
          .optional()
          .describe("Visible text of the element to click"),
        selector: z
          .string()
          .optional()
          .describe("CSS selector of the element"),
        ariaLabel: z
          .string()
          .optional()
          .describe("aria-label attribute to match"),
      }),
      execute: async ({ text, selector, ariaLabel }) => {
        const curUrl = page.url();
        if (!curUrl || curUrl === "about:blank" || curUrl === "about://blank") {
          return `ERROR: Cannot click on a blank page. Navigate to the target website first using the navigate tool.`;
        }
        await ensureOverlay(page);
        let pos: { x: number; y: number } | null = null;
        if (selector) {
          try {
            await page.waitForSelector(selector, { timeout: 3000 });
            pos = await page.evaluate((sel) => {
              const el = document.querySelector(sel);
              if (!el) return null;
              const r = el.getBoundingClientRect();
              return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
            }, selector);
            if (pos) {
              await moveCursor(page, pos.x, pos.y);
              await clickEffect(page, pos.x, pos.y);
            }
            await page.click(selector);
          } catch (e) {
            return `Error clicking ${selector}: ${e instanceof Error ? e.message : String(e)}`;
          }
        } else if (ariaLabel) {
          try {
            const info = await page.evaluate((label) => {
              const el = document.querySelector(
                `[aria-label="${label.replace(/"/g, '\\"')}"]`
              ) as HTMLElement;
              if (!el) return null;
              const r = el.getBoundingClientRect();
              return {
                x: r.left + r.width / 2,
                y: r.top + r.height / 2,
              };
            }, ariaLabel);
            if (!info) return `Could not find element with aria-label: ${ariaLabel}`;
            pos = info;
            await moveCursor(page, pos.x, pos.y);
            await clickEffect(page, pos.x, pos.y);
            await page.mouse.click(pos.x, pos.y);
          } catch (e) {
            return `Error clicking aria-label "${ariaLabel}"`;
          }
        } else if (text) {
          
          const lowerText = text.toLowerCase();
          if ((lowerText.includes("add to cart") || lowerText.includes("buy now")) && curUrl.includes("/s?")) {
            return `ERROR: Cannot click "${text}" on a search results page. First click on a product link (name or image) to open the product detail page, THEN click "${text}" on the product page.`;
          }
          try {
            const info = await page.evaluate((t) => {
              const all = document.querySelectorAll<HTMLElement>(
                'button, a, [role="button"], [role="option"], [role="listbox"], [role="menuitem"], select, option, span, [tabindex], [data-action="a-dropdown-button"], .a-dropdown-container, .a-dropdown-link, .menu-item'
              );
              
              const hasMenuAncestor = (el: HTMLElement) => {
                let p = el.parentElement;
                while (p) {
                  const role = p.getAttribute('role');
                  if (role === 'menu' || role === 'listbox' || role === 'menubar') return true;
                  if (p.classList.contains('a-popover') || p.classList.contains('dropdown-menu') || p.classList.contains('menu-container')) return true;
                  p = p.parentElement;
                }
                return false;
              };
              let target = Array.from(all).find((el) => {
                if (!(el.textContent || "").trim().toLowerCase().includes(t.toLowerCase())) return false;
                const r = el.getBoundingClientRect();
                if (r.width === 0 || r.height === 0) return false;
                if (r.top < 80) return false; 
                return hasMenuAncestor(el);
              });
              
              if (!target) {
                target = Array.from(all).find((el) => {
                  if (!(el.textContent || "").trim().toLowerCase().includes(t.toLowerCase())) return false;
                  const role = el.getAttribute('role');
                  if (role !== 'menuitem' && role !== 'option') return false;
                  const r = el.getBoundingClientRect();
                  return r.width > 0 && r.height > 0 && r.top >= 80;
                });
              }
              
              if (!target) {
                target = Array.from(all).find((el) => {
                  const r = el.getBoundingClientRect();
                  if (r.width === 0 || r.height === 0) return false;
                  if (r.top < 80) return false;
                  if (el.offsetParent === null) return false;
                  return (el.textContent || "").trim().toLowerCase().includes(t.toLowerCase());
                });
              }
              if (!target) return null;
              const r = target.getBoundingClientRect();
              return {
                x: r.left + r.width / 2,
                y: r.top + r.height / 2,
              };
            }, text);
            if (!info) return `Could not find element with text: ${text}`;
            pos = info;
            await moveCursor(page, pos.x, pos.y);
            await clickEffect(page, pos.x, pos.y);
            await page.mouse.click(pos.x, pos.y);
          } catch (e) {
            return `Error clicking text "${text}"`;
          }
        } else {
          return "Error: provide text, selector, or ariaLabel.";
        }
        await sleep(800);
        page = await refreshPage(page, browser);
        
        const prevCount = (await browser.pages()).length;
        const currentUrl = page.url();
        
        let newPageDetected = false;
        for (let w = 0; w < 6; w++) {
          const pagesNow = await browser.pages();
          if (pagesNow.length > prevCount) {
            const candidates = pagesNow.filter(p => {
              try { const u = p.url(); return u && u !== "about:blank" && u !== currentUrl; } catch { return false; }
            });
            if (candidates.length > 0) {
              const newest = candidates[candidates.length - 1];
              try {
                await newest.bringToFront();
                page = newest;
                newPageDetected = true;
                break;
              } catch {}
            }
          }
          await sleep(500);
        }
        const state = await getPageState(page);
        const label = selector || ariaLabel || text || "";
        return `Clicked "${label}".${state}`;
      },
    }),

    type: tool({
      description:
        "Type text into an input field. Use the 'selector' parameter (CSS selector from get_page_info/analyze_dom) or 'id'. By default it presses Enter to submit.",
      inputSchema: z.object({
        text: z.string().describe("The text to type"),
        id: z
          .string()
          .optional()
          .describe("Element id (e.g. 'twotabsearchtextbox' for Amazon)"),
        selector: z
          .string()
          .optional()
          .describe("CSS selector like '#twotabsearchtextbox' or 'input[name=q]'"),
        pressEnter: z
          .union([z.boolean(), z.string()])
          .default(true)
          .describe("Press Enter after typing to submit (default true)"),
        clear: z
          .union([z.boolean(), z.string()])
          .default(true)
          .describe("Clear the field before typing (default true)"),
      }),
      execute: async ({ text, id, selector, pressEnter, clear }) => {
        const curUrl = page.url();
        if (!curUrl || curUrl === "about:blank" || curUrl === "about://blank") {
          return `ERROR: Cannot type into a blank page. Navigate to the target website first using the navigate tool.`;
        }
        await ensureOverlay(page);
        let sel: string | undefined;
        if (selector && selector.trim()) sel = selector.trim();
        if (!sel && id) sel = `#${id}`;
        if (!sel) {
          
          const activeTag = await page.evaluate(() => {
            const el = document.activeElement;
            if (!el || el === document.body) return null;
            const tag = el.tagName.toLowerCase();
            if (tag === 'input' || tag === 'textarea' || (el as HTMLElement).isContentEditable) {
              
              const id = el.id ? `#${CSS.escape(el.id)}` : null;
              if (id) return id;
              
              return null;
            }
            return null;
          });
          if (activeTag) {
            sel = activeTag;
          } else {

            const doPress = String(pressEnter).toLowerCase() === "true";
            const doClear = String(clear).toLowerCase() === "true";
            if (doClear) {
              await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
              await sleep(100);
              await page.keyboard.press('Backspace');
            }
            await page.keyboard.type(text, { delay: 50 });
            if (doPress) {
              await sleep(200);
              await page.keyboard.press("Enter");
              await sleep(300);
            }
            return `Typed "${text}" into active element.`;
          }
        }
        const doPress = String(pressEnter).toLowerCase() === "true";
        const doClear = String(clear).toLowerCase() === "true";
        try {
          const isInteractive = await page.evaluate((s) => {
            try {
              const el = document.querySelector(s);
              if (!el) return false;
              const tag = el.tagName.toLowerCase();
              if (['title', 'head', 'script', 'style', 'meta', 'link'].includes(tag)) return false;
              if ((el as HTMLElement).offsetParent === null && tag !== 'option') return false;
              const r = el.getBoundingClientRect();
              if (r.width === 0 || r.height === 0) return false;
              return true;
            } catch {
              return false; 
            }
          }, sel);
          if (!isInteractive) {
            
            if (doClear) {
              await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
              await sleep(100);
              await page.keyboard.press('Backspace');
            }
            await page.keyboard.type(text, { delay: 50 });
            if (doPress) {
              await sleep(200);
              await page.keyboard.press("Enter");
              await sleep(300);
            }
            return `Typed "${text}" into active element (selector "${sel}" was not interactive).`;
          }
          
          try {
            await page.waitForSelector(sel, { timeout: 5000 });
          } catch {
            
            await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
            await sleep(100);
            await page.keyboard.press('Backspace');
            await page.keyboard.type(text, { delay: 50 });
            if (doPress) { await sleep(200); await page.keyboard.press("Enter"); await sleep(300); }
            return `Typed "${text}" via keyboard (selector "${sel}" invalid).`;
          }

          const pos = await page.evaluate((s) => {
            try {
              const el = document.querySelector(s);
              if (!el) return null;
              const r = el.getBoundingClientRect();
              return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
            } catch { return null; }
          }, sel);
          if (pos) {
            await moveCursor(page, pos.x, pos.y);
            await showTyping(page, pos.x, pos.y, text);
          }

          if (doClear) {
            await page.evaluate((s) => {
              try {
                const el = document.querySelector(s);
                if (!el) return;
                const proto = Object.getPrototypeOf(el);
                const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
                if (setter) setter.call(el, "");
                else (el as HTMLInputElement).value = "";
                el.dispatchEvent(new Event("input", { bubbles: true }));
                el.dispatchEvent(new Event("change", { bubbles: true }));
              } catch {}
            }, sel);
          }

          try {
            await page.focus(sel);
            await page.click(sel);
            await page.type(sel, text, { delay: 50 });
          } catch {
            
            await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
            await sleep(100);
            await page.keyboard.press('Backspace');
            await page.keyboard.type(text, { delay: 50 });
            if (doPress) { await sleep(200); await page.keyboard.press("Enter"); await sleep(300); }
            return `Typed "${text}" via keyboard (selector interaction failed).`;
          }
          await hideTyping(page);

          const valueAfterType = await page.$eval(sel, (el) => {
            const inp = el as HTMLInputElement;
            return inp.value;
          }).catch(() => "");

          if (!valueAfterType) {
            await page.evaluate(
              ({ s, t }) => {
                try {
                  const el = document.querySelector(s) as HTMLInputElement;
                  if (!el) return;
                  const proto = Object.getPrototypeOf(el);
                  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
                  if (setter) setter.call(el, t);
                  else el.value = t;
                  el.dispatchEvent(new Event("input", { bubbles: true }));
                  el.dispatchEvent(new Event("change", { bubbles: true }));
                } catch {}
              },
              { s: sel, t: text }
            );
          }

          if (doPress) {
            await sleep(200);
            await page.keyboard.press("Enter");
            await sleep(300);
            
            try {
              const submitted = await page.evaluate((s) => {
                try {
                  const el = document.querySelector(s) as HTMLInputElement | null;
                  if (!el) return false;
                  const form = el.closest("form") as HTMLFormElement | null;
                  if (form) {
                    if (typeof form.requestSubmit === "function") form.requestSubmit();
                    else form.submit();
                    return true;
                  }
                } catch {}
                return false;
              }, sel);
              if (!submitted) {
                const inputBtnClicked = await page.evaluate(() => {
                  const submitSelectors = [
                    'input[type="submit"]',
                    'button[type="submit"]',
                    '#nav-search-submit-button',
                  ];
                  for (const sel of submitSelectors) {
                    try {
                      const btn = document.querySelector(sel) as HTMLElement;
                      if (btn) { btn.click(); return true; }
                    } catch {}
                  }
                  return false;
                });
              }
            } catch {}
          }

          const state = "";
          await sleep(1000);
          return `Typed "${text}" into ${sel}${doPress ? " and submitted" : ""}.${state}`;
        } catch (e) {
          return `Error typing into ${sel}: ${e instanceof Error ? e.message : String(e)}`;
        }
      },
    }),

    press_enter: tool({
      description: "Press the Enter key (e.g. to submit a form).",
      inputSchema: z.object({}),
      execute: async () => {
        await page.keyboard.press("Enter");
        await sleep(800);
        return "Pressed Enter";
      },
    }),

    select_option: tool({
      description:
        "Select an option from a dropdown/select element by its CSS selector and the visible text of the option. Use this for sort dropdowns, filter dropdowns, etc. For Amazon sort: pass selector='#s-result-sort-select' and option='Price: Low to High'.",
      inputSchema: z.object({
        selector: z.string().describe("CSS selector of the select element (e.g. '#s-result-sort-select', '#sortingDropdown')"),
        option: z.string().describe("The visible text of the option to select (e.g. 'Price: Low to High')"),
      }),
      execute: async ({ selector, option }) => {
        try {
          await page.waitForSelector(selector, { timeout: 3000 });
          const selected = await page.evaluate(({ sel, opt }) => {
            const select = document.querySelector(sel) as HTMLSelectElement;
            if (select) {
              const options = Array.from(select.options);
              const match = options.find(o =>
                o.text.toLowerCase().includes(opt.toLowerCase())
              );
              if (match) {
                select.value = match.value;
                select.dispatchEvent(new Event('change', { bubbles: true }));
                return `Selected "${match.text}"`;
              }
            }
            
            const dropdownBtn = document.querySelector(sel) as HTMLElement;
            if (dropdownBtn) {
              dropdownBtn.click();
              
              setTimeout(() => {
                const items = document.querySelectorAll<HTMLElement>(
                  '[role="option"], .a-dropdown-link, .a-dropdown-item, li[data-value]'
                );
                for (const item of items) {
                  if (item.textContent?.toLowerCase().includes(opt.toLowerCase())) {
                    item.click();
                    return `Clicked option "${item.textContent?.trim()}"`;
                  }
                }
              }, 300);
            }
            return null;
          }, { sel: selector, opt: option });
          if (selected) {
            await sleep(1000);
            page = await refreshPage(page, browser);
            const state = await getPageState(page);
            return `Selected "${option}" in ${selector}.${state}`;
          }
          return `Could not find option "${option}" in ${selector}. Try using click or analyze_dom instead.`;
        } catch (e) {
          return `Error selecting option: ${e instanceof Error ? e.message : String(e)}`;
        }
      },
    }),

    keyboard: tool({
      description:
        "Send keyboard shortcuts or keystrokes. Supports chorded shortcuts like 'alt + c' (press keys together) and sequential shortcuts like 'alt + c then t' (press one chord after another). Use this for keyboard navigation in web apps like Google Drive, Docs, etc.",
      inputSchema: z.object({
        keys: z.string().describe("Keys to press. Examples: 'alt + c then t' (Google Drive: Create → Doc), 'ctrl + a' (select all), 'ctrl + c' (copy), 'ctrl + v' (paste), 'ctrl + z' (undo), 'Enter', 'Tab', 'Escape', 'F2'. Mac users: use 'command' instead of 'ctrl'."),
      }),
      execute: async ({ keys }) => {
        try {
          const curUrl = page.url();
          if (!curUrl || curUrl === "about:blank" || curUrl === "about://blank") {
            return `ERROR: Cannot send keyboard shortcut "${keys}" from ${curUrl || "blank page"}. You must navigate to the target website FIRST using the navigate tool. For Google Drive, use navigate({url: "https://drive.google.com"}). Then use keyboard shortcuts once the page has loaded.`;
          }
          const sequences = keys.split(/\s+then\s+/i).map(s => s.trim());
          for (const seq of sequences) {
            const chords = seq.split(/\s*\+\s*/).map(k => k.trim());
            const mods: string[] = [];
            const mainKeys: string[] = [];
            for (const k of chords) {
              const low = k.toLowerCase();
              if (['alt', 'ctrl', 'command', 'cmd', 'meta', 'shift', 'option'].includes(low)) {
                const mapped = low === 'cmd' ? 'Meta' : low === 'option' ? 'Alt' : low === 'command' ? 'Meta' : low.charAt(0).toUpperCase() + low.slice(1);
                mods.push(mapped);
              } else {
                
                const keyMap: Record<string, string> = {
                  'tab': 'Tab', 'enter': 'Enter', 'escape': 'Escape', 'esc': 'Escape',
                  'backspace': 'Backspace', 'delete': 'Delete', 'space': ' ',
                  'up': 'ArrowUp', 'down': 'ArrowDown', 'left': 'ArrowLeft', 'right': 'ArrowRight',
                  'uparrow': 'ArrowUp', 'downarrow': 'ArrowDown', 'leftarrow': 'ArrowLeft', 'rightarrow': 'ArrowRight',
                  'home': 'Home', 'end': 'End', 'pageup': 'PageUp', 'pagedown': 'PageDown',
                  'f1': 'F1', 'f2': 'F2', 'f3': 'F3', 'f4': 'F4', 'f5': 'F5', 'f6': 'F6',
                  'f7': 'F7', 'f8': 'F8', 'f9': 'F9', 'f10': 'F10', 'f11': 'F11', 'f12': 'F12',
                  '/': '/',
                };
                mainKeys.push(keyMap[low] || k);
              }
            }
            
            for (const m of mods) await page.keyboard.down(m);
            for (const k of mainKeys) {
              await page.keyboard.press(k);
              await sleep(50);
            }
            
            for (const m of mods) await page.keyboard.up(m);
            await sleep(200);
          }
          
          const prevCount = (await browser.pages()).length;
          const currentUrl = page.url();
          for (let w = 0; w < 6; w++) {
            const pagesNow = await browser.pages();
            if (pagesNow.length > prevCount) {
              const candidates = pagesNow.filter(p => {
                try { const u = p.url(); return u && u !== "about:blank" && u !== currentUrl; } catch { return false; }
              });
              if (candidates.length > 0) {
                const newest = candidates[candidates.length - 1];
                try {
                  await newest.bringToFront();
                  page = newest;
                  await sleep(2000);
                  return `Sent keyboard shortcut: ${keys} — auto-switched to new tab`;
                } catch {}
              }
            }
            await sleep(500);
          }
          return `Sent keyboard shortcut: ${keys}`;
        } catch (e) {
          return `Error sending keyboard shortcut: ${e instanceof Error ? e.message : String(e)}`;
        }
      },
    }),

    get_page_info: tool({
      description:
        "Get the current page URL, title, headings, inputs, buttons, and first links. Call this BEFORE interacting with a new page.",
      inputSchema: z.object({}),
      execute: async () => {
        const info = await page.evaluate(() => {
          const SEMANTIC_ATTRS = [
            'data-testid', 'data-cy', 'data-test', 'data-qa',
            'data-id', 'name', 'aria-label', 'aria-labelledby',
            'role', 'title', 'placeholder', 'alt', 'href'
          ];

          function isUniqueSelector(sel: string, el: Element): boolean {
            try {
              const results = document.querySelectorAll(sel);
              return results.length === 1 && results[0] === el;
            } catch { return false; }
          }

          function generateSelector(el: Element): string {
            if (el.id && el.id.trim()) {
              const sel = `#${CSS.escape(el.id)}`;
              if (isUniqueSelector(sel, el)) return sel;
            }
            const tag = el.tagName.toLowerCase();
            for (const attr of SEMANTIC_ATTRS) {
              const val = el.getAttribute(attr);
              if (val && val.trim() && val.length < 100) {
                const sel = `${tag}[${attr}="${CSS.escape(val)}"]`;
                if (isUniqueSelector(sel, el)) return sel;
                const selNoTag = `[${attr}="${CSS.escape(val)}"]`;
                if (isUniqueSelector(selNoTag, el)) return selNoTag;
              }
            }
            const classes = Array.from(el.classList).filter(c =>
              c.length > 0 && c.length < 60 && !c.match(/[a-f0-9]{6,}/i) && !c.match(/^\d/)
            );
            for (let size = 1; size <= Math.min(3, classes.length); size++) {
              const combos = getCombinations(classes, size);
              for (const combo of combos) {
                const sel = tag + combo.map(c => `.${CSS.escape(c)}`).join('');
                if (isUniqueSelector(sel, el)) return sel;
              }
            }
            const parts: string[] = [];
            let cur: Element | null = el;
            let depth = 0;
            while (cur && cur !== document.documentElement && depth < 8) {
              const t = cur.tagName.toLowerCase();
              if (cur.id) { parts.unshift(`#${CSS.escape(cur.id)}`); break; }
              const cs = Array.from(cur.classList).filter(c => c.length < 60 && !c.match(/[a-f0-9]{6,}/i)).slice(0, 2);
              const seg = cs.length ? t + cs.map(c => `.${CSS.escape(c)}`).join('') : t;
              parts.unshift(seg);
              const cand = parts.join(' > ');
              if (isUniqueSelector(cand, el)) return cand;
              cur = cur.parentElement;
              depth++;
            }
            return parts.join(' > ');
          }

          function getCombinations(arr: string[], size: number): string[][] {
            if (size === 1) return arr.map(x => [x]);
            const r: string[][] = [];
            for (let i = 0; i <= arr.length - size; i++) {
              for (const combo of getCombinations(arr.slice(i + 1), size - 1)) {
                r.push([arr[i], ...combo]);
              }
            }
            return r;
          }

          function collectElement(el: Element) {
            const rect = el.getBoundingClientRect();
            const innerText = (el.textContent || '').trim().slice(0, 200);
            return {
              tag: el.tagName.toLowerCase(),
              selector: generateSelector(el),
              text: innerText,
              id: el.id || undefined,
              classes: Array.from(el.classList).join('.') || undefined,
              ariaLabel: el.getAttribute('aria-label') || undefined,
              position: `${Math.round(rect.left)}x${Math.round(rect.top)}`,
              size: `${Math.round(rect.width)}x${Math.round(rect.height)}`,
              visible: rect.width > 0 && rect.height > 0 &&
                rect.top < window.innerHeight && rect.bottom > 0 &&
                rect.left < window.innerWidth && rect.right > 0,
            };
          }

          const links = Array.from(document.querySelectorAll('a[href]'))
            .map(a => ({
              text: (a as HTMLElement).innerText?.trim().slice(0, 80) || '',
              href: (a as HTMLAnchorElement).href,
              selector: generateSelector(a),
            }))
            .filter(l => l.href && !l.href.startsWith('javascript:') && !l.href.startsWith('#'))
            .slice(0, 40);

          const inputs = Array.from(document.querySelectorAll('input, textarea, select'))
            .map(el => collectElement(el))
            .filter(i => i.text || i.ariaLabel || i.id)
            .slice(0, 25);

          const buttons = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"]'))
            .map(el => {
              const text = (el as HTMLElement).innerText?.trim().slice(0, 60) || (el as HTMLInputElement).value || '';
              const rect = el.getBoundingClientRect();
              return {
                text,
                selector: generateSelector(el),
                id: el.id || undefined,
                ariaLabel: el.getAttribute('aria-label') || undefined,
                position: `${Math.round(rect.left)}x${Math.round(rect.top)}`,
              };
            })
            .filter(b => b.text || b.ariaLabel)
            .slice(0, 25);

          const clickable = Array.from(document.querySelectorAll('[onclick], [tabindex]:not([tabindex="-1"]), .btn, [role="button"], [role="link"], [role="tab"], [role="menuitem"]'))
            .map(el => collectElement(el))
            .filter(el => el.text || el.ariaLabel)
            .slice(0, 15);

          const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
            .map(h => (h as HTMLElement).innerText?.trim())
            .filter(Boolean)
            .slice(0, 10);

          return {
            url: window.location.href,
            title: document.title,
            headings,
            inputsCount: inputs.length,
            inputs,
            buttonsCount: buttons.length,
            buttons,
            clickableCount: clickable.length,
            clickable,
            linksCount: links.length,
            sampleLinks: links.slice(0, 8),
          };
        });
        const raw = JSON.stringify(info, null, 2);
        return raw.length > 2000 ? raw.slice(0, 2000) + "\n... (truncated)" : raw;
      },
    }),

    extract: tool({
      description: "Extract visible text from the page or a specific element.",
      inputSchema: z.object({
        selector: z
          .string()
          .optional()
          .describe("CSS selector (omit for full page text)"),
        maxChars: z
          .number()
          .default(3000)
          .describe("Max characters to return (default 3000)"),
      }),
      execute: async ({ selector, maxChars }) => {
        if (selector) {
          try {
            const el = await page.$(selector);
            if (!el) return `Element not found: ${selector}`;
            const text = await el.evaluate(
              (e) => (e as HTMLElement).innerText?.slice(0, maxChars) || ""
            );
            return text || "No text content";
          } catch (e) {
            return `Error extracting ${selector}`;
          }
        }
        const text = await page.evaluate(
          (m) => document.body?.innerText?.slice(0, m) || "",
          maxChars
        );
        return text;
      },
    }),

    scroll: tool({
      description: "Scroll the page in a direction or to top/bottom.",
      inputSchema: z.object({
        direction: z
          .enum(["up", "down", "top", "bottom"])
          .describe("Where to scroll"),
      }),
      execute: async ({ direction }) => {
        await page.evaluate((d) => {
          if (d === "top") window.scrollTo(0, 0);
          else if (d === "bottom")
            window.scrollTo(0, document.body.scrollHeight);
          else if (d === "up") window.scrollBy(0, -800);
          else window.scrollBy(0, 800);
        }, direction);
        await sleep(500);
        return `Scrolled ${direction}`;
      },
    }),

    wait: tool({
      description: "Wait for a specified number of seconds.",
      inputSchema: z.object({
        seconds: z
          .number()
          .default(2)
          .describe("Seconds to wait (default 2)"),
      }),
      execute: async ({ seconds }) => {
        await sleep((seconds || 2) * 1000);
        return `Waited ${seconds || 2}s`;
      },
    }),

    list_tabs: tool({
      description: "List all open tabs/pages in the browser with their titles and URLs.",
      inputSchema: z.object({}),
      execute: async () => {
        const pages = await browser.pages();
        const info = await Promise.all(pages.map(async (p, i) => ({
          index: i,
          title: await p.title() || "untitled",
          url: (p.url() || "about:blank").slice(0, 80),
        })));
        return JSON.stringify(info, null, 2);
      },
    }),

    switch_tab: tool({
      description: "Switch the agent's focus to a different tab by its 0-based index. Use list_tabs first to see available tabs.",
      inputSchema: z.object({
        index: z.number().int().min(0).describe("The 0-based index of the tab to switch to"),
      }),
      execute: async ({ index }) => {
        const pages = await browser.pages();
        if (index < 0 || index >= pages.length) {
          return `Error: tab index ${index} is out of range. There are ${pages.length} tabs (0-${pages.length - 1}).`;
        }
        const newPage = pages[index];
        await newPage.bringToFront();
        page = newPage;
        const title = await newPage.title();
        return `Switched to tab ${index}: "${title}" (${newPage.url() || "about:blank"})`;
      },
    }),

    new_tab: tool({
      description: "Open a new blank tab and switch focus to it.",
      inputSchema: z.object({
        url: z.string().optional().describe("Optional URL to open in the new tab"),
      }),
      execute: async ({ url }) => {
        const newPage = await browser.newPage();
        page = newPage;
        if (url) {
          const resolved = normalizeUrl(url);
          if (resolved) {
            await newPage.goto(resolved, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
            await sleep(800);
          }
        }
        const title = await newPage.title();
        return `Opened new tab: "${title || "blank"}"`;
      },
    }),

    analyze_dom: tool({
      description:
        "Deep scan of the page: get ALL interactive elements with CSS selectors, positions, text, and attributes. Use this when get_page_info doesn't have enough detail to find the right element to click or type into.",
      inputSchema: z.object({
        selector: z.string().optional().describe("CSS selector to filter (e.g. 'nav', '#main', '.product-card')"),
      }),
      execute: async ({ selector }) => {
        const info = await page.evaluate((sel) => {
          function isUnique(sel: string, el: Element): boolean {
            try { const r = document.querySelectorAll(sel); return r.length === 1 && r[0] === el; } catch { return false; }
          }
          const ATTRS = ['data-testid','data-cy','data-test','data-qa','data-id','name','aria-label','role','title','placeholder','alt','href'];
          function genSel(el: Element): string {
            if (el.id) { const s = `#${CSS.escape(el.id)}`; if (isUnique(s, el)) return s; }
            const tag = el.tagName.toLowerCase();
            for (const a of ATTRS) {
              const v = el.getAttribute(a);
              if (v && v.length < 100) {
                const s = `${tag}[${a}="${CSS.escape(v)}"]`;
                if (isUnique(s, el)) return s;
              }
            }
            const cls = Array.from(el.classList).filter(c => c.length < 60 && !c.match(/[a-f0-9]{6,}/i));
            for (let n = 1; n <= Math.min(3, cls.length); n++) {
              const parts = combinations(cls, n);
              for (const p of parts) {
                const s = tag + p.map(c => `.${CSS.escape(c)}`).join('');
                if (isUnique(s, el)) return s;
              }
            }
            const segs: string[] = [];
            let cur: Element | null = el;
            let d = 0;
            while (cur && cur !== document.documentElement && d < 8) {
              const t = cur.tagName.toLowerCase();
              if (cur.id) { segs.unshift(`#${CSS.escape(cur.id)}`); break; }
              const cs = Array.from(cur.classList).filter(c => c.length<60).slice(0,2);
              segs.unshift(cs.length ? t + cs.map(c=>`.${CSS.escape(c)}`).join('') : t);
              if (isUnique(segs.join(' > '), el)) return segs.join(' > ');
              cur = cur.parentElement; d++;
            }
            return segs.join(' > ');
          }
          function combinations(arr: string[], n: number): string[][] {
            if (n===1) return arr.map(x=>[x]);
            const r: string[][] = [];
            for (let i=0; i<=arr.length-n; i++)
              for (const c of combinations(arr.slice(i+1), n-1))
                r.push([arr[i], ...c]);
            return r;
          }
          function collect(el: Element) {
            const r = el.getBoundingClientRect();
            const text = (el.textContent||'').trim().slice(0, 150);
            const attrs: Record<string,string> = {};
            for (const a of ['type','name','placeholder','value','href','src','alt','aria-label','data-testid','title','role']) {
              const v = el.getAttribute(a);
              if (v) attrs[a] = v.slice(0, 100);
            }
            return {
              tag: el.tagName.toLowerCase(),
              selector: genSel(el),
              text,
              id: el.id || undefined,
              attrs: Object.keys(attrs).length ? attrs : undefined,
              pos: `${Math.round(r.left)}x${Math.round(r.top)}`,
              size: `${Math.round(r.width)}x${Math.round(r.height)}`,
              visible: r.width>0 && r.height>0 && r.top<innerHeight && r.left<innerWidth,
            };
          }

          const root = sel ? document.querySelectorAll(sel) : [document];
          if (sel) {
            const elements: any[] = [];
            root.forEach(el => {
              if (el.nodeType !== 1) return;
              elements.push(collect(el as Element));
              const children = (el as Element).querySelectorAll('a, button, input, textarea, select, [role="button"], [role="link"], [tabindex]:not([tabindex="-1"]), [onclick]');
              children.forEach(ch => elements.push(collect(ch as Element)));
            });
            return { url: location.href, title: document.title, elements: elements.slice(0, 60) };
          }

          const all: any[] = [];
          const seen = new Set<string>();
          const allLinks = document.querySelectorAll('a[href]');
          allLinks.forEach(a => {
            const href = (a as HTMLAnchorElement).href;
            if (href && !href.startsWith('javascript:') && !href.startsWith('#')) {
              const info = collect(a);
              if (info.text || info.attrs?.href) {
                const key = info.selector || info.text;
                if (!seen.has(key)) { seen.add(key); all.push(info); }
              }
            }
          });
          const allButtons = document.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"], [onclick]');
          allButtons.forEach(b => {
            const info = collect(b);
            if (info.text || info.attrs?.['aria-label']) {
              const key = info.selector || info.text;
              if (!seen.has(key)) { seen.add(key); all.push(info); }
            }
          });
          const allInputs = document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea, select');
          allInputs.forEach(inp => {
            const info = collect(inp);
            if (info.id || info.attrs?.name || info.attrs?.placeholder) {
              const key = info.selector || info.id;
              if (!seen.has(key)) { seen.add(key); all.push(info); }
            }
          });

          return {
            url: location.href,
            title: document.title,
            elements: all.slice(0, 80),
          };
        }, selector || undefined);
        const json = JSON.stringify(info, null, 2);
        return json.length > 1500 ? json.slice(0, 1500) + "\n... (truncated)" : json;
      },
    }),

    knowledge: tool({
      description:
        "Research any topic, write summaries, or get factual answers. Uses a powerful LLM (NVIDIA NIM or Gemini depending on AI buddy) for knowledge-intensive tasks like writing articles, explaining concepts, creating summaries, or doing research. Use this instead of search when the user wants written content or detailed explanations.",
      inputSchema: z.object({
        query: z.string().describe("What to research or write about. Be detailed about what you want."),
      }),
      execute: async ({ query }) => {
        try {
          
          if (process.env.AI_BUDDY === "gemini") {
            const apiKey = process.env.API_KEY_GEMINI || process.env.GEMINI_API_KEY;
            if (apiKey) {
              const url = `https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
              const res = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  contents: [{ parts: [{ text: query }] }],
                  generationConfig: { temperature: 0.7, maxOutputTokens: 2048 },
                }),
              });
              if (res.ok) {
                const data = await res.json() as any;
                const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "No response.";
                return `## Gemini Research Result\n\n${text}`;
              }
            }
          }
          
          const apiKey = loadNvidiaApiKey();
          if (!apiKey) return "Knowledge tool requires NVIDIA API key.";
          const url = "https://integrate.api.nvidia.com/v1/chat/completions";
          const body = JSON.stringify({
            model: "meta/llama-3.1-70b-instruct",
            messages: [
              { role: "system", content: "You are a helpful research assistant. Provide detailed, accurate, well-structured information." },
              { role: "user", content: query },
            ],
            temperature: 0.7,
            max_tokens: 2048,
          });
          const res = await fetch(url, {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body,
          });
          if (!res.ok) {
            const errText = await res.text().catch(() => "");
            return `Knowledge query failed (${res.status}): ${errText}`;
          }
          const data = await res.json() as any;
          const content = data.choices?.[0]?.message?.content || "No response.";
          return `## Research Result\n\n${content}`;
        } catch (e) {
          return `Knowledge error: ${e instanceof Error ? e.message : String(e)}`;
        }
      },
    }),

    call_gemini: tool({
      description:
        "Call Google Gemini AI for tasks like text generation, analysis, or answering questions. Uses the Gemini API key set in the settings panel. When the AI buddy is set to Gemini, prefer this tool over knowledge() for answering questions and research.",
      inputSchema: z.object({
        prompt: z.string().describe("The prompt or question for Gemini"),
      }),
      execute: async ({ prompt }) => {
        try {
          const apiKey = process.env.API_KEY_GEMINI || process.env.GEMINI_API_KEY;
          if (!apiKey) return "Gemini API key not set. Go to settings and add your Gemini API key.";
          const url = `https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
          const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { temperature: 0.7, maxOutputTokens: 2048 },
            }),
          });
          if (!res.ok) {
            const errText = await res.text().catch(() => "");
            return `Gemini API error (${res.status}): ${errText}`;
          }
          const data = await res.json() as any;
          const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "No response.";
          return `## Gemini Response\n\n${text}`;
        } catch (e) {
          return `Gemini error: ${e instanceof Error ? e.message : String(e)}`;
        }
      },
    }),

    generate_image: tool({
      description:
        "Generate an image using AI (Qwen-Image or Gemini depending on AI buddy). Provide a detailed prompt describing what you want to see. The image is returned as markdown.",
      inputSchema: z.object({
        prompt: z.string().describe("Detailed description of the image to generate"),
        seed: z.number().int().optional().describe("Optional seed for reproducible results"),
      }),
      execute: async ({ prompt, seed }) => {
        
        const geminiKey = process.env.API_KEY_GEMINI || process.env.GEMINI_API_KEY;
        let geminiError = "";
        if (geminiKey) {
          try {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp-image-generation:generateContent?key=${geminiKey}`;
            const res = await fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { temperature: 1, maxOutputTokens: 4096 },
              }),
            });
            if (res.ok) {
              const data = await res.json() as any;
              const parts = data?.candidates?.[0]?.content?.parts || [];
              for (const part of parts) {
                if (part.inlineData?.mimeType?.startsWith("image/")) {
                  return `![Generated Image](data:${part.inlineData.mimeType};base64,${part.inlineData.data})\n\n*Generated with Gemini 2.0 Flash: "${prompt}"*`;
                }
              }
              const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "No image generated.";
              return `## Gemini Image Response\n\n${text}`;
            } else {
              const errText = await res.text().catch(() => "");
              geminiError = `Gemini API error (${res.status}): ${errText.slice(0, 200)}`;
            }
          } catch (e) {
            geminiError = `Gemini error: ${e instanceof Error ? e.message : String(e)}`;
          }
        }
        
        const imageUrl = process.env.QWEN_IMAGE_URL || "http://localhost:8000/v1/infer";
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        const ngcKey = loadNgcApiKey();
        if (ngcKey) headers["Authorization"] = `Bearer ${ngcKey}`;
        try {
          const res = await fetch(imageUrl, {
            method: "POST",
            headers,
            body: JSON.stringify({ prompt, seed: seed ?? 0 }),
          });
          if (res.ok) {
            const data = await res.json();
            const b64 = data.artifacts?.[0]?.base64;
            if (b64) return `![Generated Image](data:image/png;base64,${b64})\n\n*Generated with Qwen-Image: "${prompt}"*`;
          }
        } catch {}
        if (geminiError) {
          return `Image generation failed. Gemini: ${geminiError}`;
        }
        return `Image generation failed. No Gemini API key set (add in ⚙️ settings) and Qwen-Image NIM at ${imageUrl} is not running.`;
      },
    }),

    ask_user: tool({
      description:
        "Ask the user a question and wait for their answer. Use this when you need a decision (e.g. 'Which platform? YouTube or Spotify?'). After asking, store their preference.",
      inputSchema: z.object({
        question: z.string().describe("The question to ask the user"),
        options: z
          .string()
          .optional()
          .describe("Comma-separated options like 'YouTube, Spotify'"),
        preference_key: z
          .string()
          .optional()
          .describe("If set, save the answer as this preference key for future use"),
      }),
      execute: async ({ question, options, preference_key }) => {
        const answer = await askUser(question, options, preference_key);
        return `User answered: "${answer}"${preference_key ? ` (saved as preference ${preference_key})` : ""}`;
      },
    }),

    wait_for_login: tool({
      description:
        "Use this when you encounter a login/sign-in page. It tells the user they need to login manually, then periodically checks if they're logged in. The agent waits until the user finishes logging in before continuing. Common login pages: accounts.google.com, amazon.com/ap/signin, Apple ID, Microsoft login.",
      inputSchema: z.object({
        message: z.string().optional().describe("Optional message to show the user (e.g. 'Please sign in to Google to continue')"),
      }),
      execute: async ({ message }) => {
        log(`ASK_USER:${message || "Please log in to continue. I'll wait for you..."}`);
        const checkLogin = async (): Promise<boolean> => {
          try {
            const url = page.url();
            const isLoginPage = url.includes("accounts.google.com") || url.includes("signin") || url.includes("login") || url.includes("auth") || url.includes("ap/signin");
            if (!isLoginPage) {
              
              const hasPostLogin = await page.evaluate(() => {
                const body = document.body;
                if (!body) return false;
                const text = body.innerText || "";
                
                return !text.includes("Sign in") && !text.includes("Email or phone") &&
                  !document.querySelector('input[type="email"]') &&
                  !document.querySelector("#identifierId");
              });
              return hasPostLogin;
            }
            return false;
          } catch {
            return false;
          }
        };
        for (let i = 0; i < 120; i++) { 
          const loggedIn = await checkLogin();
          if (loggedIn) {
            page = await refreshPage(page, browser);
            const state = await getPageState(page);
            return `User has logged in successfully. Current page: ${page.url()}${state}`;
          }
          if (i % 10 === 0) {
            log(`LOG:⏳ Waiting for you to log in... (${Math.round((120 - i) / 2)}s remaining)`);
          }
          await sleep(5000);
        }
        return "Timed out waiting for login. Please try again with a fresh session.";
      },
    }),

    done: tool({
      inputSchema: z.object({
        reason: z.string().describe("Summary of what was accomplished"),
      }),
      execute: async ({ reason }) => {
        return `TASK COMPLETE: ${reason}`;
      },
    }),
  };
}

function extractTaskFromArgv(argv: string[]): string {
  for (let i = argv.length - 1; i >= 0; i--) {
    const arg = argv[i];
    if (
      !arg ||
      arg.startsWith("/") ||
      arg === "agent.ts" ||
      arg === "run" ||
      arg === "agent" ||
      arg.includes("\\") ||
      arg.endsWith("bun.exe") ||
      arg.endsWith("node.exe")
    ) {
      continue;
    }
    return arg;
  }
  return "";
}

const LOCK_FILE = join(
  process.env.TEMP || "/tmp",
  "browseros-agent.lock"
);

function acquireLock(): boolean {
  try {
    if (existsSync(LOCK_FILE)) {
      const oldPid = parseInt(readFileSync(LOCK_FILE, "utf8").trim());
      if (!isNaN(oldPid)) {
        try {
          const result = Bun.spawnSync(["tasklist", "/FI", `PID eq ${oldPid}`, "/NH"]);
          const stdout = result.stdout.toString().trim();
          if (stdout.includes(String(oldPid))) {
            console.error(`Agent lock held by PID ${oldPid} — exiting`);
            return false;
          }
        } catch {
          try {
            process.kill(oldPid, 0);
            console.error(`Agent lock held by PID ${oldPid} — exiting`);
            return false;
          } catch {
            
          }
        }
        unlinkSync(LOCK_FILE);
      }
    }
    writeFileSync(LOCK_FILE, String(process.pid));
    process.on("exit", () => {
      try { unlinkSync(LOCK_FILE); } catch {}
    });
    return true;
  } catch {
    return true;
  }
}

async function main() {
  if (!acquireLock()) process.exit(0);

  const task = extractTaskFromArgv(process.argv);
  if (!task) {
    console.error("Usage: bun run agent.ts '<task description>'");
    process.exit(1);
  }

  log(`Task: ${task}`);
  log(`Connecting to browser via CDP on port ${CDP_PORT}...`);
  const { browser, page } = await connectBrowser();

  const tools = buildTools(browser, page);

  learnFromTask(task);

  const prefs = loadPreferences();
  const prefsPrompt = buildPreferencesPrompt(prefs);

  const buddy = process.env.AI_BUDDY || "zan";

  const instructions = [
    "You are BrowserOS, a friendly AI browser buddy who helps the user get things done. You control a browser using tools. You LOVE talking to the user -- explain what you're doing, ask questions, share what you find, and be enthusiastic!",
    "",
    "YOUR PERSONALITY:",
    "- You're a helpful, chatty friend who's excited to help",
    "- Before doing something significant, explain it to the user and ask for their input",
    "- When you find something interesting (like a song, product, or info), share your thoughts!",
    "- Use casual, friendly language -- you're a buddy, not a robot",
    "- Learn the user's preferences and use them to make better suggestions",
    "",
    `AI BUDDY: "${buddy}"` + (buddy === "gemini" ? " — Gemini handles knowledge and image generation. Use call_gemini for questions and Gemini handles generate_image." : " — Zan uses NVIDIA NIM for knowledge. For images, try generate_image (uses Qwen-Image). If image generation fails, tell the user to switch to Gemini buddy."),
    "",
    'TASK: "' + task + '"',
    "",
    "AVAILABLE TOOLS: navigate, search, click, type, press_enter, select_option, keyboard, get_page_info, analyze_dom, extract, scroll, wait, list_tabs, switch_tab, new_tab, generate_image, knowledge, call_gemini, ask_user, wait_for_login, done.",
    "",
    "CRITICAL RULE -- YOU MUST CALL TOOLS ONE AT A TIME:",
    "- You MUST call EXACTLY ONE tool per response.",
    "- Wait for the result before calling the next tool.",
    "- NEVER call multiple tools in the same response (no parallel tool calls).",
    "- If you see more than one tool call below, DELETE all but the first one.",
    "",
    "HOW TO BEHAVE:",
    '0. CRITICAL -- YOU MUST NAVIGATE FIRST: Every task starts on a blank tab (about:blank). The VERY FIRST thing you must do is navigate to the target website using the navigate tool. The keyboard, click, and type tools will REJECT commands on a blank page. NEVER try keyboard shortcuts or clicks before navigating.',
    "1. TALK to the user! Tell them what you're doing, why, and ask for their input.",
    "2. Always call ONE tool at a time! Do not call navigate and search in the same step.",
    "3. Use ask_user() whenever you need a decision -- don't guess what the user wants.",
    '4. Save preferences with ask_user(preference_key="...", options="...") so you learn over time.',
    "5. If the task involves music/video/shopping, check saved preferences first, then ask if unsure.",
    '6. For music: search for the song on YouTube, or ask "YouTube Music or Spotify?"',
    '7. For shopping: navigate to the site, search for the product, THEN apply filters if the user wants something specific (e.g. lowest price, cheapest -> sort by "Price: Low to High"):',
    '   - On Amazon results page, use select_option(selector="#s-result-sort-select", option="Price: Low to High") to sort by price. If that doesn\'t work, try clicking a dropdown button or using analyze_dom to find the sort widget.',
    "   - After sorting, click on the cheapest product (first result now shows the lowest price)",
    '   - Then look for "Add to Cart" or "Buy Now" buttons',
    "   - On AliExpress: use select_option or click to find the sorting option after search",
    '   - If the user says "cheapest", "lowest cost", "budget", "best price" etc. -> ALWAYS set the lowest-price filter/sort before clicking a product',
    "8. For information: search Google and read the results aloud.",
    "9. Use list_tabs to see all open tabs, switch_tab to move between them, new_tab to open a fresh one.",
    '10. If the user asks to create/generate/draw an image, use generate_image(prompt) -- describe what they want in detail.',
    '11. For research, writing summaries, or getting detailed knowledge: use knowledge(query) — it uses a powerful LLM via NIM to research any topic.',
    "12. Only call done() when the task is fully complete -- do NOT call done() prematurely.",
    "12. If a tool returns an error, try a different approach -- different selector, different URL, different search term. Use analyze_dom to see the current page state. Do NOT repeat the exact same failing tool call.",
    "13. If typing into an input fails, use analyze_dom to find the correct selector, then try again with the right selector.",
    "14. LOGIN PAGES: If the page shows a login form (Google sign-in, Amazon sign-in, etc.), use wait_for_login to ask the user to log in. WAIT for them -- do NOT try to fill in login forms yourself or navigate away.",
    '15. GOOGLE WORKSPACE: For Google Drive/Docs/Sheets/Slides -- ALWAYS start by navigating to drive.google.com or the appropriate URL. Do NOT send keyboard shortcuts before navigating to the site.',
    '    - Navigate to drive.google.com -- if redirected to the marketing page (workspace.google.com), click "Go to Drive" or navigate to "https://drive.google.com/drive/my-drive" directly',
    "    - Use the 'keyboard' tool for shortcuts instead of clicking menus -- it's more reliable:",
    '      - Create new document: keyboard(keys="alt + c then t")  (Create menu -> Docs)',
    '      - Create new spreadsheet: keyboard(keys="alt + c then s") (Create -> Sheets)',
    '      - Create new presentation: keyboard(keys="alt + c then p") (Create -> Slides)',
    "      - Rename selected item: press F2",
    "      - Search Drive: press /",
    "      - Open more actions menu: press shift + F10",
    '    - After creating a doc using keyboard(keys="alt + c then t"), the new tab opens automatically. The agent will auto-switch to it.',
    '    - To rename the document: first click on the title (find "Untitled document" text and click it), then type(text="CIAO", pressEnter=true). The title becomes editable after clicking.',
    "    - To type content: click on the document body (the blank area), then type",
    "    - To download: use File -> Download or navigate to the document URL",
    '    - If auto-switch didn\'t happen, use list_tabs + switch_tab to find the new doc tab (look for "Google Docs" or "Untitled" in the URL/title)',
    '16. GOOGLE DRIVE SEARCH: To find files/folders in Google Drive, use the search shortcut:',
    "    - Press / to focus the search bar in Drive, then type the folder/file name and press Enter",
    '    - Example: keyboard(keys="/") then type(text="Promessi Sposi", pressEnter=true) then look for the folder in results',
    "    - If you're already on drive.google.com, use keyboard(keys='/') to activate search",
    '    - Then use click(text="Promessi Sposi") to open the folder once it appears in results',
    "    - Do NOT search Google for Drive files -- use Drive's built-in search with the / shortcut",
    '17. CHECKOUT — CRITICAL: When the user asks to "buy" or "order" something, you MUST follow these EXACT steps:',  
    '    Step 1: Navigate to the store (e.g. amazon.com)',  
    '    Step 2: Search for the product',  
    '    Step 3: CLICK ON A PRODUCT RESULT to open the product detail page (click the product name or image). The URL must contain /dp/ or /product/ before you can add to cart.',  
    '    Step 4: On the product detail page, click "Add to Cart" or "Buy Now"',  
    '    Step 5: Look for the cart icon (usually top right), click it to open the cart page',  
    '    Step 6: On the cart page, click "Proceed to Checkout"',  
    '    Step 7: Handle any sign-in walls with wait_for_login',  
    "    CRITICAL RULES:",  
    "    - NEVER click 'Add to Cart' from the SEARCH RESULTS page (URL contains /s? or /search). Only click it from a product page (URL contains /dp/).",  
    "    - First click on a product name/link to navigate to its detail page, THEN click Add to Cart",  
    "    - NEVER call done() until you see a checkout or payment page",  
    "    - If you can't find 'Proceed to Checkout', use analyze_dom to check the page", 
    "    - The cart page URL usually contains '/cart' or '/gp/cart'",
    "",
    "EXAMPLE CONVERSATIONS:",
    'User: "play despacito"',
    'You: "Ooh, Despacito! Great choice! Let me ask -- where should I play this?"',
    '-> ask_user("Where should I play Despacito?", "YouTube Music, Spotify", preference_key="music_platform")',
    'User: "YouTube Music"',
    'You: "YouTube it is! Let me search for it." -> search("despacito", "youtube")',
    'You: "Found it! Let me click the first result." -> click(text="Despacito")',
    'You: "There you go! Enjoy Despacito!" -> done("Played Despacito on YouTube")',
    "",
    'User: "find me a good laptop under $1000"',
    'You: "Shopping for a laptop? Let\'s check Amazon!" -> navigate("amazon.com")',
    'You: "What kind of laptop are you looking for -- Windows, Mac, or Chromebook?"',
    '-> ask_user("Which type?", "Windows, Mac, Chromebook", preference_key="laptop_type")',
    "",
    "REMEMBER: You're not just a tool -- you're a buddy! Chat with the user, be helpful, and have fun!" + prefsPrompt,
  ].join("\n");

  log("Agent started. Processing task...");
  const startTime = Date.now();
  let emptyRetries = 0;
  let lastError: Error | null = null;

  while (emptyRetries <= MAX_EMPTY_RETRIES) {
    try {
      const result = await generateText({
        model,
        tools,
        messages: [
          {
            role: "system",
            content: instructions,
          },
          {
            role: "user",
            content: task,
          },
        ],
        stopWhen: (r) => stepCountIs(MAX_STEPS)(r) || hasToolCall("done")(r),
        temperature: 0.7,
        allowSystemInMessages: true,
        providerOptions: {
          nvidiaNim: {
            parallel_tool_calls: false,
          },
          ollama: {
            parallel_tool_calls: false,
          },
        },
        onStepFinish: ({ stepNumber, text, content }) => {
          let toolCallCount = 0;
          for (const part of content) {
            if (part.type === "tool-call") {
              toolCallCount++;
            }
          }
          if (toolCallCount > 1) {
            log(`⚠️ WARNING: ${toolCallCount} tools called in step ${stepNumber}! Only the first one was executed.`);
          }
          for (const part of content) {
            if (part.type === "tool-call") {
              log(
                `Step ${stepNumber} tool: ${part.toolName} ${JSON.stringify(part.input)}`
              );
            } else if (part.type === "tool-result") {
              const out =
                typeof part.output === "string"
                  ? part.output
                  : JSON.stringify(part.output);
              log(
                `Step ${stepNumber} result: ${out.slice(0, 200)}`
              );
            }
          }
          if (text && !text.startsWith("TASK COMPLETE:")) {
            log(text);
          }
        },
      });

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      log(`Agent completed in ${elapsed}s`);
      log(`Result: ${result.text || "(no text)"}`);

      const completed = result.steps.some((s) =>
        s.toolCalls?.some((tc) => tc.toolName === "done")
      );
      if (!completed && !result.text) {
        throw new Error("Model ended without calling done() or producing text");
      }

      await sleep(500);
      await browser.disconnect();
      return;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      const isEmpty =
        err instanceof EmptyResponseBodyError ||
        err instanceof NoContentGeneratedError ||
        lastError.message.includes("empty") ||
        lastError.message.includes("NoContent");

      if (isEmpty && emptyRetries < MAX_EMPTY_RETRIES) {
        emptyRetries++;
        log(`Empty response from LLM (retry ${emptyRetries}/${MAX_EMPTY_RETRIES})`);
        await sleep(1500);
        continue;
      }

      console.error(`Agent error: ${lastError.message}`);
      if (lastError.stack) console.error(lastError.stack);
      process.exit(1);
    }
  }

  console.error(
    `Agent failed: ${lastError?.message || "empty response after retries"}`
  );
  process.exit(1);
}

main().catch((err) => {
  console.error("Agent error:", err instanceof Error ? err.message : String(err));
  if (err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  process.exit(1);
});
