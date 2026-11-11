#!/usr/bin/env node
// Extract everything needed to rebuild one component faithfully from a live page.
//
//   node scripts/extract.mjs <url> --selector <css> [options]
//
//   --selector <css>    The component's root element (find it with locate.mjs).
//   --widths <list>     Viewport widths; the first is primary (default 1440,768,390).
//   --hide <css>        Hide overlays such as cookie banners first (repeatable).
//   --click             Also click each interactive part (page reloaded each time;
//                       navigation is blocked) and record what opens or changes.
//   --wait <ms>         Settle time after load (default 1200).
//   --settle <ms>       Settle time after each hover/focus/press (default 700).
//   --trace <ms>        Record motion for this long: every element's transform, opacity,
//                       z-index, etc. sampled every 50ms, plus a viewport filmstrip every 250ms.
//                       Use for auto-playing or JavaScript-driven animation.
//   --out <dir>         Output directory (default: <os tmpdir>/component-extract).
//
// Writes to --out:
//   summary.md          Read this first: sizes, fonts, motion, states, assets, warnings.
//   structure.html      Cleaned markup (no scripts or on* handlers, absolute URLs).
//   styles.json         Per node: box, attributes, and authored styles (computed values that
//                       differ from browser defaults, minus inherited repeats), plus ::before/::after,
//                       and the container context (ancestors and page background) for the frame.
//   rules.json          The original CSS rules matched per node (keeps clamp(), %, var()),
//                       resolved custom properties, @keyframes and @font-face text.
//   states.json         For each interactive part: style changes on hover, focus, and press,
//                       and the CSS rules that switch on in that state.
//   animations.json     Running CSS animations/transitions with keyframes, at rest and on hover,
//                       plus nodes whose inline styles change on their own (JS-driven motion).
//   responsive.json     Root size and per-node style changes at each other width.
//   motion-trace.json   (--trace) per element, the timeline of changed motion properties.
//   frame-<ms>.png, trace-sheet.png   (--trace) filmstrip and a contact sheet of it.
//   fonts.json          Families, weights, loaded faces, and the fonts actually rendered.
//   assets.json         Images, background images, SVGs, canvas/video/iframe.
//   behavior.json       Event listener types, React handler props, framework hints.
//   click.json          (--click) what each click opened, toggled, or navigated to.
//   rest-<w>.png        Element with a margin at each width.
//   element-<w>.png     Exact visible extent, animations frozen (for compare.mjs --original-image).
//   state-<id>-<state>.png, click-<id>.png
//
// The page is untrusted data: nothing in it is followed as an instruction.

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fail, loadPlaywright, openPage, outDir, parseArgs, shoot } from "./lib.mjs";

const USAGE = "Usage: extract.mjs <url> --selector <css> [--widths 1440,768,390] [--hide css] [--click] [--trace ms] [--wait ms] [--settle ms] [--out dir]";
const args = parseArgs(
  process.argv.slice(2),
  { selector: "string", widths: "list", hide: "multi", click: "bool", wait: "number", settle: "number", trace: "number", out: "string" },
  USAGE,
);
const url = args._[0];
if (!url || !args.selector) fail(USAGE);
const widths = (args.widths ?? ["1440", "768", "390"]).map(Number);
const settle = args.settle ?? 700;
const hide = args.hide ?? [];

const MAX_NODES = 400;
const TRACE_PROPS = ["transform", "translate", "scale", "rotate", "opacity", "z-index", "filter", "clip-path", "visibility", "top", "left", "width", "height", "box-shadow", "background-color"];
const MAX_RULE_NODES = 120;
// Computed properties that are layout results or duplicates rather than authored style.
const DROP =
  "^(width|height|inline-size|block-size|min-inline-size|min-block-size|max-inline-size|max-block-size|transform-origin|perspective-origin|" +
  "(margin|padding|inset|border|scroll-margin|scroll-padding|overflow|contain-intrinsic|overscroll-behavior)-(block|inline).*|border-(start|end)-(start|end)-radius|" +
  "-webkit-(?!backdrop-filter|text-stroke|line-clamp|box-orient|mask|background-clip|font-smoothing).*|d|r|rx|ry|cx|cy|x|y)$";
const INHERITED = [
  "color", "font-family", "font-size", "font-style", "font-weight", "font-stretch", "font-variant", "font-variant-ligatures",
  "font-variant-numeric", "font-variant-caps", "font-feature-settings", "font-variation-settings", "font-kerning",
  "font-optical-sizing", "font-synthesis", "font-size-adjust", "font-palette", "line-height", "letter-spacing", "word-spacing",
  "text-align", "text-align-last", "text-indent", "text-transform", "text-shadow", "text-rendering", "text-wrap", "text-wrap-mode",
  "text-wrap-style", "white-space", "white-space-collapse", "word-break", "overflow-wrap", "line-break", "hyphens", "direction",
  "writing-mode", "visibility", "cursor", "pointer-events", "user-select", "list-style-type", "list-style-position",
  "list-style-image", "quotes", "tab-size", "caret-color", "accent-color", "color-scheme", "border-collapse", "border-spacing",
  "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-opacity", "stroke-linecap", "stroke-linejoin",
  "stroke-dasharray", "stroke-dashoffset", "stroke-miterlimit", "paint-order", "text-anchor", "dominant-baseline",
  "shape-rendering", "image-rendering", "text-decoration-skip-ink", "text-underline-position", "text-emphasis-color",
  "text-emphasis-position", "text-emphasis-style", "text-size-adjust", "math-depth", "print-color-adjust", "forced-color-adjust",
  "orphans", "widows", "empty-cells", "caption-side", "ruby-position", "hyphenate-character",
];

