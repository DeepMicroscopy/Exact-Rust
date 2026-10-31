---
title: User guide
nav_order: 2
---

# User guide

## Welcome
The first time you sign in, a short tour of four pages shows what is better than the EXACT you know: how much faster it is, that it works on every device, the Apple Pencil on the iPad, and the annotation tools. Skip it or step through with Next, Back or the arrow keys; you can see it again any time under **What's new** in the top bar.

## Signing in
Sign in with your user name and password. (The server also supports passkeys; enrolling and using them in the interface is
not built yet.) New users receive an
**invitation link** from a team administrator; opening it lets you choose a user name and password.

![Login](assets/screenshots/login.png)

## Image sets
The start page lists the image sets of your teams. Pick a team on the left to narrow the list, or search by name; with a team
selected, **Statistics** shows images, annotations and storage per image set and file format.
An image set holds images, tags and *products*; the products decide which annotation types you can use in it.

![Image sets](assets/screenshots/home.png)

Inside an image set you can:

* **Upload images** by dragging files onto the page. Each upload becomes a card with progress. When a name already exists
  you are asked whether to keep both, replace, or skip.
* **Filter and sort** the thumbnails, or select several to move, delete or register them.
* **Right-click an image** (on a tablet or phone: press and hold) for its menu: **Open**, **Download** (the original file; slides
  that consist of a folder, such as MRXS and VSI, come as a ZIP that is packed first, so the download starts after a moment),
  **Move…** (no selection needed; on a selected image it moves the whole selection) and **Related images**: the images it was
  registered with and the crops made from it, or the image it was cropped from. Click one to open it.
* **Export** the annotations in one of the export formats of the set, **view statistics**, and open **Files** (auxiliary
  files such as reports).
* Open **Settings** to rename the set, change its team, tags and products.

![An image set](assets/screenshots/imageset.png)

## The viewer
Click a thumbnail to open an image. Drag to pan, scroll to zoom. The left panel lists the annotation types with their counts;
untick a type to hide it. **Hide** (or `Y`) hides all annotations.

The round icon at the right of the top bar opens **Image adjustments**: brightness, contrast, gamma, saturation, hue, grayscale
and invert. The window can be moved by its title (and stays where you put it), double-clicking a slider's name resets it, and a dot
on the icon shows that something is changed. Only the display changes: not the file, not the annotations, and a crop or
download is unaffected. Your settings are remembered for the next image.

### Frames, volumes and movies
* **Z-stacks and movies** get a frame slider; `Shift+E` / `Shift+Q` or `Page Up` / `Page Down` step through frames, `Space`
  plays a movie (right click on the play button chooses the speed).
* **NIfTI and DICOM volumes** open in a **three-plane view** (axial, coronal, sagittal) with a crosshair. Click in a plane to
  move it, scroll to step through slices. *Single plane* switches back to the ordinary viewer.

![Three-plane view](assets/screenshots/planes.png)

