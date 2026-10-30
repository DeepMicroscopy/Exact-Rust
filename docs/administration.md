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
The Users tab (for administrators) lists everybody. **New user…** creates an account in one step:
* a **person**: user name, first and last name, e-mail (optional), the **teams** they belong to (they see the image sets of their teams) and whether they are
  **read only**. The password is shown once; instead you can create a **link** with which the person chooses their own password. Without any team the
  account sees no image sets;
* for superusers also a **worker** (a service account, see below) with its permissions.

Edit a user's name and e-mail, give them a **reset link** or a **random password** (shown once), deactivate, make read only or delete them.
The server can also let a superuser impersonate a user (`/api/v2/admin/users/{id}/impersonate`); there is no button for it yet.

**Read only** accounts (reviewers, guests, a test account) see everything their teams give them and can change nothing: the server refuses every create, change
and delete, whichever way the account signs in (the web interface, exact-sync, a token, an impersonation). In the interface they have no annotation tools, no
upload and no buttons that would fail, and the top bar says "read only". Signing out and managing their own passkeys still work. The flag is kept in a table of
this server's own (`exact_rust_user_flags`), so EXACT (Django) itself does not know it: while a database is also used by the old EXACT, a read-only account is
only read-only on this server.

These roles are in play, and the table shows them in plain words:

| Role | Meaning |
|---|---|
| **Administrator** (the "site admin" flag) | Manages users: activate and deactivate, reset passwords, delete, invite into any team, sees the Users tab and the plugin overview. Superusers can switch it on and off. |
| **Edits profiles** (Django: "staff") | May change other users' names and e-mail addresses. |
| **Full rights** (Django: "superuser") | Holds every permission without being granted it, can hand out roles and permissions, create worker accounts, delete annotation types, and touch other superusers. Set by the database or by another superuser. |
| **Read only** | Not a role of rights but a restriction: the account can look, not change (see above). Administrators set it. |
| **Team admin** (Teams tab) | Manages one team: members, invitations, name. |

What a user can see is decided by their teams, not by these roles: a superuser sees only the images of their own teams.

## Workers
Analysis and registration are done by a separate process, usually the Python queue worker (`helpers/queue_worker.py`). It logs in like a
user, so it needs an account. **Users → New worker account…** (superusers) creates one in a single step:

1. a user name and **what the worker does**: *Registration worker* or *Analysis worker (ML plugin)*. The dialog lists the permissions that
   kind of worker gets (a registration worker: `processing.add_plugin`, `processing.change_pluginjob`, `images.change_imageregistration`);
2. the **teams whose images it serves**. A worker is offered jobs for the images of its own teams only, so choose every team it should work for;
3. **Create account**: the user name and a random password are shown once, as the two lines for the env file
   (`WORKER_USER=…`, `WORKER_PASSWORD=…`). Put them in `deploy/exact.env` and restart the worker.

The same permissions are available for any account: **Users → Permissions** (superusers) shows the permissions by model with the presets on
top (*Use* replaces the ticks), and *Save* applies them at once. Permissions that an account has through a group are shown, not changed.
Reading images and annotations needs no model permission here; the list covers what an account may change.

The worker announces its plugin (`POST /api/v2/plugins/register`), claims jobs atomically and reports progress. Unmodified QueueRunner
scripts keep working through `/api/v1`; see [the claim](queuerunner-v2).

## Image repair and storage
The server writes into the image store (uploads, move, delete, repair, crop), so back up `IMAGE_PATH` and `MEDIA_ROOT` like the
database. Thumbnails in `EXACT_CACHE_DIR` can be deleted at any time; inflated NIfTI volumes in `EXACT_NIFTI_CACHE` grow and are
safe to delete too.
