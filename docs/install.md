---
title: Installation
nav_order: 1.5
has_children: true
---

# Installation

Which guide you follow depends on one question: **do you already run EXACT (the Django version)?**

| | Your situation | Guide | Time |
|---|---|---|---|
| **No** | You want to start annotating with EXACT-Rust; there is no data to bring along. | [Start from scratch](quickstart) | about 30 minutes, most of it the first build |
| **Yes** | You have an EXACT installation with users, image sets and annotations and want to move it to EXACT-Rust. | [Moving from EXACT](from-exact) | an afternoon to try it on a copy; the switch itself is gradual |

Both run EXACT-Rust with Docker: one image for the server (and the optional workers) plus PostgreSQL.

**What is the same in both cases:** EXACT-Rust uses EXACT's database layout. A new installation gets that layout created on its first start;
an existing EXACT database is used as it is, plus a few tables of its own. That is also why a new installation can later be
opened with the Django EXACT, and an existing one can go back to Django at any time.

The detailed reference for operators (GPU, plugins, performance on large stores, the production setup next to Django) is
[Reference: beta and production](DEPLOY); the tests for running both servers on the same data are in [Running next to Django](coexistence).