The fourth panel can show a **3D render** of the volume (**Show 3D render**; with a segmentation type chosen, its mask is drawn in the type's colour). It is off
until you ask for it: the server first averages the volume onto a coarse grid (choose *Fast* to *Very fine*), which takes a few seconds for a large image the first
time. Drag to turn it, scroll to zoom; *Bone*, *Soft tissue* and *Maximum intensity* are starting points for the threshold and opacity sliders.

### Images from a crop
An image created by *Crop to new image* remembers where it came from. The top bar offers **Show in original**, and the
pointer position is shown in both coordinate systems.

## Annotating
The toolbox at the bottom changes with what you are doing.

| You | The toolbox offers |
|---|---|
| nothing selected | the annotation type to draw with (drop-down, or keys `1`–`9`), undo / redo, hide |
| selected an annotation | its type, size (for variable boxes), delete, remove vertex, polygon tools |
| are drawing | hints for the shape, `Enter` to finish, `Esc` to cancel |

* **Select** an annotation by clicking it. Drag a handle to resize, drag the body to move. Dragging anywhere else pans.
* **Draw** by dragging (boxes, lines), clicking (points, fixed-size boxes), or outlining (polygons and polylines): **drag around
  the shape** with the pen or mouse, and lifting near where you started closes and saves the polygon. A stroke that ends elsewhere
  stays open: continue with the next stroke or with clicks, and finish with `Enter`, a double click or the *Finish* button.
  Alternatively click the corners one by one (clicking the first point closes a polygon).
* **Move the image while drawing** with `Shift` + drag, `Space` + drag, the middle mouse button or (on a touch screen) a finger.
  A plain drag with the pen or mouse never moves the image while a polygon, polyline, point or one-click box is being drawn.
* **One-click mode** (`A`): every click places an annotation of the type's default size. A ghost outline shows where.
* **Polygons**: select one, hold `Shift` and drag to add area with a brush, `Alt` and drag to erase. `S` cuts an area away
  (scissors), `G` adds one (glue), `D` splits along a line (knife); with these you can outline freehand as well (the knife cuts
  where you drew, as soon as you lift the pen). On a touch screen use the buttons in the toolbox.
* **Pen**: the pen annotates by itself, without switching a tool on, using the type chosen under *Annotate with*. With a polygon
  type, or a polygon selected, it is a brush: a stroke paints area (Add) or erases it (Subtract). With a polygon selected only
  that polygon is changed. With nothing selected the first polygon the brush touches is the one that is changed, and only for that
  stroke; a stroke that touches nothing makes a new polygon (Add) or does nothing (Subtract). With a box or line type the pen draws
  boxes and lines by dragging. A finger still pans and zooms, and a tap with a finger selects or deselects.
  Once a pen has been used, two round buttons appear at the edge of the screen for the other hand: **+ / −** switches between adding
  and subtracting, and the **ring** shows the brush size and opens a vertical slider (with a button to move the buttons to the other
  side). They are hidden while a rectangle is selected, and a dotted crosshair shows where the pen hovers. A browser cannot see the
  squeeze or double tap of an Apple Pencil, which is why these buttons are on the screen.
* **Several at once**: `Ctrl+A` selects all, `Ctrl+C` / `Ctrl+V` copy and paste, `Delete` removes the selection.
* **Right click** (long press on a touch screen) on an annotation opens its menu: *Info* (who created and edited it, area,
  position), *Change class*, *Crop to new image* and *Delete*.
* While you edit, the **area** (µm² or mm² when the image has a resolution) or the **length** is shown on the shape.
* Everything can be undone with `Ctrl+Z` and redone with `Ctrl+Shift+Z`.

![Annotating](assets/screenshots/viewer.png)

Annotation works on desktop and tablet (touch targets are large, drawing works with a pen); viewing also works on a phone.

## 3D segmentation
In the three-plane view of a volume (NIfTI, and DICOM CT, MR and PET volumes: they work alike) you can paint a **mask** that
belongs to a *segmentation* type, and see and edit it on the axial, coronal and sagittal plane at once. The **Segment** button in the
top bar lists the segmentation types of the image set (marked ▨; the set needs a product that has one). Choosing a type opens the tool window
and lays that type's mask over all three planes; the first use creates the mask in the image. **Escape** or the window's ✕ leaves the mode.

Everything is measured in millimetres, so a brush of 8 mm is round in the picture of every plane, also when the slices are thicker than
the pixels. The window can be moved by its title, and it shows the volume of the mask (mm³, from 1000 mm³ in ml) and the number of axial slices
that hold some of it.

* **Brush** (`B`) paints, **Eraser** (`E`, or hold Alt with the brush) removes. *2D disc* works in the plane you draw in, one slice thick;
  *3D sphere* reaches through the slices around every point of the stroke. The size is set in pixels of the plane you draw in (the default) or in mm, switched next to the slider; `[` and `]` or Alt + mouse wheel change it.
  With a mouse, pen or finger a drag is one stroke, stored when you lift the pointer; the ring under the pointer shows the size.
* **Wand** (`W`) adds the connected region whose grey values are within the *tolerance* of the grey value you click on (Alt + click removes it),
  either in the plane or through the whole volume. *Reach* limits it to a radius (mm) around the click; a region that is too large is refused with a message.
* **Interpolate slices** fills the empty axial slices between painted ones by blending their shapes. **Copy** repeats the slice of the crosshair
  onto the next or previous slices.
* **Grow** and **Shrink** change the mask by a number of voxels, **Fill holes** closes cavities, **Largest part only** removes the small separate pieces,
  **Clear mask** (click twice) empties it.
* **Undo** and **Redo** (`Ctrl/Cmd+Z`, `Shift+Ctrl/Cmd+Z`) go back and forth through these steps; the steps are kept while the mask is open in the server.
* A click or stroke also moves the crosshair to that point, so the other two planes show it. `Ctrl` (`Cmd`) + click moves the crosshair without painting;
  the mouse wheel and Page Up / Down still step through the slices. Accounts that are read-only see the mask and have no tools.

The single-plane view of a volume paints masks on the axial plane only; for the other planes its toolbox points to the three-plane view.

## Automatic segmentation
In the three-plane view of a volume (NIfTI, or a multi-frame CT / MR DICOM) **Auto segment…** asks a worker to compute the mask of the whole volume:

1. pick the **method** (a threshold ships with EXACT; your administrator can add others, for example a deep-learning model of the lab),
   the **type** that receives the mask and whether the result **replaces** the mask or is **added** to it, and set the method's parameters;
2. **Start**. The dialog shows the progress and may be closed (the job keeps running; the **Jobs** page lists it). A job waits as long as no worker
   is running;
3. when it is done the mask is in the image like a painted one: look at it on all three planes, correct it with the brush, and **undo** takes
   the whole result back.

The threshold method finds what separates by brightness (bone or contrast in CT, tissue against air); it does not know anatomy, so touching
structures of the same brightness stay one. Check every automatic mask before you use it.

## Registration
Registration aligns two images of the same tissue, for example a stain and its neighbour.

1. In an image set, select the images and choose **Register**, or open the **Registration** tab to see what exists.
2. Choose **automatic** (a worker computes it; the job shows up under *Jobs*) or **manual** (place matching points on both
   images).
3. Review the result: automatic registrations have no point list, so the review shows the overlay only.
4. In the viewer the registered image can be shown as an **overlay**, with an opacity slider.

## Jobs
**Jobs** (top right) lists image analyses and registrations with their status — queued, running with progress, done, failed
with the error. Failed jobs can be restarted, queued or running ones cancelled.

## Damaged images
If a TIFF's pyramid is damaged the viewer offers a **one-time repair**; the original is kept as a backup that can be restored.
