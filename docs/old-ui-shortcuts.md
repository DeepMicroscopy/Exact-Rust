# Old EXACT UI ("Lightroom v2") - keyboard shortcuts and gestures

Source root: `~/code/Exact/exact/exact`. Abbreviations: `EIV` = `annotations/static/annotations/js/exact-image-viewer.js`, `EISV` = `.../exact-imageset-viewer.js`, `SEG` = `.../segmentationTool.js`, `BB` = `.../boundingboxes.js`, `SEL` = `.../selection.js`, `OSD` = `.../openseadragon.js` (min build 6.0.2 identical for key handling), `v2`/`v3` = `annotations/templates/annotations/annotate_v2.html` / `annotate_v3.html`, `idx` = `images/templates/images/index_v2.html`, `set` = `images/templates/images/imageset_v2.html`.

General guards: handlers ignore events whose target is a textarea/text/number input (EIV/EISV) and, in EIV, while the resize-confirm dialog is open. Key handlers in EIV run on `keyup` (EIV:76), the EISV handler runs on `keydown` (EISV:55). No help modal listing shortcuts exists; hints appear only as button tooltips (cited below) and a "Key" column in the annotation-type table (v2:248, v3:678).

## 1. Keyboard - annotation viewer (EIV, class hierarchy of EXACTViewer*)

| Key combo | Context | Action | Source |
|---|---|---|---|
| O | viewer (all viewer classes) | Toggle overlay image: opacity 0 <-> slider value | EIV:671 |
| Delete (46), Backspace (8), X (88), F9 (120) | viewer (local-annotation viewers) | Delete selected annotation (tooltip: "Delete (DEL, x)") | EIV:1802-1822, tooltip EIV:2099 |
| Enter (13) | viewer | Finish/save current annotation (only if no poly operation active) | EIV:1812 |
| V (86) | viewer | Finish/save annotation (tooltip "Save (v)"; only if no poly op active) | EIV:1900, tooltip EIV:2072 |
| R (82) | viewer | Same as V: finish annotation. NOTE: OSD also binds R to rotate (OSD:~11553), both fire | EIV:1896 |
| Escape (27) | viewer | Cancel editing current annotation | EIV:1816 |
| 1..9 (49-57) and numpad 1..9 (97-105), no Shift | viewer (local annotations) | Change class of selected annotation / current type by key (on keyup). Digit held while clicking = fast-annotate (see mouse) | EIV:1823-1884, pressedDigits EIV:1935 |
| Shift+1..9 / Shift+numpad | viewer (global-annotation viewer classes) | Set global (image-level) annotation type by key | EIV:2941-2990, 3120-3170, 3279-3330, 3406-3455 |
| A (65, keyup) | viewer | Clears "insert new annotation" flag (set by keypress code 97, see mouse) | EIV:1886, EIV:1929 |
| B (66) | viewer | Push current annotation type to background | EIV:1890 |
| C (67) | viewer | Toggle annotation (selection) mode; tooltip "Annotation mode (c)" | EIV:1893, SEL (toggle button tooltip) |
| Y (89) | viewer | Toggle show/hide annotations (tooltip "Draw annotations (y)") | EIV:1904, tooltip EIV:2033 |
| S (83) | viewer | Activate SCISSOR poly operation (draw polygon to cut from selected) | EIV:1907, tooltip EIV:2137 |
| G (71) | viewer | Activate GLUE poly operation | EIV:1910, tooltip EIV:2146 |
| D (68) | viewer | Activate KNIFE multi-poly operation (line cuts through polygons) | EIV:1913, tooltip EIV:2155 |
| Ctrl+Z (90) | viewer | Undo (tooltip "Undo (Ctrl + Z)"). BUG/UNCLEAR: `case 90` has no `break` and falls through to `case 91`, so ANY press of Z (with or without Ctrl) also toggles the heatmap; Ctrl+Z does both | EIV:1916-1921, tooltip EIV:2081 |
| key 91 ("[" keyCode 219 is the real "[" key; 91 = Left Meta/Windows key) | viewer | Toggle heatmap (comment says '?'); effectively only reachable via Z fall-through or Meta key. UNCLEAR intent | EIV:1920 |
| Shift+E (69) | viewer (frame/z-stack viewers: LocalAnnotationsFrames, GlobalAnnotationsFrame, GlobalLocalFrames via inheritance) | Next frame | EIV:2747, 2928 |
| Shift+Q (81) | same | Previous frame | EIV:2752, 2933 |
| (any key while selection active) | viewer | keydown forwarded to OSD innerTracker.keyDownHandler | EIV:1942-1946 (handler `handleKeyDown`) |

