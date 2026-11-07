from svgkit import *


def format_detection():
    D = 15.0
    b = text(30, 30, "How the server picks a reader for a file (first match wins)", "h")
    rows = [
        ("NIfTI", "extension .nii, or gzip + .gz", "NIfTI reader · three planes", "core"),
        ("Video", "mp4 · avi · ftyp or RIFF header", "ffmpeg frames", "core"),
        ("MKT", "header \"<CS\" or .mkt", "Cellvizio reader", "core"),
        ("DICOM volume", "DICM marker or .dcm, uncompressed", "native · three planes", "core"),
        ("CZI · VSI · other DICOM", "ZISR header, .czi, .vsi, .dcm", "slideio helper process", "ext"),
        ("OME-TIFF", "TIFF magic + OME-XML", "native · z-stacks, frames", "db"),
        ("Plain pyramidal TIFF", "libvips, ImageMagick, ...", "own reader", "db"),
        ("Scanner formats", "SVS · NDPI · MRXS · BIF · SCN · ...", "OpenSlide", "db"),
        ("JPEG · PNG · other TIFF", "image magic numbers", "single level", "box"),
        ("Last try", "OpenSlide on anything else", "or: no reader for this file", "warn"),
    ]
    y0, h, gap = 54, 36, 6
    for i, (t, test, outcome, cls) in enumerate(rows):
        y = y0 + i * (h + gap)
        b += f'<rect x="30" y="{y}" width="560" height="{h}" rx="8" class="box"/>'
        b += text(46, y + 23, f"{i + 1}", "h", fill=PAL["amber"]) + text(70, y + 23, t, "h") + text(260, y + 23, test, "m")
        b += f'<rect x="620" y="{y}" width="260" height="{h}" rx="8" class="{cls}"/>' + text(634, y + 23, outcome, "s")
        t0 = 0.4 + i * 1.35
        b += f'<rect x="28" y="{y - 2}" width="854" height="{h + 4}" rx="9" fill="none" stroke="{PAL["amber"]}" stroke-width="2.5" opacity="0" class="anim">' + window(t0, t0 + 1.35, D, 0.02) + "</rect>"
        if i < len(rows) - 1:
            b += f'<path d="M12 {y + h / 2} L12 {y + h + gap + h / 2}" class="line" marker-end="url(#ar)"/>'
    route = f"M12 {y0 + h / 2} L12 {y0 + 9 * (h + gap) + h / 2}"
    b += f'<path id="drop" d="{route}" fill="none" stroke="none"/>'
    b += f'<circle r="7" fill="{PAL["amber"]}" class="anim"><animateMotion dur="{D}s" repeatCount="indefinite" keyPoints="0;1;1" keyTimes="0;0.9;1" calcMode="linear"><mpath xlink:href="#drop" href="#drop"/></animateMotion></circle>'
    b += text(30, y0 + 10 * (h + gap) + 14, "Left: the test. Right: what reads it. The dot walks down the list until a test matches.", "m")
    svg("format-detection.svg", 910, y0 + 10 * (h + gap) + 30, b, "Reader selection", "A file is tested against ten rules in order: NIfTI, video, MKT, DICOM volume, slideio formats, OME-TIFF, plain pyramidal TIFF, OpenSlide formats, plain images, last try.")


if __name__ == "__main__":
    format_detection()


def viewer_states():
    D = 18.0
    b = text(30, 30, "The viewer has three states, and the toolbox follows the state", "h")
    X = [30, 380, 730]
    states = [("Nothing selected", ["annotation type to draw with", "(drop-down or keys 1-9)", "undo / redo, hide all"], "box"),
              ("Annotation selected", ["its type, its size (variable boxes)", "delete, remove vertex", "polygon tools: brush, knife"], "core"),
              ("Drawing", ["hints for the shape", "Enter finishes, Esc cancels", "Shift or Space + drag moves the slide"], "warn")]
    for x, (t, lines, cls) in zip(X, states):
        b += f'<rect x="{x}" y="70" width="250" height="150" rx="12" class="{cls}"/>' + text(x + 125, 98, t, "h c")
        b += f'<line x1="{x + 20}" x2="{x + 230}" y1="110" y2="110" stroke="#3a4660"/>'
        for k, l in enumerate(lines):
            b += text(x + 125, 138 + k * 24, l, "m c")
    b += path("a1", "M280 130 L380 130") + text(330, 120, "click it", "s c")
    b += path("a2", "M380 180 L280 180") + text(330, 200, "click empty · Esc", "s c", font_size=11)
    b += path("a3", "M130 220 L130 292 L830 292 L830 222") + text(480, 312, "start drawing: drag, click or outline with a type chosen", "s c")
    b += path("a4", "M880 222 L880 262 L180 262 L180 222") + text(530, 254, "Enter, or the closing stroke: the annotation is saved", "s c")
    b += text(30, 345, "A click on an annotation selects it from every state; a drag on the background pans, unless a drawing tool needs it.", "m")
    b += text(30, 365, "One-click mode (A): every click is a complete annotation of the type's fixed size; the state never leaves \"Nothing selected\".", "m")
    route = "M155 130 L505 130 L155 130 L155 292 L830 292 L830 150 L880 150 L880 262 L180 262 L180 130"
    b += f'<path id="tok" d="{route}" fill="none" stroke="none"/>'
    b += f'<circle r="8" fill="{PAL["amber"]}" class="anim"><animateMotion dur="{D}s" repeatCount="indefinite"><mpath xlink:href="#tok" href="#tok"/></animateMotion></circle>'
    for x, (t0, t1) in [(X[0], (0.0, 2.0)), (X[1], (2.0, 4.9)), (X[0], (4.9, 10.5)), (X[2], (10.5, 13.0)), (X[0], (13.0, 18.0))]:
        b += f'<rect x="{x - 2}" y="68" width="254" height="154" rx="13" fill="none" stroke="{PAL["amber"]}" stroke-width="3" opacity="0" class="anim">' + window(t0, t1, D, 0.01) + "</rect>"
    svg("viewer-states.svg", 1010, 388, b, "Viewer states", "Nothing selected, annotation selected and drawing, with what the toolbox offers in each and what moves between them.")


if __name__ == "__main__":
    viewer_states()
