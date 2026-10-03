# Designer and accessibility review: Noor

I'm a product designer and accessibility specialist. I work to WCAG 2.2 AA, and I also look at how fast the product feels.
I checked all five bundles: ky-repo (L1), itsdangerous-feature (L2), chi-algorithm (L3), ky-change (L4) and xpl-self (16 MB).
Scripts and raw output are in `scratchpad/d/` (perf.mjs, contrast.mjs, svgsize.mjs, kbd*.mjs, axe.mjs, resp.mjs, present.mjs).
I loaded axe-core 4 from a scratch install (`scratchpad/axe`) because the repo doesn't have it. Screenshots are in `reviews/shots/designer/`.

## 1. Tasks

| Task | Result | Effort | Notes / where I got stuck |
|---|---|---|---|
| Visual consistency with real content (all bundles, every tab, 1440×900) | partial | ~35 min | Short labels and the ky-change map hold up well. Diagram pictures don't: the xpl-self guide picture is 6.5 px text, maps cut off their end boxes, and edge labels are crossed by lines. |
| Contrast, light and dark (computed per text run, alpha and opacity blended) | partial | ~20 min | Prose and the chrome mostly pass. **Dimmed code fails badly in light mode (1.95–2.9:1).** The previous review's "≈4.3:1" only holds for plain foreground text, not for syntax colours. |
| Keyboard pass on ky-repo: Guide → Map (box, edge) → Show source → code → Present → Esc | partial | ~20 min | No traps, and focus rings show on HTML controls. On the map the focus ring looks the same as "selected", tab order doesn't follow the visual order, and focus drops to `<body>` on entering and leaving Present. |
| axe-core (ky-repo, ky-change: guide, map + source, code, present) | done | ~5 min | Results: color-contrast, nested-interactive, scrollable-region-focusable, target-size, and landmark-unique on ky-change. |
| Reduced motion | pass | ~5 min | The viewer has almost no motion: 0.12–0.2 s opacity, width and grid transitions, and no smooth scroll or animated zoom. Nothing needs to change. |
| 200% zoom (720×450), 390×844 phone, 768 tablet | partial | ~15 min | No sideways page scroll in any bundle. At 200% the map gets about 180 px of the 450 px height and its bottom can't be reached. On a phone, the tour picker runs past the right edge. |
| Performance: time to `__xpl`, heap, interaction latency | pass | ~10 min | Everything is fast, including the 16 MB bundle (table below). |

### Performance (headless Chromium, 1440×900, after GC)

| Bundle | Size | DOMContentLoaded | `__xpl` ready | JS heap at load → after tabs | Map / Flow / Code tab | Select box | Present step (avg / max) |
|---|---|---|---|---|---|---|---|
| ky-repo | 2.1 MB | 172 ms | 301 ms | 6.4 → 9.7 MB | 140 / 121 / 333 ms | 66 ms | — |
| itsdangerous | 1.3 MB | 138 ms | 246 ms | 5.5 → 7.6 MB | 133 / 118 / 171 ms | 109 ms | 89 / 102 ms |
| chi | 1.6 MB | 153 ms | 288 ms | 5.9 → 8.3 MB | 138 / 129 / 200 ms | 81 ms | 81 / 142 ms |
| ky-change | 2.1 MB | 171 ms | 296 ms | 6.5 → 9.2 MB | 189 / 128 / 172 ms | 62 ms | — |
| xpl-self | 16.9 MB | 803 ms | 1006 ms | 25.1 → 27.4 MB | 174 / 144 / 226 ms | 66 ms | 82 / 131 ms (16 steps) |

There were no console errors. xpl-self is the only bundle that is noticeably slower, and only on first paint: about 1 s, which comes from parsing the 16 MB file. Everything after that stays under 350 ms.
The first Code tab costs the most (ky-repo 333 ms, for CodeMirror setup), but it is still within "instant". **Speed is not a problem.**

## 2. Ratings (1–5)