OpenSeadragon built-in keys (active when the canvas has focus; EXACT focuses the canvas on selection press, EIV:1464/1542). Not EXACT code, but live in the page:

| Key combo | Context | Action | Source |
|---|---|---|---|
| Arrow keys | viewer | Pan | OSD:11474-11482 |
| Shift+Up / Shift+Down | viewer | Zoom in / out | OSD:11474-11480 |
| = / - | viewer | Zoom in / out | OSD:11482-11486 |
| 0 | viewer | Go home (fit view) | OSD:~11541 |
| R / Shift+R | viewer | Rotate clockwise / counter-clockwise (collides with EXACT's R = finish) | OSD:~11545 |
| F | viewer | Flip view horizontally (collides with EISV's F = verify image) | OSD:~11562 |
| J / K | viewer | Previous / next page of image source (frames) | OSD:~11566 |

## 2. Keyboard - image-set navigation inside the viewer (EISV)

| Key combo | Context | Action | Source |
|---|---|---|---|
| E (69), no Shift, not while drawing a selection | viewer / image set list | Load next image in filtered set (tooltip "next (e)") | EISV:37, v3:192 |
| Q (81), no Shift | viewer / image set list | Load previous image (tooltip "back (q)") | EISV:42, v3:176 |
| F (70) | viewer / image set list | Verify image (tooltip "verify (f)") | EISV:47, v3:187 |

## 3. Keyboard - annotate page templates (v2 / v3)

| Key combo | Context | Action | Source |
|---|---|---|---|
| 1..9 (no Ctrl/Alt/Meta) | viewer page, annotation-type table | Select the table row with matching `data-key` (set annotation type); outside inputs only | v2:1138-1148, v3:1054-1063 |
| Ctrl+F (Cmd+F on macOS) | viewer page (v3 only) | Open image drawer and focus its search box (not when typing in another input/textarea) | v3:899-908 |
| Escape (in image search box) | viewer page (v3 only) | Clear image search filter | v3:910-914 |

## 4. Keyboard - segmentation tool (SEG)

| Key combo | Context | Action | Source |
|---|---|---|---|
| Ctrl+Z / Cmd+Z | segmentation tool | Undo last stroke (preventDefault; ignored in input/textarea) | SEG:206-209 |
| Ctrl / Cmd (held) | segmentation tool, magic wand | Wand erase mode (cursor changes); tooltip "Magic wand - Ctrl/Cmd: erase mode" | SEG:212-221, v2:902 |

(Tool choice is by toolbar buttons only: pencil, wand, fill, eraser, pan - v2:~897-910; no key bindings for them. Brush size via `setBrushSize`, SEG:758, from a UI slider - no shortcut found.)

## 5. Keyboard - image set page and index

| Key combo | Context | Action | Source |
|---|---|---|---|
| / | image set page | Focus and select the image search box (when not in input/textarea) | set:1887-1892 |
| Escape | image set page, "move image" dialog | Close dialog | set:742-745 |
| Enter | image set page, "move image" dialog | Confirm move (if a target is selected) | set:742-746 |
| / | index (team tab) | Focus active tab's search box | idx:1015-1020 |
| Escape (in search box) | index | Clear search, blur box | idx:1021-1026 |

`annotations.js:72-100` keydown/keyup handlers only set a `gShiftDown` flag on Shift (16); cases for I/K/L/J (73/75/76/74) are empty. No effect.

## 6. Mouse / touch gestures

Annotation tool (BB + EIV handlers; only active while annotation mode is on, toggled with C; events come from OSD MouseTracker in SEL:96-102):

| Gesture | Context | Action | Source |
|---|---|---|---|
| Press (left) on empty area inside the image | annotation tool | Start a new annotation of the current type (drag extends rect/line/poly points) | EIV:1464-1520 |
| Press on a polygon/line vertex (segment) | annotation tool | Start dragging that vertex (unless Ctrl held or A held or poly op active) | EIV:1485-1497 |
| Ctrl+press (any place) | annotation tool | Force creation of a new object even over an existing one | EIV:1485 |
| Hold A (keypress 97), press | annotation tool | Same as Ctrl+press: force new object (flag `insertNewAnno`, cleared on A keyup) | EIV:1485, 1929, 1886 |
| Click (press+release, no drag) on existing object | annotation tool | Select it; saves previously selected; sets current type to its class | EIV:1585-1610 |
| Drag inside selected object | annotation tool | Move the whole object (polygon, line, rect), clamped to the image | BB:1696-1750 |
| Drag a vertex/handle of selection | annotation tool | Move segment; saved on release | BB:1700-1715, EIV:1570-1583 |
| Shift+drag on selected polygon | annotation tool | Brush mode: union a circle (radius = brush size) into the polygon | BB:1685-1695 |
| Wheel over selected non-polygon object | annotation tool | Scale object by (1 + scroll/10) (not for fixed_rect) | BB:1449-1460 |
| Wheel over selected polygon | annotation tool | Change brush radius (min 1) | BB:1461-1473 |
| Hold digit 1-9 + click on object | annotation tool | Fast annotate: assign class of that digit to the smallest clicked object | EIV:1506, 1610-1632 |
| Press+release while SCISSOR/GLUE/KNIFE active | annotation tool | Draw operation shape, then run poly operation on release | EIV:1548-1562 |
| Toolbar buttons (Save, Undo, Verify, Delete, NOT, UNION, HARMONIZE, scissor, glue, knife, copy-frame, screenshot, navigator, heatmap) | viewer | Same actions as keys above | EIV:2033-2161, 642, 654, 2793 |

OpenSeadragon defaults (no EXACT overrides found for these; `dblClickToZoom` etc. not set in EIV:186-199):

| Gesture | Context | Action | Source |
|---|---|---|---|
| Left-drag | viewer, annotation mode off | Pan | OSD default (gestureSettingsMouse) |
| Wheel | viewer | Zoom, `zoomPerScroll: 1.1` | EIV:195 |
| Click (quick) | viewer | OSD default click-to-zoom. UNCLEAR whether still active alongside selection tracker | OSD default |
| Double click | viewer | OSD default dblClickToZoom = false; no EXACT handler | OSD:385 |
| Pinch / touch drag | viewer | OSD default touch pan and pinch zoom; no custom touch code found | OSD default |
| Right click | viewer | No EXACT handler found (OSD `canvas-contextmenu` event only) | - |
| Click on MPR sub-viewer (quick click, not drag) | viewer, MPR (3 planes) | Set crosshair position, navigate other two planes | EIV:1038-1075 |

Segmentation tool (SEG:227-275, drawCanvas on top of viewer; tool "pan" disables the canvas so OSD pans, SEG:814):

| Gesture | Context | Action | Source |
|---|---|---|---|
| Left press+drag (pencil/eraser) | segmentation tool | Paint/erase with brush, stroke committed to undo and uploaded on release or mouseleave | SEG:227-275 |
| Left click (wand) | segmentation tool | Magic wand fill at point | SEG:236 |
| Ctrl/Cmd + left click (wand) | segmentation tool | Magic wand erase | SEG:236, 212 |
| Left click (fill tool) | segmentation tool | Flood fill by colour similarity | SEG:240 |
| Non-left buttons | segmentation tool | Ignored (`e.button !== 0` returns) | SEG:228 |
| Mouse move | segmentation tool | Update brush cursor | SEG:250 |
| Wheel / pinch while a draw tool is active | segmentation tool | UNCLEAR - draw canvas has pointer-events handled in SEG:102 and no wheel handler was found; zoom/pan probably requires switching to "pan" tool | SEG:102, 814 |

Page-level (templates):

| Gesture | Context | Action | Source |
|---|---|---|---|
| Right click on image card | image set page | Custom context menu (download, move to another set); hides on click/scroll | set:672-684, 709, 720 |
| Double click on target in move list | image set page | Confirm move immediately | set:739 |
| Click backdrop | image set page, move dialog | Close dialog | set:741 |
| Drag & drop files on page / drawer | image set page, viewer drawer (v3) | Upload images; CSV drops open a CSV choice modal | set:875-877, 1743-1770; v3:1086-1144 |
| Click thumbnail / image link | viewer image list | Load that image (`imageLinkClicked`) | EISV:119-120 |
| Click annotation-type row | viewer page | Select annotation type | v2:1048, v3:961 |
| Drag handle (mousedown/move/up) | viewer page (v3) | Resize panel (handle at v3:938-956) - exact panel UNCLEAR, see source | v3:938-956 |
| Click backdrop | viewer page (v3) | Close drawers | v3:861 |
| Click pill "x" | index | Clear search box | idx:1005 |

**Decision (2026-10-27):** the heatmap (toolbar button, key 91 and the Z fall-through to it) is dropped in the new UI; its implementation was flawed. Ctrl+Z stays as undo only.

**Decision (2026-10-27):** the R binding (finish annotation; Enter and V remain) and the F binding (verify image) are dropped, so OpenSeadragon's own key handling is switched off and no key collides any more. Rotate and flip are not offered.
