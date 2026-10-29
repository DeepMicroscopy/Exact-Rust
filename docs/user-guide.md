---
title: User guide
nav_order: 2
---

# User guide

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
* **Export** the annotations in one of the export formats of the set, **view statistics**, and open **Files** (auxiliary
  files such as reports).
* Open **Settings** to rename the set, change its team, tags and products.

![An image set](assets/screenshots/imageset.png)

## The viewer
Click a thumbnail to open an image. Drag to pan, scroll to zoom. The left panel lists the annotation types with their counts;
untick a type to hide it. **Hide** (or `Y`) hides all annotations.

### Frames, volumes and movies
* **Z-stacks and movies** get a frame slider; `Shift+E` / `Shift+Q` or `Page Up` / `Page Down` step through frames, `Space`
  plays a movie (right click on the play button chooses the speed).
* **NIfTI and DICOM volumes** open in a **three-plane view** (axial, coronal, sagittal) with a crosshair. Click in a plane to
  move it, scroll to step through slices. *Single plane* switches back to the ordinary viewer.

![Three-plane view](assets/screenshots/planes.png)

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
* **Several at once**: `Ctrl+A` selects all, `Ctrl+C` / `Ctrl+V` copy and paste, `Delete` removes the selection.
* **Right click** (long press on a touch screen) on an annotation opens its menu: *Info* (who created and edited it, area,
  position), *Change class*, *Crop to new image* and *Delete*.
* While you edit, the **area** (µm² or mm² when the image has a resolution) or the **length** is shown on the shape.
* Everything can be undone with `Ctrl+Z` and redone with `Ctrl+Shift+Z`.

![Annotating](assets/screenshots/viewer.png)

Annotation works on desktop and tablet (touch targets are large, drawing works with a pen); viewing also works on a phone.

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
