---
title: Administration
nav_order: 4
---

# Administration
**Administration** (top right) has four tabs. Team administrators see their own teams; superusers see everything.

## Teams
Create, rename and delete teams, add existing users, tick *team admin*, and remove members. **Invite someone…** creates a
link for a new user; open invitations are listed and can be revoked.

## Products
Products group annotation types. Each type has a name (unique per product), colour, vector type (box, fixed-size box, point,
line, polygon, global …), a default size for fixed-size boxes in pixels, µm or mm, and a key `1`–`9`. An image set uses the types
of its products.

## Plugins
Lists the analysis and registration plugins that workers have announced, with the worker that served them last. Plugins register
themselves when a worker starts.

## Users
Create users and edit their name and e-mail, see their teams, whether they are active or staff and when they last logged in,
and give them a **reset link** or a **random password** (shown once). The server can also let a superuser impersonate a user
(`/api/v2/admin/users/{id}/impersonate`); there is no button for it yet.

## Workers
Analysis and registration are done by a separate process, usually the Python queue worker (`helpers/queue_worker.py`):

```
python helpers/queue_worker.py --url https://exact.example.org --user worker --password … --exact-dir /opt/exact/exact
```

The account needs the permissions `processing.change_pluginjob` and `images.change_imageregistration`. The worker announces its
plugin (`POST /api/v2/plugins/register`), claims jobs atomically and reports progress. Unmodified QueueRunner scripts keep
working through `/api/v1`; see [the claim](queuerunner-v2).

## Image repair and storage
The server writes into the image store (uploads, move, delete, repair, crop), so back up `IMAGE_PATH` and `MEDIA_ROOT` like the
database. Thumbnails in `EXACT_CACHE_DIR` can be deleted at any time; inflated NIfTI volumes in `EXACT_NIFTI_CACHE` grow and are
safe to delete too.
