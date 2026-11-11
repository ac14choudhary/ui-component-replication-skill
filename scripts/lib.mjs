// Shared helpers for locate.mjs, extract.mjs, and compare.mjs.

import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function fail(message) {
  console.error(message);
  process.exit(1);
}

/**
 * Parse `--flag value` arguments. `types` maps camelCase names to
 * "string" | "number" | "bool" | "list" (comma-separated) | "multi" (repeatable).
 */
export function parseArgs(argv, types, usage) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") fail(usage);
    if (!arg.startsWith("--")) {
      args._.push(arg);
      continue;
    }
    const name = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const type = types[name];
    if (!type) fail(`Unknown option ${arg}\n\n${usage}`);
    if (type === "bool") {
      args[name] = true;
      continue;
    }
    const value = argv[++i];
    if (value === undefined) fail(`${arg} needs a value\n\n${usage}`);
    if (type === "number") args[name] = Number(value);
    else if (type === "list") args[name] = value.split(",").map((v) => v.trim()).filter(Boolean);
    else if (type === "multi") (args[name] ??= []).push(value);
    else args[name] = value;
  }
  return args;
}

export async function outDir(dir, fallback) {
  const path = dir ?? join(tmpdir(), fallback);
  await mkdir(path, { recursive: true });
  return path;
}

export async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    // ESM import ignores NODE_PATH; CommonJS require honours it, which is how a globally
    // installed Playwright (cloud sessions, global npm installs) is found.
    try {
      return createRequire(join(process.cwd(), "noop.js"))("playwright");
    } catch {
      fail("Playwright is not installed here. Install it (npm i -D playwright && npx playwright install chromium) or run from an environment that has it.");
    }
  }
}

/**
 * Open a page at a viewport width and let it settle. `hide` is a list of selectors
 * (cookie banners, chat bubbles, sticky promos) to remove before anything is measured.
 */
export async function openPage(browser, url, { width = 1440, scale = 2, reducedMotion = false, wait = 1200, hide = [] } = {}) {
  const context = await browser.newContext({
    viewport: { width, height: width < 768 ? 844 : 900 },
    deviceScaleFactor: scale,
    reducedMotion: reducedMotion ? "reduce" : "no-preference",
  });
  const page = await context.newPage();
  const response = await page.goto(url, { waitUntil: "load", timeout: 60000 });
  if (response && response.status() >= 400) console.warn(`${url} answered ${response.status()}`);
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  await page.evaluate(() => document.fonts?.ready);
  if (hide.length) {
    await page.addStyleTag({ content: `${hide.join(", ")} { display: none !important; }` });
  }
  await page.waitForTimeout(wait);
  return { context, page };
}

/**
 * The area a component visibly covers: its own box united with every descendant's
 * (transformed, overflowing cards included), clipped by any element inside it that hides
 * overflow. Viewport coordinates, like boundingBox().
 */
export async function visualBox(locator) {
  return locator.evaluate((root) => {
    const clips = (el) => /(hidden|clip|auto|scroll)/.test(getComputedStyle(el).overflow);
    const intersect = (a, b) => ({ l: Math.max(a.l, b.l), t: Math.max(a.t, b.t), r: Math.min(a.r, b.r), b: Math.min(a.b, b.b) });
    const rect = (el) => {
      const r = el.getBoundingClientRect();
      return { l: r.left, t: r.top, r: r.right, b: r.bottom };
    };
    let box = rect(root);
    if (!clips(root)) {
      for (const el of root.querySelectorAll("*")) {
        let r = rect(el);
        if (r.r - r.l < 1 || r.b - r.t < 1) continue;
        for (let a = el.parentElement; a && a !== root.parentElement; a = a.parentElement) if (clips(a)) r = intersect(r, rect(a));
        if (r.r - r.l < 1 || r.b - r.t < 1) continue;
        box = { l: Math.min(box.l, r.l), t: Math.min(box.t, r.t), r: Math.max(box.r, r.r), b: Math.max(box.b, r.b) };
      }
    }
    return { x: box.l, y: box.t, width: box.r - box.l, height: box.b - box.t };
  });
}

/** Screenshot a component's visible extent plus a margin, so rings, shadows, and lifts aren't cropped. */
export async function shoot(page, locator, path, pad = 24, { scroll = true, animations } = {}) {
  if (scroll) await locator.scrollIntoViewIfNeeded().catch(() => {});
  const box = await visualBox(locator);
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - pad);
  return page.screenshot({ path, animations, clip: { x, y, width: box.width + (box.x - x) + pad, height: box.height + (box.y - y) + pad } });
}

/**
 * Runs in the page: a CSS selector that uniquely identifies `el` on this load. Prefers a
 * stable id; otherwise an nth-of-type path. Passed to page.evaluate as a string so the
 * scripts can share it.
 */
export const SELECTOR_FN = `function selectorFor(el) {
  const parts = [];
  for (let node = el; node && node.nodeType === 1 && node !== document.documentElement; node = node.parentElement) {
    if (node.id && !/\\d{3,}|:/.test(node.id) && document.querySelectorAll('#' + CSS.escape(node.id)).length === 1) {
      parts.unshift('#' + CSS.escape(node.id));
      return parts.join(' > ');
    }
    if (node === document.body) { parts.unshift('body'); break; }
    const tag = node.tagName.toLowerCase();
    const siblings = node.parentElement ? [...node.parentElement.children].filter((s) => s.tagName === node.tagName) : [];
    parts.unshift(siblings.length > 1 ? tag + ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')' : tag);
  }
  return parts.join(' > ');
}`;