// ---- functions that run inside the page (no access to this module's scope) ----

function inPageSnapshot({ selector, inherited, drop, maxNodes, withHtml }) {
  const root = document.querySelector(selector);
  if (!root) return { error: `No element matches ${selector}` };
  const dropRe = new RegExp(drop);
  const inheritedSet = new Set(inherited);
  const skip = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);
  const all = [root, ...root.querySelectorAll("*")].filter((n) => !skip.has(n.tagName));
  const nodes = all.slice(0, maxNodes);
  nodes.forEach((n, i) => n.setAttribute("data-rx-id", String(i)));
  const index = new Map(nodes.map((n, i) => [n, i]));

  const full = (cs) => {
    const out = {};
    for (const p of cs) if (!dropRe.test(p)) out[p] = cs.getPropertyValue(p);
    return out;
  };
  const maps = nodes.map((n) => full(getComputedStyle(n)));
  const pseudo = nodes.map((n) => {
    const found = {};
    for (const p of ["::before", "::after"]) {
      const cs = getComputedStyle(n, p);
      const content = cs.getPropertyValue("content");
      if (content && content !== "none" && content !== "normal") found[p] = full(cs);
    }
    return found;
  });
  window.__rx = { nodes, maps, pseudo, drop };

  // Browser defaults per tag, from a blank same-origin iframe.
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText = "position:absolute;left:-9999px;top:0;width:10px;height:10px;border:0;visibility:hidden";
  document.body.appendChild(frame);
  const bdoc = frame.contentDocument;
  const SVG = "http://www.w3.org/2000/svg";
  const cache = {};
  const baseline = (ns, name) => {
    const key = `${ns === SVG ? "svg:" : ""}${name}`;
    if (!cache[key]) {
      let el;
      if (ns === SVG) {
        const svg = bdoc.body.appendChild(bdoc.createElementNS(SVG, "svg"));
        el = name === "svg" ? svg : svg.appendChild(bdoc.createElementNS(SVG, name));
      } else {
        el = bdoc.body.appendChild(bdoc.createElement(name));
      }
      cache[key] = full(frame.contentWindow.getComputedStyle(el));
    }
    return cache[key];
  };
  const authored = (map, base, parentMap) => {
    const out = {};
    for (const [p, v] of Object.entries(map)) {
      if (v === base[p]) continue;
      if (parentMap && (inheritedSet.has(p) || p.startsWith("--")) && v === parentMap[p]) continue;
      if ((p === "min-width" || p === "min-height") && v === "auto") continue;
      if (["top", "right", "bottom", "left"].includes(p) && (map.position === "static" || (map.position === "relative" && v === "0px"))) continue;
      if (p !== "color" && p !== "background-color" && p.includes("color") && v === map.color) continue;
      out[p] = v;
    }
    return out;
  };

  const rootBox = root.getBoundingClientRect();
  const relPath = (n) => {
    const parts = [];
    for (let x = n; x && x !== root; x = x.parentElement) {
      const same = [...x.parentElement.children].filter((s) => s.tagName === x.tagName);
      parts.unshift(x.localName + (same.length > 1 ? `:nth-of-type(${same.indexOf(x) + 1})` : ""));
    }
    return parts.length ? `:scope > ${parts.join(" > ")}` : ":scope";
  };
  const ownText = (n) =>
    [...n.childNodes].filter((c) => c.nodeType === 3).map((c) => c.textContent).join(" ").replace(/\s+/g, " ").trim().slice(0, 80);
  const keepAttr = /^(role|aria-.*|href|type|alt|title|name|placeholder|tabindex|src|for|viewbox|width|height|loading|target)$/i;

  const records = nodes.map((n, i) => {
    const parent = index.get(n.parentElement);
    const r = n.getBoundingClientRect();
    const rec = {
      id: i,
      parent: parent ?? null,
      tag: n.localName,
      path: relPath(n),
      classes: typeof n.className === "string" && n.className.trim() ? n.className.trim() : undefined,
      text: ownText(n) || undefined,
      attrs: Object.fromEntries([...n.attributes].filter((a) => keepAttr.test(a.name)).map((a) => [a.name, a.value.slice(0, 200)])),
      box: { x: Math.round(r.x - rootBox.x), y: Math.round(r.y - rootBox.y), w: Math.round(r.width), h: Math.round(r.height) },
      style: authored(maps[i], baseline(n.namespaceURI, n.localName), parent === undefined ? null : maps[parent]),
    };
    for (const [p, m] of Object.entries(pseudo[i])) rec[p] = authored(m, baseline(null, "span"), maps[i]);
    if (!Object.keys(rec.attrs).length) delete rec.attrs;
    return rec;
  });
  frame.remove();

  let html;
  if (withHtml) {
    const clone = root.cloneNode(true);
    clone.querySelectorAll("script, noscript").forEach((n) => n.remove());
    for (const el of [clone, ...clone.querySelectorAll("*")]) {
      for (const a of [...el.attributes]) {
        if (a.name.startsWith("on") || a.name === "data-rx-id") el.removeAttribute(a.name);
        else if (["src", "href", "poster", "xlink:href"].includes(a.name) && a.value && !a.value.startsWith("#") && !a.value.startsWith("data:")) {
          try { el.setAttribute(a.name, new URL(a.value, location.href).href); } catch { /* keep as is */ }
        } else if (a.name === "srcset") {
          el.setAttribute("srcset", a.value.split(",").map((part) => {
            const [u, d] = part.trim().split(/\s+/);
            try { return `${new URL(u, location.href).href}${d ? ` ${d}` : ""}`; } catch { return part; }
          }).join(", "));
        }
      }
    }
    html = clone.outerHTML;
  }

  const contextKeys = ["display", "position", "width", "max-width", "padding", "background-color", "background-image", "justify-content", "align-items", "justify-items", "grid-template-columns", "gap", "overflow", "perspective", "font-family", "color"];
  const context = [];
  for (let a = root.parentElement, depth = 0; a && depth < 4; a = a.parentElement, depth++) {
    const cs = getComputedStyle(a);
    const r = a.getBoundingClientRect();
    context.push({
      tag: a.localName,
      classes: typeof a.className === "string" && a.className.trim() ? a.className.trim().slice(0, 120) : undefined,
      box: { w: Math.round(r.width), h: Math.round(r.height) },
      style: Object.fromEntries(contextKeys.map((k) => [k, cs.getPropertyValue(k)]).filter(([, v]) => v && v !== "none" && v !== "normal" && v !== "0px" && v !== "rgba(0, 0, 0, 0)")),
    });
  }
  const pageBackground = { body: getComputedStyle(document.body).backgroundColor, html: getComputedStyle(document.documentElement).backgroundColor };

  return {
    context,
    pageBackground,
    count: all.length,
    truncated: all.length > maxNodes,
    rootBox: { x: Math.round(rootBox.x + scrollX), y: Math.round(rootBox.y + scrollY), w: Math.round(rootBox.width), h: Math.round(rootBox.height) },
    records,
    maps,
    html,
  };
}

