#!/usr/bin/env node
// Pixel-compare a rebuilt component with the original.
//
//   node scripts/compare.mjs \
//     --original <url> --original-selector <css> \
//     --rebuild <preview-url> --rebuild-selector <css> \
//     [--widths 1440,390] [--state rest|hover|focus] [--hide css] [--threshold 40] [--out dir]
//
//   --original-image <png>  Compare against a saved shot instead of a live page (e.g. the
//                           element-<width>.png from extract.mjs). Uses the first --widths value.
//   --scale <n>             Device scale of --original-image (default 2, as extract.mjs saves).
//   --state                 rest (default), hover, or focus, applied to both sides.
//   --hide <css>            Hide overlays on the original page (repeatable).
//   --threshold <0-255>     Per-channel difference that counts as a changed pixel (default 40,
//                           which ignores antialiasing noise).
//
// Both shots cover each component's whole visible extent, with animations frozen. Writes compare-<width>-<state>.png
// (original | rebuild | differences in red), diff-<width>-<state>.png, and compare.json.

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fail, loadPlaywright, openPage, outDir, parseArgs, visualBox } from "./lib.mjs";

const USAGE =
  "Usage: compare.mjs (--original <url> --original-selector <css> | --original-image <png>) --rebuild <url> --rebuild-selector <css> [--widths 1440,390] [--state rest|hover|focus] [--hide css] [--threshold 40] [--out dir]";
const args = parseArgs(
  process.argv.slice(2),
  {
    original: "string", originalSelector: "string", originalImage: "string", scale: "number",
    rebuild: "string", rebuildSelector: "string", widths: "list", state: "string", hide: "multi", threshold: "number", out: "string",
  },
  USAGE,
);
if (!args.rebuild || !args.rebuildSelector || !(args.originalImage || (args.original && args.originalSelector))) fail(USAGE);
const state = args.state ?? "rest";
if (!["rest", "hover", "focus"].includes(state)) fail(`--state must be rest, hover, or focus\n\n${USAGE}`);
const widths = (args.widths ?? (args.originalImage ? ["1440"] : ["1440", "390"])).map(Number).slice(0, args.originalImage ? 1 : undefined);
const scale = args.scale ?? 2;

async function elementShot(browser, url, selector, width, hide) {
  const { context, page } = await openPage(browser, url, { width, scale, hide });
  try {
    const loc = page.locator(selector).filter({ visible: true }).first();
    if ((await loc.count()) === 0) throw new Error(`Nothing visible matches ${selector} on ${url} at ${width}px`);
    await loc.scrollIntoViewIfNeeded();
    if (state === "hover") {
      await loc.hover({ force: true });
      await page.waitForTimeout(700);
    } else if (state === "focus") {
      await page.keyboard.press("Shift");
      const inner = loc.locator("a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex='-1'])").first();
      await ((await inner.count()) ? inner : loc).focus();
      await page.waitForTimeout(700);
    }
    // The component's whole visible extent, so overflowing parts are compared too.
    const box = await visualBox(loc);
    return await page.screenshot({ clip: box, animations: "disabled", caret: "hide" });
  } finally {
    await context.close();
  }
}

function inPageDiff({ a, b, threshold }) {
  const load = (src) =>
    new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  const canvas = (w, h) => {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    return c.getContext("2d", { willReadFrequently: true });
  };
  return Promise.all([load(a), load(b)]).then(([ia, ib]) => {
    const w = Math.max(ia.width, ib.width);
    const h = Math.max(ia.height, ib.height);
    const ca = canvas(w, h);
    ca.drawImage(ia, 0, 0);
    const cb = canvas(w, h);
    cb.drawImage(ib, 0, 0);
    const da = ca.getImageData(0, 0, w, h).data;
    const db = cb.getImageData(0, 0, w, h).data;
    const out = canvas(w, h);
    const od = out.createImageData(w, h);
    let changed = 0;
    for (let i = 0; i < da.length; i += 4) {
      const p = i / 4;
      const x = p % w;
      const y = (p / w) | 0;
      const both = x < ia.width && y < ia.height && x < ib.width && y < ib.height;
      const delta = both
        ? Math.max(Math.abs(da[i] - db[i]), Math.abs(da[i + 1] - db[i + 1]), Math.abs(da[i + 2] - db[i + 2]), Math.abs(da[i + 3] - db[i + 3]))
        : 255;
      if (delta > threshold) {
        changed++;
        od.data.set([255, 0, 60, 255], i);
      } else {
        const g = 255 - (255 - (da[i] * 0.3 + da[i + 1] * 0.59 + da[i + 2] * 0.11)) * 0.25;
        od.data.set([g, g, g, 255], i);
      }
    }
    out.putImageData(od, 0, 0);
    const gap = 24;
    const sbs = canvas(w * 3 + gap * 2, h);
    sbs.fillStyle = "#7f7f7f";
    sbs.fillRect(0, 0, sbs.canvas.width, h);
    sbs.drawImage(ia, 0, 0);
    sbs.drawImage(ib, w + gap, 0);
    sbs.drawImage(out.canvas, (w + gap) * 2, 0);
    return {
      original: [ia.width, ia.height],
      rebuild: [ib.width, ib.height],
      mismatch: changed / (w * h),
      diff: out.canvas.toDataURL("image/png"),
      sideBySide: sbs.canvas.toDataURL("image/png"),
    };
  });
}

const dataUrl = (buffer) => `data:image/png;base64,${buffer.toString("base64")}`;
const fromDataUrl = (url) => Buffer.from(url.split(",")[1], "base64");

async function main() {
  const out = await outDir(args.out, "component-compare");
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch();
  const results = [];
  try {
    const scratch = await (await browser.newContext()).newPage();
    for (const width of widths) {
      const original = args.originalImage
        ? await readFile(args.originalImage)
        : await elementShot(browser, args.original, args.originalSelector, width, args.hide ?? []);
      const rebuild = await elementShot(browser, args.rebuild, args.rebuildSelector, width, []);
      const r = await scratch.evaluate(inPageDiff, { a: dataUrl(original), b: dataUrl(rebuild), threshold: args.threshold ?? 40 });
      const tag = `${width}-${state}`;
      const sideBySide = join(out, `compare-${tag}.png`);
      const diff = join(out, `diff-${tag}.png`);
      await writeFile(sideBySide, fromDataUrl(r.sideBySide));
      await writeFile(diff, fromDataUrl(r.diff));
      const css = ([w, h]) => `${Math.round(w / scale)}×${Math.round(h / scale)}`;
      const result = {
        width,
        state,
        originalSize: css(r.original),
        rebuildSize: css(r.rebuild),
        sizeMatches: Math.abs(r.original[0] - r.rebuild[0]) <= scale && Math.abs(r.original[1] - r.rebuild[1]) <= scale,
        mismatchPercent: Number((r.mismatch * 100).toFixed(2)),
        sideBySide,
        diff,
      };
      results.push(result);
      console.log(
        `${width}px ${state}: ${result.mismatchPercent}% of pixels differ · original ${result.originalSize} vs rebuild ${result.rebuildSize}${result.sizeMatches ? "" : "  ← sizes differ"}\n  ${sideBySide}`,
      );
    }
  } finally {
    await browser.close();
  }
  await writeFile(join(out, "compare.json"), JSON.stringify(results, null, 2));
}

main().catch((error) => fail(error.message));