| | L1 ky-repo | L2 itsdangerous | L3 chi | L4 ky-change | xpl-self |
|---|---|---|---|---|---|
| Comprehension | 4 | 4 | 4 | 4 | 3 |
| Navigation | 4 | 4 | 4 | 4 | 3.5 |
| Code readability | 3 | 3.5 | 3 | 3 | 3 |
| Diagram usefulness | 4 (map) / 3 (guide pic) | 3 | 3.5 | 4.5 | 2 |
| Trust (looks right) | 4 | 3.5 | 3.5 | 4 | 3 |
| **Overall** | 3.5 | 3.5 | 3.5 | 4 | 3 |

Accessibility on its own: **3 / 5**. Visual polish: **3.5 / 5**.

## 3. Findings

### Viewer issues

| id | sev | bundle | What I saw | Evidence | Suggested fix |
|---|---|---|---|---|---|
| V1 | **major** | all, light mode | Dimmed code (outside the focus range) fails contrast. The 0.6 opacity applies to every syntax colour, not only the base foreground. Measured in light mode: comments 2.26:1, keywords 2.47, types 2.56, variables 2.71, properties 2.9, strings 3.04, dimmed gutter numbers **1.95**. Dark mode is 2.99–4.4. The previous review's "≈4.3:1 light" was computed on `--code-fg` only. | contrast.mjs (ky-change, chi, xpl-self "code-after-show"); axe `color-contrast` ×100+ per view; `ky-change-light-source.png` | Don't use opacity. Mix each token colour toward the background with a fixed floor of 4.5:1, or keep syntax colours and use only a background tint or bar to mark the focus. At minimum use opacity ≥0.8 for syntax tokens and keep gutter numbers ≥4.5:1. |
| V2 | **major** | xpl-self (also the shape of any tall map) | The guide picture on step 1 renders its text at **6.5 px**, which can't be read at 1440×900. The xpl-self map at Fit is 8.8 px: a 420 px-wide, tall column in the middle of a 1160×708 canvas, at scale 0.67. ky/chi maps get 13–16 px. | svgsize.mjs; `xpl-self-guide-light.png`, `xpl-self-map.png` | Set a readable-zoom floor for guide pictures (≈10 px rendered text) and crop to the step's focus, as Present already does. For tall maps in landscape canvases, pick the ELK direction (RIGHT vs DOWN) by the canvas aspect, or allow Fit to scroll. |
| V3 | **major** | ky-repo, itsdangerous, chi (guide pictures) | Guide pictures cut off the end boxes even when the whole diagram is only 3–6 boxes: "wser or server JS", "Fetch API / built-in fe", "Base64 helpers", "Signing and key", and a half-hidden "Context" at the bottom. Edges also come in from boxes out of view, with labels cut ("igns with timestamp"). The fade reads as "more to see", but here it just looks broken. | svgsize.mjs: 6–8 clipped text nodes per picture; `ky-repo-guide-light.png`, `itsdangerous-feature-guide-light.png`, `chi-algorithm-guide-dark.png` | Fit the whole picture when it fits at a readable zoom (it would here: 770 px wide holds ky's 3 boxes). Crop only when it can't fit, and never cut through a box that the step names. |
| V4 | minor | ky-repo map, itsdangerous map, xpl-self flow, ky map after an edge pick | Lines cross edge labels: "hands over request**s**", "encodes **the** payload", the loop label "a rejected patch **writes** nothing" (with the dashed arrow through it), and "calls ×1" in chi's guide. When an edge is picked, its highlighted line is drawn on top of its own label. | `itsdangerous-feature-map.png`, `xpl-self-flow.png`, `kbd-edge-enter.png` | Keep the label halo above every line, including the selected one. Shift labels off vertical segments. |
| V5 | minor | itsdangerous map | Many derived edges are crowded: 6 arrowheads stack at the bottom edge of "Serializer core", lines tangle around "Timestamps and expiry", and the labels "calls ×3 / extends ×1" float without a clear owner. | `itsdangerous-feature-map.png` | Merge parallel derived edges between the same pair. Spread the ports, or group the edges as one "uses" edge with a count. |
| V6 | **major** (a11y) | all maps | Keyboard focus on a box looks exactly like selection for external boxes (dashed blue). Once a box is picked, there is no separate ring to show where focus is. | `kbd-box-focus.png`: "Web servers" is focused and looks identical to the picked "Fetch API" in `kbd-edge-enter.png`. kbd.mjs reports `outline:none` on `g[role=button]` | Give focus its own ring: an offset 2 px outline in `--accent` plus a 2 px gap, separate from the selection fill and border. (WCAG 2.4.7 / 2.4.13) |
| V7 | minor (a11y) | ky-repo map | Box tab order isn't the visual order: Fetch API → Web servers → ky → Your app (the top box comes last). Accessible names start with the badge text: "built-in fetch Fetch API", "TypeScript library ky". | kbd.mjs output | Sort focusable boxes by layout position (top-down, left-right). Name them "Fetch API, built-in fetch". |
| V8 | minor (a11y) | all maps | axe `nested-interactive`: a box with `role=button` contains the focusable corner buttons ("See what is inside ky", "Show the inside of ky here"). | axe.mjs, ky-repo | Make the box a group with its own button child, or move the corner buttons outside the box's DOM node. |
| V9 | minor (a11y) | all | Focus is lost on mode change. Entering Present puts focus on `<body>` (the Present button disappears), and Esc back also lands on `<body>`. | kbd2.mjs: "present focus: BODY", "after Esc: BODY" | Focus the slide region (or the step heading) on entering. Return focus to the Present button on exit. |
| V10 | minor (a11y) | Present, code panes | axe `scrollable-region-focusable`: Present's code panes can't be focused, so a keyboard user can't scroll the code. Read mode is fine. | axe.mjs present | Give `.cm-scroller` `tabindex=0` (with a label) when the content isn't focusable. |
| V11 | minor | all, light | The active tab and current tour-step text is `#2b6ae0` on `#e2ebfc` = **4.13:1** at 13 px. Other small text below 4.5:1: TOC step numbers 3.9 (light) / 3.08 (dark), "New" pill 4.06–4.26, "Show the change" link 4.15, dark-mode 11 px section labels ("In the code", "Lines", "Files") 4.05 / 3.75, inspector "Its settings are in / Key:" 4.27 at 10–11 px. Syntax colours on highlight tints also fail even at full opacity: comment 3.78, `import` 4.18 on the focus tint. | contrast.mjs, axe | Darken `--accent` text on soft backgrounds (for example #1f56c4 ≈ 5.4:1). Darken `--faint` or `--muted` for tiny uppercase labels. Check token colours against each `--hl-*` tint. |
| V12 | **major** (200% zoom) | all, 720×450 | On the Map, the header, breadcrumb, Read/Show buttons, title and topic picker take 266 px. The diagram gets about 180 px, and the SVG is 364 px tall in a document that doesn't scroll, so the bottom of the canvas and Fit target are off-screen. | `r-chi-algorithm-zoom200-map.png`; present.mjs "200% map": svgTop 266, svgH 364, docH 450 | At short heights, collapse the view header (title plus picker on one line, or hide the title) and size the canvas to the visible area. |
| V13 | minor | phone 390 | The tour picker in the guide runs past the right edge ("…HTTP response" clipped). The "Where this is in the code" bottom sheet permanently covers about 120 px of the guide. In Code, panes are about 250 px tall each, and a collapsed first pane leaves wrapped lines unaligned with the gutter (comment fragments). | `r-ky-repo-phone-guide.png`, `r-xpl-self-phone-code.png`; resp.mjs offRight=2 | Give the select `max-width:100%`. Let the bottom sheet collapse to a single handle. On a phone, open one pane at a time. |
| V14 | polish | tablet 768 | With a long title (ky), "Edit" wraps onto its own row, so the header grows from 48 to 83 px. | `r-ky-repo-tablet-map.png` | Shrink the title further, or fold Edit into an overflow menu below ~900 px. |
| V15 | minor | all, inspector | In "Related files" cards, the `<summary>` marker ▼ sits alone on its own line because `.resource-kind` / `.resource-label` are `display:block`. The file path then appears twice (bold label, then blue link). The text is 10–12 px. | `xpl-self-guide-light.png` right column; workspace.css:610-627 | `summary{display:flex}` or `list-style:none` with a custom chevron inline with the label. Drop the duplicate path. Use ≥12 px. |
| V16 | minor | ky-change, map + source | The pane header packs 7 items into about 700 px: "source/c… Ky.ts in Ky.#withManaged… Changed Show changes ‹ 12 changes › defined here". The path and the function name are both truncated. After Show source, the map doesn't refit and boxes are cut off on the left. | `ky-change-light-source.png` | Put the change navigation on a second row, or drop the "Changed" pill when "Show changes" is present. Refit the map when the column shrinks. |
| V17 | minor (a11y) | all | Tree rows are 22 px tall: axe `target-size` ×22–33. Each guide step repeats identical accessible names ("Open in Map", "Show the code") with no step context. On ky-change, two `guide-callers` landmarks share one label. | axe.mjs | Use rows of at least 24 px. Add `aria-describedby` with the step title, or names like "Open step 3 picture in Map". Make landmark labels unique. |
| V18 | polish | Present | The "Fit all" pill in the diagram's bottom-left corner sits on top of diagram labels ("te…" in xpl-self step 8). | `pres-xpl-self-8.png` | Leave a gutter for it, or put it in the zoom toolbar. |
| V19 | polish | xpl-self (and itsdangerous) | On load, the breadcrumb says "Authoring toolchain" (step 1) while the inspector's CURRENT TOPIC says "viewer", so two different "current" things show at once. | `xpl-self-map.png` | Make the inspector follow the breadcrumb's element, or label it as "Picked: viewer". |

### Content issues (what Claude wrote)

| id | sev | bundle | What I saw | Fix |
|---|---|---|---|---|
| C1 | minor | xpl-self | The tour's step titles are code signatures ("xpl apply: applyPatch(explainer, patch, index, texts, { actor })", "deriveGraph(view, model)"). They make a TOC that wraps to 3 lines at 220 px and reads as code, not as a story. The other bundles use sentence titles, which read much better. | Use sentence titles, and keep the signature in the step body. |
| C2 | minor | itsdangerous | The map draws the file-level "calls ×N / extends ×N" derived edges with the authored edges on top. It ends up with 10+ edges for 6 boxes. | Hide derived edges that duplicate an authored edge between the same pair. |

### Authoring-tool issues

| id | sev | What I saw | Fix |
|---|---|---|---|
| A1 | minor | Nothing warns the author when a view's picture renders below a readable size. xpl-self shipped a 6.5 px guide picture. | Have `xpl validate` / the viewer measure tests flag views whose Fit-zoom text is < 10 px at 1280 px. |

## 4. What works (keep it)

- **Speed.** Under 1 s to interactive even at 16 MB. Tab switches 120–330 ms, box picks 60–110 ms, Present steps about 80 ms. Heap stays under 30 MB.
- No sideways page scroll at 390, 768 or 720 px in any bundle. The phone Back/Forward arrows and the shortened breadcrumb are fine.
- Present at 1440 is the best view in the product: 12–13.5 px diagram text on every step, large captions, and code at a readable size (`pres-chi-algorithm-5.png`).
- The ky-change map is the clearest diagram I saw: Changed/New pills are colour plus text, and the layout is vertical with clear labels (`ky-change-map.png`).
- Focus rings on every HTML control. Edges have readable accessible names ("ky to Fetch API: sends each request"). Keyboard edges come after the boxes. No keyboard traps anywhere, including CodeMirror (Tab leaves the editor).
- Dark mode chrome passes almost everywhere. Disabled Forward is clearly disabled (and exempt from contrast).
- Reduced motion needs nothing: the UI doesn't rely on motion.

## 5. How the UI adapts across abstraction levels

The same viewer works for all four levels. Each level stresses a different part:

- **L1 system (ky):** The map is good. Guide pictures crop needlessly (V3).
- **L2 feature (itsdangerous):** The file map gets tangled because derived edges are drawn on top of authored ones (V5, C2).
- **L3 algorithm (chi):** The Flow tab with decision diamonds is the right picture for a recursive search, and Present reads well. Flow labels sit on lines in places, and the guide picture cuts off "Context".
- **L4 change (ky-change):** The diff view is strong, but the pane header is overloaded (V16).

The weak point is the **guide picture and map Fit at scale**. Once content is tall or wide (xpl-self), the viewer shrinks it instead of cropping or scrolling, and text drops to 6–9 px. The other cross-cutting problem is **dimmed code contrast** (V1), which hurts every level, because the code is where readers end up.