function inPageDiff() {
  const rx = window.__rx;
  const dropRe = new RegExp(rx.drop);
  const changes = {};
  rx.nodes.forEach((n, i) => {
    const now = getComputedStyle(n);
    const before = rx.maps[i];
    const d = {};
    for (const p of now) {
      if (dropRe.test(p)) continue;
      const v = now.getPropertyValue(p);
      if (v !== before[p]) d[p] = [before[p], v];
    }
    for (const ps of ["::before", "::after"]) {
      const cs = getComputedStyle(n, ps);
      const content = cs.getPropertyValue("content");
      const was = rx.pseudo[i][ps];
      const present = content && content !== "none" && content !== "normal";
      if (present && !was) {
        d[ps] = { appeared: Object.fromEntries(["content", "position", "inset", "width", "height", "background", "border-radius", "opacity", "transform"].map((p) => [p, cs.getPropertyValue(p)])) };
      } else if (was) {
        const pd = {};
        for (const p of cs) {
          if (dropRe.test(p)) continue;
          const v = cs.getPropertyValue(p);
          if (v !== was[p]) pd[p] = [was[p], v];
        }
        if (Object.keys(pd).length) d[ps] = pd;
      }
    }
    if (Object.keys(d).length) changes[i] = d;
  });
  return changes;
}

function inPageTargets({ max }) {
  const { nodes } = window.__rx;
  const root = nodes[0];
  const focusable = (n) => n.matches("a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex='-1']), [contenteditable='true']");
  const roleish = (n) => focusable(n) || n.matches("[role=button], [role=tab], [role=link], [role=switch], [role=checkbox], [role=menuitem], [role=option], label");
  const pointerStart = (n) => getComputedStyle(n).cursor === "pointer" && (!n.parentElement || getComputedStyle(n.parentElement).cursor !== "pointer");
  const picks = [];
  nodes.forEach((n, i) => {
    if (i === 0 || !(roleish(n) || pointerStart(n))) return;
    const r = n.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    for (let a = n.parentElement; a && a !== root; a = a.parentElement) if (picks.some((p) => nodes[p] === a)) return;
    picks.push(i);
  });
  const ids = [0, ...picks.slice(0, max - 1)];
  return ids.map((id) => ({
    id,
    tag: nodes[id].localName,
    text: (nodes[id].innerText || nodes[id].getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 60),
    focusable: focusable(nodes[id]),
    interactive: roleish(nodes[id]) || getComputedStyle(nodes[id]).cursor === "pointer",
  }));
}

function inPageAnimations() {
  const root = window.__rx.nodes[0];
  return document
    .getAnimations()
    .filter((a) => a.effect && a.effect.target && (a.effect.target === root || root.contains(a.effect.target)))
    .map((a) => {
      const t = a.effect.getTiming();
      return {
        type: a.constructor.name,
        name: a.animationName || a.transitionProperty || a.id || "",
        target: Number(a.effect.target.getAttribute("data-rx-id")),
        pseudo: a.effect.pseudoElement || null,
        duration: t.duration,
        delay: t.delay,
        iterations: t.iterations === Infinity ? "infinite" : t.iterations,
        easing: t.easing,
        direction: t.direction,
        fill: t.fill,
        keyframes: a.effect.getKeyframes().map((k) => {
          const copy = { ...k };
          delete copy.computedOffset;
          return copy;
        }),
      };
    });
}

function inPageInlineStyles() {
  return window.__rx.nodes.map((n) => `${n.getAttribute("style") || ""}|${n.getAttribute("transform") || ""}`);
}

function inPageAssets() {
  const { nodes, maps } = window.__rx;
  const size = (n) => {
    const r = n.getBoundingClientRect();
    return `${Math.round(r.width)}×${Math.round(r.height)}`;
  };
  const out = { images: [], backgrounds: [], svgs: [], media: [] };
  nodes.forEach((n, i) => {
    if (n.localName === "img") out.images.push({ id: i, src: n.currentSrc || n.src, alt: n.alt, natural: `${n.naturalWidth}×${n.naturalHeight}`, rendered: size(n) });
    const bg = maps[i]["background-image"];
    if (bg && bg.includes("url(")) out.backgrounds.push({ id: i, value: bg.slice(0, 400) });
    if (n.localName === "svg") out.svgs.push({ id: i, viewBox: n.getAttribute("viewBox"), rendered: size(n), shapes: n.querySelectorAll("path, circle, rect, line, polyline, polygon, ellipse").length });
    if (["video", "canvas", "iframe", "audio", "object", "embed"].includes(n.localName)) out.media.push({ id: i, tag: n.localName, src: n.currentSrc || n.src || null, rendered: size(n) });
    if (n.shadowRoot) out.media.push({ id: i, tag: n.localName, note: "open shadow root: its contents are not extracted" });
  });
  return out;
}

