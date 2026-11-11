#!/usr/bin/env node
// Find the element on a page that matches the user's screenshot of a component.
// Seeds come from text visible in the screenshot (--text, repeatable), a page point
// (--at x,y), or a selector. Each seed and up to four ancestors become numbered
// candidates, outlined on an overview screenshot and cropped one by one, so the right
// element can be picked by comparing the crops with the user's screenshot.
//
//   node scripts/locate.mjs <url> --text "Start building" [--text "Free"] [options]
//
//   --text <string>     Text visible in the component (repeatable; all must match).
//   --at <x,y>          A page coordinate inside the component (CSS px at --width).
//   --selector <css>    Use a known selector as the seed.
//   --width <px>        Viewport width (default 1440).
//   --hide <css>        Hide overlays such as cookie banners first (repeatable).
//   --out <dir>         Output directory (default: <os tmpdir>/component-locate).

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SELECTOR_FN, fail, loadPlaywright, openPage, outDir, parseArgs, shoot } from "./lib.mjs";

const USAGE = "Usage: locate.mjs <url> (--text <string>... | --at x,y | --selector css) [--width 1440] [--hide css] [--out dir]";
const args = parseArgs(process.argv.slice(2), { text: "multi", at: "list", selector: "string", width: "number", hide: "multi", out: "string" }, USAGE);
const url = args._[0];
if (!url || (!args.text && !args.at && !args.selector)) fail(USAGE);

const COLORS = ["#ff2d55", "#0a84ff", "#30d158", "#ff9f0a", "#bf5af2", "#64d2ff", "#ffd60a", "#ff375f"];

async function main() {
  const out = await outDir(args.out, "component-locate");
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch();
  try {
    const { page } = await openPage(browser, url, { width: args.width ?? 1440, hide: args.hide ?? [] });

    const candidates = await page.evaluate(
      ({ texts, at, selector, selectorSource }) => {
        const selectorFor = new Function(`return (${selectorSource})`)();
        const norm = (s) => s.replace(/\s+/g, " ").trim().toLowerCase();
        const skip = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "META", "LINK"]);
        const visible = (el) => {
          const r = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          return r.width > 4 && r.height > 4 && s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0;
        };

        let seeds = [];
        if (selector) {
          seeds = [...document.querySelectorAll(selector)].filter(visible);
        } else if (at) {
          const [x, y] = at.map(Number);
          window.scrollTo(0, Math.max(0, y - innerHeight / 2));
          const el = document.elementFromPoint(x, y - scrollY);
          if (el) seeds = [el];
        } else {
          const wanted = texts.map(norm);
          const matches = [...document.body.querySelectorAll("*")].filter(
            (el) => !skip.has(el.tagName) && wanted.every((w) => norm(el.textContent || "").includes(w)),
          );
          const set = new Set(matches);
          seeds = matches.filter((el) => ![...el.children].some((c) => set.has(c))).filter(visible);
        }

        const docArea = document.documentElement.scrollWidth * document.documentElement.scrollHeight;
        const picked = [];
        for (const seed of seeds.slice(0, 6)) {
          let node = seed;
          for (let level = 0; level <= 4 && node && node !== document.body; level++, node = node.parentElement) {
            if (picked.some((p) => p.el === node) || !visible(node)) continue;
            const r = node.getBoundingClientRect();
            if (r.width * r.height > docArea * 0.6) break;
            picked.push({ el: node, level });
          }
        }

        return picked.slice(0, 16).map(({ el, level }, i) => {
          el.setAttribute("data-rx-cand", String(i + 1));
          const r = el.getBoundingClientRect();
          return {
            n: i + 1,
            level: level === 0 ? "match" : `parent ${level}`,
            selector: selectorFor(el),
            tag: el.tagName.toLowerCase(),
            classes: typeof el.className === "string" ? el.className.trim().split(/\s+/).slice(0, 4).join(" ") : "",
            box: { x: Math.round(r.x + scrollX), y: Math.round(r.y + scrollY), w: Math.round(r.width), h: Math.round(r.height) },
            text: (el.innerText || "").replace(/\s+/g, " ").trim().slice(0, 80),
          };
        });
      },
      { texts: args.text ?? [], at: args.at, selector: args.selector, selectorSource: SELECTOR_FN },
    );

    if (candidates.length === 0) {
      console.log("No visible element matched. Try fewer or shorter --text values, --at, or --hide for an overlay.");
      return;
    }

    // Overview: every candidate outlined and numbered on the full page.
    await page.evaluate(
      ({ candidates, colors }) => {
        const layer = document.createElement("div");
        layer.id = "rx-overlay";
        layer.style.cssText = "position:absolute;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none";
        for (const c of candidates) {
          const color = colors[(c.n - 1) % colors.length];
          const box = document.createElement("div");
          box.style.cssText = `position:absolute;left:${c.box.x}px;top:${c.box.y}px;width:${c.box.w}px;height:${c.box.h}px;outline:2px solid ${color};outline-offset:${c.n % 3}px`;
          const label = document.createElement("span");
          label.textContent = String(c.n);
          label.style.cssText = `position:absolute;left:${c.box.y < 22 ? 2 : -2}px;top:${c.box.y < 22 ? 2 : -20}px;padding:1px 6px;font:600 12px/16px system-ui;color:#fff;background:${color};border-radius:4px`;
          box.appendChild(label);
          layer.appendChild(box);
        }
        document.body.appendChild(layer);
      },
      { candidates, colors: COLORS },
    );
    const overview = join(out, "overview.png");
    await page.screenshot({ path: overview, fullPage: true, scale: "css" });
    await page.evaluate(() => document.getElementById("rx-overlay")?.remove());

    for (const c of candidates) {
      c.image = join(out, `candidate-${c.n}.png`);
      await shoot(page, page.locator(`[data-rx-cand="${c.n}"]`), c.image, 12);
    }
    await writeFile(join(out, "candidates.json"), JSON.stringify({ url, width: args.width ?? 1440, candidates }, null, 2));

    for (const c of candidates) {
      console.log(`#${c.n}  ${c.level.padEnd(8)}  ${c.box.w}×${c.box.h} at ${c.box.x},${c.box.y}  ${c.selector}\n     “${c.text}”`);
    }
    console.log(`\n${overview}\n${join(out, "candidates.json")}\n${join(out, "candidate-<n>.png")}`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => fail(error.message));
