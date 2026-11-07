---
title: Home
layout: home
nav_order: 1
---

# EXACT-Rust

EXACT-Rust is a port of [EXACT](https://github.com/DeepMicroscopy/Exact), the annotation tool for microscopy images, to Rust:
**one binary plus PostgreSQL**, a new browser interface, and the same REST interface for
[exact-sync](https://github.com/DeepMicroscopy/EXACT-Sync) and machine-learning workers.

It runs against an existing EXACT (Django) database. The only changes are additive tables and columns, so Django can be
started again at any time.

![The viewer with annotations on a whole-slide image](assets/screenshots/viewer.png)

## What it does

| | |
|---|---|
| **Look at anything** | Whole-slide formats (OpenSlide), TIFF and BigTIFF, OME-TIFF z-stacks, NIfTI and DICOM volumes with a three-plane view, movies, CZI and VSI. Damaged TIFF pyramids can be repaired in place. |
| **Annotate quickly** | Click an annotation to select and edit it. The toolbox follows what is selected. One-click mode places fixed-size boxes. Polygons have a brush (add / erase area) and a knife (split). All old keyboard shortcuts work. |
| **Work in teams** | Teams, image sets, products and annotation types, invitations by link, passkeys or passwords. |
| **Register images** | Manual and automatic registration of image pairs, with a review of the result and overlays in the viewer. |
| **Run analyses** | Plugins and workers: a job queue with an atomic claim, progress and results back as annotations. |
| **Stay compatible** | `/api/v1` answers like the Django version, so exact-sync and existing notebooks keep working. `/api/v2` is the new interface. |

<div class="grid">
<img src="assets/screenshots/home.png" alt="Image sets of a team" width="49%">
<img src="assets/screenshots/imageset.png" alt="An image set with thumbnails" width="49%">
</div>

![Three-plane view of a CT volume](assets/screenshots/planes.png)

## Speed

![exact-rust against EXACT (Django): median response times](assets/performance-dark.svg)

Median response times of the same read-only requests, one at a time, on production-size data (24,169 images, 1.4 million annotations): exact-rust is 1.3 to 16 times faster than
the Django version, most for the lists that exact-sync and workers ask for (Django checks the password on every Basic-auth request). How it was measured, and the numbers, are in the
[README](https://github.com/DeepMicroscopy/Exact-Rust#speed).

## How it fits together

<figure class="diagram"><img src="assets/diagrams/system-overview.svg" alt="Browser, exact-sync and workers talk to one Rust binary that uses PostgreSQL, the image store, a cache and helper processes"><figcaption>One binary and PostgreSQL. The dots are requests; the dashed box is the optional, unchanged Django EXACT that can share the data.</figcaption></figure>

## Where to go next

| I want to... | Read |
|---|---|
| **start using it** | [User guide](user-guide), [the web interface and its workflow](ui-workflow), [keyboard shortcuts](shortcuts) |
| **set up a project with my colleagues** | [How to create a team and manage your images](howto-team) |
| **align two stains** | [How to use image registration](howto-registration) (with a short explanation of what registration is) |
| **run a team** | [Administration](administration) |
| **install it** | [Installation](DEPLOY), then [running next to the Django EXACT](coexistence) |
| **script it** | [API](api) with examples, the [QueueRunner claim](queuerunner-v2) |
| **add my own analysis** | [How to write a plugin](howto-plugin), [Plugins and workers](plugins) |
| **understand how it is built** | [Architecture](architecture), [file formats](file-formats) |
| **know what changed from EXACT** | [Changes from the Django version](django-differences) |