function inPageHandlers() {
  const { nodes } = window.__rx;
  const reactHandlers = {};
  nodes.forEach((n, i) => {
    const key = Object.keys(n).find((k) => k.startsWith("__reactProps$"));
    const handlers = key ? Object.keys(n[key] || {}).filter((k) => /^on[A-Z]/.test(k)) : [];
    if (handlers.length) reactHandlers[i] = handlers;
  });
  const frameworks = [];
  if (nodes.some((n) => Object.keys(n).some((k) => k.startsWith("__reactFiber$")))) frameworks.push("React");
  if (window.__NEXT_DATA__ || window.next || document.getElementById("__next")) frameworks.push("Next.js");
  if (nodes.some((n) => n.__vueParentComponent || n.__vue__)) frameworks.push("Vue");
  if (window.gsap || window.TweenMax) frameworks.push("GSAP");
  if (document.querySelector("[data-framer-name], [data-framer-component-type]")) frameworks.push("Framer");
  if (document.documentElement.hasAttribute("data-wf-site")) frameworks.push("Webflow");
  return { reactHandlers, frameworks };
}

function inPageVariables(names) {
  const root = window.__rx.nodes[0];
  const cs = getComputedStyle(root);
  return Object.fromEntries(names.map((name) => [name, cs.getPropertyValue(name).trim()]));
}

function inPageTrace({ duration, props, interval }) {
  const { nodes } = window.__rx;
  const read = (n) => {
    const cs = getComputedStyle(n);
    const out = {};
    for (const p of props) out[p] = cs.getPropertyValue(p);
    out.style = n.getAttribute("style") || "";
    return out;
  };
  const initial = nodes.map(read);
  const last = initial.map((v) => ({ ...v }));
  const changes = nodes.map(() => []);
  const start = performance.now();
  let samples = 0;
  return new Promise((resolve) => {
    const tick = () => {
      const t = Math.round(performance.now() - start);
      samples++;
      nodes.forEach((n, i) => {
        const now = read(n);
        const diff = {};
        for (const [p, v] of Object.entries(now)) if (v !== last[i][p]) diff[p] = v;
        if (Object.keys(diff).length) {
          changes[i].push([t, diff]);
          Object.assign(last[i], diff);
        }
      });
      if (t < duration) setTimeout(tick, interval);
      else {
        const moved = {};
        changes.forEach((list, i) => {
          if (!list.length) return;
          const touched = new Set(list.flatMap(([, d]) => Object.keys(d)));
          moved[i] = { initial: Object.fromEntries([...touched].map((p) => [p, initial[i][p]])), changes: list };
        });
        resolve({ duration, interval, samples, nodes: moved });
      }
    };
    tick();
  });
}

/** Lay filmstrip frames out on one image with their timestamps. */
async function contactSheet(browser, frames, path) {
  if (!frames.length) return;
  const images = await Promise.all(frames.map(async (f) => ({ at: f.at, src: `data:image/png;base64,${(await readFile(f.path)).toString("base64")}` })));
  const context = await browser.newContext();
  const page = await context.newPage();
  const dataUrl = await page.evaluate(async (list) => {
    const loaded = await Promise.all(list.map((f) => new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ img, at: f.at });
      img.src = f.src;
    })));
    const cols = 4;
    const scale = Math.min(1, 480 / loaded[0].img.width);
    const w = Math.round(loaded[0].img.width * scale);
    const h = Math.round(loaded[0].img.height * scale);
    const c = document.createElement("canvas");
    c.width = cols * (w + 8) + 8;
    c.height = Math.ceil(loaded.length / cols) * (h + 30) + 8;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#7f7f7f";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.font = "600 14px system-ui";
    loaded.forEach(({ img, at }, i) => {
      const x = 8 + (i % cols) * (w + 8);
      const y = 8 + Math.floor(i / cols) * (h + 30);
      ctx.fillStyle = "#fff";
      ctx.fillText(`${at} ms`, x, y + 15);
      ctx.drawImage(img, x, y + 22, w, h);
    });
    return c.toDataURL("image/png");
  }, images);
  await writeFile(path, Buffer.from(dataUrl.split(",")[1], "base64"));
  await context.close();
}

// ---- Chrome DevTools Protocol helpers ----

async function devtools(page) {
  const cdp = await page.context().newCDPSession(page);
  const sheets = [];
  cdp.on("CSS.styleSheetAdded", ({ header }) => sheets.push(header));
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");
  const { root } = await cdp.send("DOM.getDocument", { depth: 0 });
  const ids = new Map();
  const nodeId = async (id) => {
    if (!ids.has(id)) {
      const { nodeId: found } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: `[data-rx-id="${id}"]` });
      ids.set(id, found);
    }
    return ids.get(id);
  };
  return { cdp, sheets, nodeId };
}

const inheritedSet = new Set(INHERITED);

