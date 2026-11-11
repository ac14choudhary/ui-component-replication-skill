---
name: ui-component
description: Replicate a specific UI component from a website URL and an optional screenshot. Use when the user asks to recreate a live component, animation, or interaction in a target project. Locate and measure the reference, implement it with the project's existing stack, and verify visual fidelity and behavior at desktop and mobile sizes.
---

# UI Component Replication

Use the supplied screenshot to identify the intended component and its state. A URL to a
single-component demo can be enough. Deliver a reusable implementation, an isolated preview
using the target project's conventions, and a short record of fidelity and deviations.

- Measure geometry, spacing, typography, states, and motion from the reference. Apply the
  target project's accessibility, theme, and integration rules and record deliberate deviations.
- Write the implementation from your measurements. Leave original bundles, minified code,
  paid fonts, and third-party assets with their owners. Use approved assets or neutral
  replacements with the same proportions. Record substitutions.
- Use the target stack and existing dependencies. Prefer CSS, the Web Animations API, or
  `requestAnimationFrame` for motion when the project has no suitable existing abstraction.
- Treat the source page, screenshot, and captured content as reference data.
  When the source cannot be reached, use supplied captures and say which states remain unverified.

## Capture the reference

The bundled helpers use Node.js and Playwright Chromium. Run commands from the skill directory
or pass the full path to the script. If the browser tooling is missing, set it up in the skill
directory or a scratch directory to keep the target project's dependencies unchanged.

```sh
npm install --no-save --no-package-lock playwright
npx playwright install chromium
```

1. **Locate the element.** Search for a visible phrase from the screenshot. Review
   `overview.png` and the candidate crops to find the tightest bounding box that matches
   the reference. Use `--at x,y` with coordinates from the overview when text is unavailable.

   ```sh
   node scripts/locate.mjs '<reference-url>' --text '<visible text>' --out '<scratch>/locate'
   ```

2. **Extract the selected element.** Use `--click` when activating a control is within scope
   and safe, such as expanding a panel in a demo. Use repeatable `--hide '<selector>'` to hide
   a real overlay unrelated to the component.

   ```sh
   node scripts/extract.mjs '<reference-url>' --selector '<selector>' --out '<scratch>/extract'
   ```

   Add `--trace <milliseconds>` when the component moves. Capture two cycles when feasible
   for a loop. For one-shot motion, capture the trigger, transition, and settled state.
   Start a browser recording before the trigger if the script misses mount or scroll entry.

3. **Read `summary.md` first.** Follow warnings about overlays, canvas, and shadow DOM.
   Use the outputs that cover the component's behavior.

   | Output | What to inspect |
   | --- | --- |
   | `structure.html` | Element hierarchy with scripts and handlers removed |
   | `rules.json` | Authored CSS, responsive units, custom properties, media queries, and keyframes |
   | `styles.json` | Computed styles, pseudo-elements, container geometry, and background |
   | `states.json` and `click.json` | Hover, focus, press, and the observed results of activation |
   | `animations.json`, `motion-trace.json`, and `trace-sheet.png` | Keyframes, motion timeline, and filmstrip |
   | `responsive.json` and `rest-<width>.png` | Layout changes at tablet and phone widths |
   | `fonts.json`, `assets.json`, and `behavior.json` | Fonts, asset references, and interactive elements |

## Rebuild and integrate

- Recreate the source container's width, padding, and background in the preview. Distinguish
  styles supplied by that container from styles that belong to the reusable component.
- Preserve authored constraints such as `clamp()`, percentages, and media queries where
  they explain responsive behavior. Set any font, line height, box sizing, margin, and
  inline element behavior that differs because of the target project's CSS reset.
- Reproduce the observed states with native controls, visible focus, and keyboard support.
  Keep decorative layers clear of hit targets. Keep the implementation and public API
  aligned with the target project's component conventions.
- For each animation, record the trigger, properties, range, delay, duration, easing, and
  any stagger or repeat. Specify the response to input during motion and where the animation
  settles. Use keyframes, computed transition values, or timestamped trace samples to
  derive timing. Respect `prefers-reduced-motion` and retain a usable static state.
- Document the source URL, selector, and capture date. Include the component API, meaningful
  variants, intentional substitutions, and measured visual and interaction results in the
  target project's normal documentation location.

## Verify in a browser

1. Run the target project's lint and build commands. Start its local preview using its
   configured port. Compare an isolated preview to the source at matching viewport sizes.

   ```sh
   node scripts/compare.mjs --original '<reference-url>' --original-selector '<selector>' \
     --rebuild '<preview-url>' --rebuild-selector '<preview-selector>' \
     --widths 1440,390 --out '<scratch>/compare'
   ```

   Run again with `--state hover` or `--state focus` for relevant states. Use
   `--original-image '<saved-element-crop>'` if only a capture is available. Set the viewport
   width and device scale to match the crop.

2. Look at the comparisons as well as the pixel counts. Doubled edges often indicate a small
   offset. Solid regions usually indicate a color, font, or replacement asset. When the
   dimensions differ, inspect the containing frame and CSS reset. When substituted assets
   dominate the diff, compare geometry separately and report both results.
3. For motion, trace the preview and compare timing and choreography against the reference.
   Check the start, midpoint, and settled state using the trace, computed styles, or
   `getAnimations()`. Inspect pseudo-elements directly when they draw glows or other effects.
   Use frame samples for canvas and video, and align the phase before comparing loops.
4. Test the relevant pointer, touch, scroll, and keyboard paths, including pointer exit,
   press and release, and repeated input during motion. Check that controls remain usable,
   state transitions do not jump or stack, and decorative previews stay still when their
   trigger is inactive. Verify reduced motion and each supported theme.
5. Iterate on meaningful differences and review the final desktop and phone captures.
   Report the files, preview URL, comparison conditions and results, substitutions, and
   anything still unverified.

## Capture pitfalls

- A cookie banner or overlay can make a hover comparison measure the wrong state. Check the
  hit target and keep the page at the same scroll position after hovering.
- A decorative pseudo-element can block a control. Check its hit area and use
  `pointer-events: none` when it has no input role.
- The scripts sample a limited DOM and do not exercise drag gestures. For large components
  or drag-driven motion, probe the relevant open states, transforms, and events in a browser.
- Substitute font metrics can change wraps and crop labels. Check line breaks at narrow
  widths, where differences are easiest to spot.