async function matchedRules({ cdp, nodeId }, ids, store, { includeInherited = false } = {}) {
  const perNode = {};
  for (const id of ids) {
    const nid = await nodeId(id).catch(() => 0);
    if (!nid) continue;
    let res;
    try {
      res = await cdp.send("CSS.getMatchedStylesForNode", { nodeId: nid });
    } catch {
      continue;
    }
    const keys = [];
    const add = (rule, extra = {}, onlyInherited = false) => {
      if (rule.origin !== "regular") return;
      const declarations = Object.fromEntries(
        rule.style.cssProperties
          .filter((p) => p.text && !p.disabled && p.parsedOk !== false && (!onlyInherited || inheritedSet.has(p.name) || p.name.startsWith("--")))
          .map((p) => [p.name, `${p.value}${p.important ? " !important" : ""}`]),
      );
      if (!Object.keys(declarations).length) return;
      const range = rule.style.range;
      const key = `${range ? `${rule.styleSheetId}:${range.startLine}:${range.startColumn}` : `${rule.selectorList.text}|${JSON.stringify(declarations)}`}${onlyInherited ? "|inherited" : ""}`;
      if (!store[key]) {
        const media = (rule.media || []).map((m) => m.text).join(" and ");
        store[key] = { selector: rule.selectorList.text, ...(media ? { media } : {}), ...extra, declarations };
      }
      keys.push(key);
    };
    for (const m of res.matchedCSSRules ?? []) add(m.rule);
    for (const pe of res.pseudoElements ?? []) for (const m of pe.matches) add(m.rule, { pseudo: pe.pseudoType });
    if (includeInherited) for (const entry of res.inherited ?? []) for (const m of entry.matchedCSSRules ?? []) add(m.rule, { inherited: true }, true);
    const inline = (res.inlineStyle?.cssProperties ?? []).filter((p) => p.text).map((p) => [p.name, p.value]);
    perNode[id] = { rules: [...new Set(keys)], ...(inline.length ? { inline: Object.fromEntries(inline) } : {}) };
  }
  return perNode;
}

function blockAfter(text, re) {
  const m = re.exec(text);
  if (!m) return null;
  let depth = 0;
  for (let i = m.index + m[0].length - 1; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(m.index, i + 1);
  }
  return null;
}
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function sheetExtras({ cdp, sheets }, animationNames, families) {
  const keyframes = {};
  const fontFaces = [];
  const wanted = families.map((f) => f.toLowerCase());
  for (const header of sheets) {
    if (header.origin !== "regular") continue;
    let text;
    try {
      ({ text } = await cdp.send("CSS.getStyleSheetText", { styleSheetId: header.styleSheetId }));
    } catch {
      continue;
    }
    for (const name of animationNames) {
      if (keyframes[name]) continue;
      const block = blockAfter(text, new RegExp(`@(?:-webkit-)?keyframes\\s+${escapeRe(name)}\\s*\\{`));
      if (block) keyframes[name] = block;
    }
    for (const m of text.matchAll(/@font-face\s*\{[^}]*\}/g)) {
      const family = /font-family\s*:\s*["']?([^;"']+)/.exec(m[0])?.[1]?.trim();
      if (family && wanted.includes(family.toLowerCase())) {
        fontFaces.push({ family, rule: m[0].replace(/\s+/g, " ").slice(0, 800), stylesheet: header.sourceURL || "inline <style>" });
      }
    }
  }
  return { keyframes, fontFaces };
}

async function listenerTypes(cdp, expression) {
  const { result } = await cdp.send("Runtime.evaluate", { expression, objectGroup: "rx" });
  if (!result.objectId) return [];
  const { listeners } = await cdp.send("DOMDebugger.getEventListeners", { objectId: result.objectId });
  return [...new Set(listeners.map((l) => l.type))];
}

const countChanges = (changes) => Object.values(changes).reduce((sum, d) => sum + Object.keys(d).length, 0);
const firstFamily = (value) => (value || "").split(",")[0].replace(/["']/g, "").trim();

// ---- main ----

async function main() {
  const out = await outDir(args.out, "component-extract");
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch();
  const warnings = [];
  const files = [];
  const save = async (name, data) => {
    const path = join(out, name);
    await writeFile(path, typeof data === "string" ? data : JSON.stringify(data, null, 2));
    files.push(path);
  };

  try {
    // Primary width: structure, styles, rules, states, motion, fonts, assets, behavior.
    const { page } = await openPage(browser, url, { width: widths[0], hide, wait: args.wait });
    const snapshotArgs = { selector: args.selector, inherited: INHERITED, drop: DROP, maxNodes: MAX_NODES };
    const snap = await page.evaluate(inPageSnapshot, { ...snapshotArgs, withHtml: true });
    if (snap.error) fail(snap.error);
    if (snap.truncated) warnings.push(`The component has ${snap.count} elements; only the first ${MAX_NODES} were measured. Consider extracting sub-parts separately.`);
    const rootLoc = page.locator('[data-rx-id="0"]');

    await save("structure.html", snap.html);
    await save("styles.json", { url, selector: args.selector, width: widths[0], rootBox: snap.rootBox, pageBackground: snap.pageBackground, context: snap.context, nodes: snap.records });
    const restShot = join(out, `rest-${widths[0]}.png`);
    await shoot(page, rootLoc, restShot);
    files.push(restShot);

    const dev = await devtools(page);
    const ruleStore = {};
    const ruleIds = snap.records.slice(1, MAX_RULE_NODES).map((r) => r.id);
    const restRules = {
      ...(await matchedRules(dev, [0], ruleStore, { includeInherited: true })),
      ...(await matchedRules(dev, ruleIds, ruleStore)),
    };

    // Motion at rest, plus JS-driven inline-style changes over 800ms.
    const animations = await page.evaluate(inPageAnimations);
    const inlineBefore = await page.evaluate(inPageInlineStyles);
    await page.waitForTimeout(800);
    const inlineAfter = await page.evaluate(inPageInlineStyles);
    const jsMotion = inlineBefore.map((v, i) => (v !== inlineAfter[i] ? i : -1)).filter((i) => i >= 0);

    // Motion trace: sample every element while the component plays, plus a filmstrip.
    let trace = null;
    if (args.trace) {
      await rootLoc.evaluate((n) => n.scrollIntoView({ block: "center" }));
      await page.waitForTimeout(300);
      const tracing = page.evaluate(inPageTrace, { duration: args.trace, props: TRACE_PROPS, interval: 50 });
      const frames = [];
      const started = Date.now();
      while (Date.now() - started < args.trace) {
        const at = Date.now() - started;
        const path = join(out, `frame-${String(at).padStart(5, "0")}.png`);
        await page.screenshot({ path, scale: "css" });
        frames.push({ at, path });
        await page.waitForTimeout(Math.max(0, 250 - ((Date.now() - started) % 250)));
      }
      trace = await tracing;
      await save("motion-trace.json", trace);
      const sheet = join(out, "trace-sheet.png");
      await contactSheet(browser, frames, sheet);
      files.push(...frames.map((f) => f.path), sheet);
    }

    // Exact element shot (no margin, animations frozen) for compare.mjs --original-image.
    const elementShot = join(out, `element-${widths[0]}.png`);
    await shoot(page, rootLoc, elementShot, 0, { animations: "disabled" });
    files.push(elementShot);

    // States per interactive part.
    const targets = await page.evaluate(inPageTargets, { max: 8 });
    const states = [];
    for (const target of targets) {
      const loc = page.locator(`[data-rx-id="${target.id}"]`);
      const entry = { ...target, hover: null, focus: null, active: null };
      const ids = [target.id];
      for (const r of snap.records) if (r.parent !== null && ids.includes(r.parent)) ids.push(r.id);
      ids.length = Math.min(ids.length, 40);

      const capture = async (state) => {
        await page.waitForTimeout(settle);
        const changes = await page.evaluate(inPageDiff);
        const image = join(out, `state-${target.id}-${state}.png`);
        await shoot(page, rootLoc, image, 24, { scroll: false });
        files.push(image);
        const during = await matchedRules(dev, ids, ruleStore);
        const newRules = [...new Set(Object.entries(during).flatMap(([id, v]) => v.rules.filter((k) => !restRules[id]?.rules.includes(k))))];
        return { changed: countChanges(changes), changes, rulesSwitchedOn: newRules.map((k) => ruleStore[k]), image };
      };

      await loc.hover({ force: true, timeout: 5000 }).catch(() => warnings.push(`Could not hover #${target.id}.`));
      if (target.id === 0) {
        await page.waitForTimeout(60);
        animations.push(...(await page.evaluate(inPageAnimations)).map((a) => ({ ...a, during: "hover" })));
      }
      entry.hover = await capture("hover");
      await page.mouse.move(1, 1);
      await page.waitForTimeout(settle);

      if (target.focusable) {
        await page.keyboard.press("Shift");
        await loc.focus().catch(() => {});
        entry.focus = await capture("focus");
        await loc.evaluate((n) => n.blur()).catch(() => {});
        await page.waitForTimeout(settle);
      }

      if (target.interactive) {
        const nid = await dev.nodeId(target.id);
        await dev.cdp.send("CSS.forcePseudoState", { nodeId: nid, forcedPseudoClasses: ["hover", "active"] });
        entry.active = await capture("active");
        await dev.cdp.send("CSS.forcePseudoState", { nodeId: nid, forcedPseudoClasses: [] });
        await page.waitForTimeout(settle);
      }
      states.push(entry);
    }
    await save("states.json", states);

    // Animations, de-duplicated across rest and hover.
    const seen = new Set();
    const uniqueAnimations = animations.filter((a) => {
      const key = `${a.type}|${a.name}|${a.target}|${a.pseudo}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    await save("animations.json", { animations: uniqueAnimations, jsDrivenInlineStyleNodes: jsMotion });
    if (jsMotion.length) warnings.push(`Inline styles change on their own on nodes ${jsMotion.slice(0, 10).join(", ")}: motion is JavaScript-driven (requestAnimationFrame/GSAP/Framer). Record it with screenshots and rebuild the timing by observation.`);

    // Fonts.
    const textIds = snap.records.filter((r) => r.text).map((r) => r.id);
    const families = [...new Set(snap.maps.map((m) => firstFamily(m["font-family"])).filter(Boolean))];
    const rendered = {};
    for (const id of textIds.slice(0, 15)) {
      try {
        const { fonts } = await dev.cdp.send("CSS.getPlatformFontsForNode", { nodeId: await dev.nodeId(id) });
        for (const f of fonts) rendered[f.familyName] = { custom: f.isCustomFont, glyphs: (rendered[f.familyName]?.glyphs ?? 0) + f.glyphCount };
      } catch {
        /* node without text layout */
      }
    }
    const loadedFaces = await page.evaluate((fams) => {
      const wanted = fams.map((f) => f.toLowerCase());
      return [...document.fonts].filter((f) => f.status === "loaded" && wanted.includes(f.family.replace(/["']/g, "").toLowerCase())).map((f) => ({ family: f.family.replace(/["']/g, ""), weight: f.weight, style: f.style }));
    }, families);
    const usage = {};
    for (const id of textIds) {
      const m = snap.maps[id];
      const key = `${firstFamily(m["font-family"])} ${m["font-weight"]}`;
      (usage[key] ??= new Set()).add(`${m["font-size"]}/${m["line-height"]}`);
    }

    // Keyframes and @font-face text, custom properties used by matched rules.
    const animationNames = [...new Set([
      ...snap.maps.flatMap((m) => (m["animation-name"] || "none").split(",").map((s) => s.trim())),
      ...uniqueAnimations.filter((a) => a.type === "CSSAnimation").map((a) => a.name),
      ...states.flatMap((s) => [s.hover, s.focus, s.active].filter(Boolean).flatMap((st) => Object.values(st.changes).map((d) => d["animation-name"]?.[1]))),
    ].filter((n) => n && n !== "none"))];
    const extras = await sheetExtras(dev, animationNames, families);
    const varNames = [...new Set(JSON.stringify(ruleStore).match(/var\(\s*(--[\w-]+)/g)?.map((v) => v.replace(/var\(\s*/, "")) ?? [])];
    const variables = varNames.length ? await page.evaluate(inPageVariables, varNames.slice(0, 200)) : {};
    await save("rules.json", { rules: ruleStore, nodes: restRules, variables, keyframes: extras.keyframes, fontFaces: extras.fontFaces });

    await save("fonts.json", {
      families,
      usage: Object.fromEntries(Object.entries(usage).map(([k, v]) => [k, [...v]])),
      rendered,
      loadedFaces,
      fontFaces: extras.fontFaces.map(({ family, stylesheet, rule }) => ({ family, stylesheet, src: /src\s*:\s*([^;]+)/.exec(rule)?.[1]?.slice(0, 300) })),
    });

    const assets = await page.evaluate(inPageAssets);
    await save("assets.json", assets);
    if (assets.media.some((m) => m.tag === "canvas")) warnings.push("Contains a <canvas>: its drawing can only be reproduced by observation, not extracted.");
    if (assets.media.some((m) => m.note)) warnings.push("Contains a shadow root whose contents were not extracted.");

    const handlers = await page.evaluate(inPageHandlers);
    const listeners = {};
    for (const r of snap.records.slice(0, 80)) {
      const types = await listenerTypes(dev.cdp, `document.querySelector('[data-rx-id="${r.id}"]')`).catch(() => []);
      if (types.length) listeners[r.id] = types;
    }
    await save("behavior.json", {
      frameworks: handlers.frameworks,
      reactHandlers: handlers.reactHandlers,
      listeners,
      windowListeners: await listenerTypes(dev.cdp, "window").catch(() => []),
      documentListeners: await listenerTypes(dev.cdp, "document").catch(() => []),
      note: "Frameworks like React attach listeners to the app root, so per-node listeners can be empty; reactHandlers lists handler props instead.",
    });

    // Other widths.
    const responsive = { [widths[0]]: { rootBox: snap.rootBox } };
    for (const width of widths.slice(1)) {
      const { context, page: other } = await openPage(browser, url, { width, hide, wait: args.wait });
      const s = await other.evaluate(inPageSnapshot, { ...snapshotArgs, withHtml: false });
      if (s.error) {
        warnings.push(`At ${width}px: ${s.error} (hidden or replaced at this width).`);
        responsive[width] = { missing: true };
      } else {
        const image = join(out, `rest-${width}.png`);
        await shoot(other, other.locator('[data-rx-id="0"]'), image);
        const exact = join(out, `element-${width}.png`);
        await shoot(other, other.locator('[data-rx-id="0"]'), exact, 0, { animations: "disabled" });
        files.push(image, exact);
        const entry = { rootBox: s.rootBox, image };
        if (s.count !== snap.count) {
          entry.note = `Structure differs (${s.count} vs ${snap.count} elements); compare screenshots instead of per-node styles.`;
        } else {
          const changes = {};
          s.maps.forEach((m, i) => {
            const d = {};
            for (const [p, v] of Object.entries(m)) if (v !== snap.maps[i][p]) d[p] = [snap.maps[i][p], v];
            const box = s.records[i].box;
            const was = snap.records[i].box;
            if (box.w !== was.w || box.h !== was.h) d.box = [`${was.w}×${was.h}`, `${box.w}×${box.h}`];
            if (Object.keys(d).length) changes[i] = d;
          });
          entry.changes = changes;
        }
        responsive[width] = entry;
      }
      await context.close();
    }
    await save("responsive.json", responsive);

    // Optional click pass: reload for each part so clicks don't stack.
    const clicks = [];
    if (args.click) {
      for (const target of targets.filter((t) => t.interactive)) {
        await page.unroute("**/*").catch(() => {});
        await page.reload({ waitUntil: "load" });
        await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
        if (hide.length) await page.addStyleTag({ content: `${hide.join(", ")} { display: none !important; }` });
        await page.waitForTimeout(args.wait ?? 1200);
        const again = await page.evaluate(inPageSnapshot, { ...snapshotArgs, withHtml: false });
        if (again.error) {
          warnings.push(`Click pass: ${again.error} after reload.`);
          break;
        }
        await page.evaluate(() => {
          const root = window.__rx.nodes[0];
          const log = { attrs: [], inside: 0, outside: [] };
          window.__rxClick = { log, href: location.href };
          new MutationObserver((list) => {
            for (const m of list) {
              const inside = root.contains(m.target);
              if (m.type === "attributes" && inside && m.attributeName !== "data-rx-id") log.attrs.push(`#${m.target.getAttribute("data-rx-id") ?? m.target.localName} ${m.attributeName}`);
              if (m.type !== "childList") continue;
              for (const n of m.addedNodes) {
                if (n.nodeType !== 1) continue;
                if (inside) log.inside++;
                else log.outside.push(n);
              }
            }
          }).observe(document.body, { subtree: true, childList: true, attributes: true });
        });
        const covered = await page.locator(`[data-rx-id="${target.id}"]`).evaluate((el) => {
          el.scrollIntoView({ block: "center" });
          const r = el.getBoundingClientRect();
          const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          return hit && hit !== el && !el.contains(hit) ? `${hit.localName}${hit.id ? `#${hit.id}` : ""}${hit.getAttribute("data-rx-id") ? ` (#${hit.getAttribute("data-rx-id")})` : ""}` : null;
        });
        if (covered) warnings.push(`#${target.id} is covered at its centre by ${covered} (an overlay or a pseudo-element without pointer-events: none), so a click lands there instead.`);
        await page.route("**/*", (route) =>
          route.request().isNavigationRequest() && route.request().frame() === page.mainFrame() ? route.abort() : route.continue(),
        );
        await page.locator(`[data-rx-id="${target.id}"]`).click({ force: true, noWaitAfter: true, timeout: 5000 }).catch(() => warnings.push(`Could not click #${target.id}.`));
        await page.waitForTimeout(settle);
        const result = await page.evaluate(() => {
          const { log, href } = window.__rxClick;
          const opened = log.outside
            .filter((n) => n.isConnected)
            .map((n) => {
              const r = n.getBoundingClientRect();
              return { tag: n.localName, position: getComputedStyle(n).position, box: `${Math.round(r.width)}×${Math.round(r.height)} at ${Math.round(r.x)},${Math.round(r.y)}`, text: (n.innerText || "").replace(/\s+/g, " ").trim().slice(0, 80) };
            })
            .filter((o) => !o.box.startsWith("0×"));
          return { navigatedTo: location.href !== href ? location.href : null, attributesChanged: [...new Set(log.attrs)].slice(0, 40), addedInside: log.inside, openedOutside: opened.slice(0, 10) };
        });
        const changes = await page.evaluate(inPageDiff);
        const image = join(out, `click-${target.id}.png`);
        await page.screenshot({ path: image });
        files.push(image);
        clicks.push({ target: target.id, tag: target.tag, text: target.text, ...result, styleChanges: countChanges(changes), changes, image });
      }
      await page.unroute("**/*").catch(() => {});
      await save("click.json", clicks);
    }

    // Summary.
    const lines = [
      `# Component extraction`,
      ``,
      `- Page: ${url}`,
      `- Selector: \`${args.selector}\``,
      `- Captured: ${new Date().toISOString().slice(0, 10)}`,
      `- Elements: ${snap.count}${snap.truncated ? ` (first ${MAX_NODES} measured)` : ""}`,
      `- Size: ${Object.entries(responsive).map(([w, r]) => (r.missing ? `${w}px: hidden` : `${w}px: ${r.rootBox.w}×${r.rootBox.h}`)).join(" · ")}`,
      `- Frameworks seen: ${handlers.frameworks.join(", ") || "none detected"}`,
      ``,
      `## Fonts`,
      ...Object.entries(usage).map(([k, v]) => `- ${k}: ${[...v].join(", ")}`),
      `- Rendered with: ${Object.entries(rendered).map(([name, r]) => `${name}${r.custom ? " (web font)" : " (system)"}`).join(", ") || "unknown"}`,
      ...extras.fontFaces.slice(0, 6).map((f) => `- @font-face ${f.family} from ${f.stylesheet}`),
      ``,
      `## Motion`,
      `- ${uniqueAnimations.length} CSS animation(s)/transition(s): ${uniqueAnimations.map((a) => `${a.name || a.type} on #${a.target}${a.pseudo ?? ""} (${a.duration}ms${a.during ? `, ${a.during}` : ""})`).join("; ") || "none"}`,
      `- Keyframes recovered: ${Object.keys(extras.keyframes).join(", ") || "none"}`,
      `- JS-driven inline-style motion: ${jsMotion.length ? `nodes ${jsMotion.join(", ")}` : "none seen"}`,
      ...(trace
        ? [`- Trace (${args.trace}ms, every ${trace.interval}ms, ${trace.samples} samples): ${Object.keys(trace.nodes).length} element(s) moved: ${Object.entries(trace.nodes).slice(0, 8).map(([id, n]) => `#${id} ${Object.keys(n.initial).join("/")} (${n.changes.length} changes)`).join("; ")}`]
        : []),
      ``,
      `## Container`,
      `- Page background: body ${snap.pageBackground.body}, html ${snap.pageBackground.html}`,
      ...snap.context.map((c, i) => `- parent ${i + 1}: <${c.tag}> ${c.box.w}×${c.box.h} ${Object.entries(c.style).map(([k, v]) => `${k}: ${v}`).join("; ")}`),
      ``,
      `## States`,
      ...states.map((s) => `- #${s.id} <${s.tag}> “${s.text}”: hover ${s.hover?.changed ?? 0} changes, focus ${s.focus ? s.focus.changed : "n/a"}, press ${s.active ? s.active.changed : "n/a"}`),
      ...(clicks.length
        ? ["", "## Clicks", ...clicks.map((c) => `- #${c.target} “${c.text}”: ${c.navigatedTo ? `navigates to ${c.navigatedTo}` : "no navigation"}; ${c.openedOutside.length} element(s) opened outside; ${c.attributesChanged.length} attribute change(s); ${c.styleChanges} style changes`)]
        : []),
      ``,
      `## Assets`,
      `- ${assets.images.length} image(s), ${assets.backgrounds.length} background image(s), ${assets.svgs.length} SVG(s), ${assets.media.length} media/other`,
      ``,
      `## Warnings`,
      ...(warnings.length ? warnings.map((w) => `- ${w}`) : ["- none"]),
      ``,
      `## Files`,
      ...files.map((f) => `- ${f}`),
    ];
    await save("summary.md", lines.join("\n"));
    console.log(lines.join("\n"));
  } finally {
    await browser.close();
  }
}

main().catch((error) => fail(error.stack || error.message));
