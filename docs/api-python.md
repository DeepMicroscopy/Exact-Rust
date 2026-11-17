---
title: API with Python
nav_order: 8.5
---

# Using the API with Python

The [API page](api) shows every call with `curl`. This page does the same work in **Python**, with the [`requests`](https://requests.readthedocs.io) library (`pip install requests`; the upload example also uses Pillow, `pip install pillow`). The examples are one story, from logging in to cleaning up, and every block was run against a server in the order they appear here (the printed results are real, shortened where they are long). The page is also a test: `tests/conformance/test_docs_python_examples.py` runs its code blocks, so they stay true.

They use **v2**, the interface for new scripts. If you already work with exact-sync (v1), see [the v1 section of the API page](api#apiv1-for-exact-sync) and the end of this page.

## Setup: a session and one small helper

Put the address and the credentials in the environment, never in the script. HTTP Basic needs no CSRF header, which makes it the easy choice for scripts:

```python
import os
import time
import requests

URL = os.environ.get("EXACT_URL", "https://exact.example.org")
s = requests.Session()
s.auth = (os.environ.get("EXACT_USER", "alice"), os.environ["EXACT_PASSWORD"])   # HTTP Basic


class ApiError(Exception):
    """A 4xx or 5xx answer: `status` and the JSON `body` ({"detail": ..., "errors": {...}} for a validation error)."""

    def __init__(self, r):
        self.status = r.status_code
        self.body = r.json() if r.headers.get("content-type", "").startswith("application/json") else r.text
        super().__init__(f"{r.request.method} {r.request.path_url}: {self.status} {self.body}")


def api(method, path, **kwargs):
    """One call. Returns the answer as JSON (None for 204 No Content) and raises ApiError for an error."""
    r = s.request(method, URL + path, timeout=60, **kwargs)
    if r.status_code >= 400:
        raise ApiError(r)
    return r.json() if r.content else None


me = api("GET", "/api/v2/auth/me")
print(me["username"], me["is_superuser"])
```
```text
alice True
```

Two other ways to sign in:

* **A personal access token** (*Preferences → Access tokens*, or see [below](#a-limited-token-for-a-script)): `s.auth = None; s.headers["Authorization"] = "Bearer " + os.environ["EXACT_TOKEN"]`. This is what you give a script that runs unattended, because it can be limited and revoked.
* **A session**, as the web interface does it. Then every request that *changes* something needs the CSRF token from the login in a header:

```python
web = requests.Session()
login = web.post(f"{URL}/api/v2/auth/login", json={"username": s.auth[0], "password": s.auth[1]})
web.headers["x-csrf-token"] = login.json()["csrf_token"]
print(web.get(f"{URL}/api/v2/auth/me").json()["username"])
```
```text
alice
```

## Reading: lists and paging

Lists answer `{"items": [...], "next_cursor": "..."}`; pass the cursor back to get the next page. `fields` keeps only the fields you need, which makes big lists much faster. A generator hides the paging:

```python
def pages(path, **params):
    """Every item of a list, page by page."""
    while True:
        d = api("GET", path, params=params)
        yield from d["items"]
        if not d.get("next_cursor"):
            return
        params = {**params, "cursor": d["next_cursor"]}


names = [t["name"] for t in pages("/api/v2/annotation-types", fields="id,name", limit=3)]
print(len(names), names[:3])
```
```text
9 ['Annotation', 'TestSegmentation', 'Simple annotation BB']
```

Filters are the field names (`image=2`, `annotation_type=5`); `?omit=images` drops a field, `?expand=` expands references.

## A team, a product, annotation types and an image set

The creator of a team becomes its administrator. `vector_type` is `1` box, `2` point, `3` line, `4` polyline, `5` polygon, `6` fixed-size box, `7` global (a label for the whole image), `8` segmentation mask:

```python
team = api("POST", "/api/v2/teams", json={"name": "Docs Demo Team"})
product = api("POST", "/api/v2/products", json={"name": "Mitosis study", "team": team["id"]})
mitosis = api("POST", "/api/v2/annotation-types", json={
    "name": "Mitotic figure", "product": product["id"], "vector_type": 6, "color_code": "#ff3355",
    "default_width": 50, "default_height": 50, "size_unit": "px"})
focus = api("POST", "/api/v2/annotation-types", json={
    "name": "Out of focus", "product": product["id"], "vector_type": 7, "color_code": "#3355ff"})
image_set = api("POST", "/api/v2/image-sets", json={"name": "Study images", "team": team["id"], "products": [product["id"]]})
print(team["id"], product["id"], mitosis["id"], focus["id"], image_set["id"])
```
```text
4 5 10 11 7
```

## Uploading images

`POST /api/v2/image-sets/{id}/images` takes any number of files in one multipart request (field name `files`). A ZIP is unpacked, and `.svs`, `.ndpi`, `.tiff`, `.mrxs` (with its folder in a ZIP) and the other [formats](file-formats) work the same way. To keep this page self-contained the example makes a small picture; for a slide, open your file instead (`files={"files": open("slide.svs", "rb")}`; give the sizes of the pieces to `requests` as it does by itself, no `Content-Type` header of your own):

```python
import io
from PIL import Image

picture = io.BytesIO()
Image.new("RGB", (4000, 3000), "#b08fb0").save(picture, "PNG")
picture.seek(0)
uploaded = api("POST", f"/api/v2/image-sets/{image_set['id']}/images", files={"files": ("demo.png", picture, "image/png")})
image = uploaded["items"][0]
print(image)
```
```text
{'id': 121, 'name': 'demo.png', 'size': 42237, 'type': 'image'}
```

## Annotations

### Create one, safely

Coordinates are pixels of the full-resolution image. A `unique_identifier` of your own makes the call **safe to repeat**: the same identifier a second time answers with the annotation that exists, so a script that lost the connection can simply send it again:

```python
import uuid

box = {"x1": 100, "y1": 100, "x2": 180, "y2": 160}
uid = str(uuid.uuid4())
first = api("POST", "/api/v2/annotations", json={"image": image["id"], "annotation_type": mitosis["id"], "vector": box, "unique_identifier": uid})
again = api("POST", "/api/v2/annotations", json={"image": image["id"], "annotation_type": mitosis["id"], "vector": box, "unique_identifier": uid})
print(first["id"], again["id"] == first["id"], first["vector"])
```
```text
57 True {'x1': 100, 'x2': 180, 'y1': 100, 'y2': 160}
```

### Read them

```python
for annotation in pages("/api/v2/annotations", image=image["id"], fields="id,annotation_type,vector"):
    print(annotation)
```
```text
{'annotation_type': 10, 'id': 57, 'vector': {'x1': 100, 'x2': 180, 'y1': 100, 'y2': 160}}
```

### Edit, but not over somebody else's edit

Send the `last_edit_time` you read as `expected_last_edit_time`. If somebody changed the annotation meanwhile, the server answers `409` and puts the annotation **as it is now** into the answer, so you can decide what to do (here: keep theirs):

```python
def move(annotation_id, vector):
    current = api("GET", f"/api/v2/annotations/{annotation_id}")
    try:
        return api("PATCH", f"/api/v2/annotations/{annotation_id}",
                   json={"vector": vector, "expected_last_edit_time": current["last_edit_time"]})
    except ApiError as e:
        if e.status == 409:
            return e.body["current"]
        raise


print(move(first["id"], {"x1": 110, "y1": 110, "x2": 190, "y2": 170})["vector"])

try:   # a stale time, as if somebody had edited in between
    api("PATCH", f"/api/v2/annotations/{first['id']}", json={"vector": box, "expected_last_edit_time": "2020-01-01T00:00:00Z"})
except ApiError as e:
    print(e.status, sorted(e.body))
```
```text
{'x1': 110, 'x2': 190, 'y1': 110, 'y2': 170}
409 ['current', 'detail']
```

Without `expected_last_edit_time` an edit is unconditional.

### Verify, delete, undo

Writing an annotation never verifies it; that is a separate act (by a second person, if the image set asks for it). A `DELETE` is a *soft* delete that can be undone; `?hard=true` removes the row for good:

```python
api("POST", f"/api/v2/annotations/{first['id']}/verify", json={"verified": True})
api("DELETE", f"/api/v2/annotations/{first['id']}")                            # 204
api("PATCH", f"/api/v2/annotations/{first['id']}", json={"deleted": False})    # undo
print(api("GET", f"/api/v2/annotations/{first['id']}")["deleted"])
```
```text
False
```

### A mistake: validation errors

The vector is checked against the type of the annotation (a box needs `x2 - x1 >= 1` and `y2 - y1 >= 1`, a polygon at least three points, ...). A refusal is a `400` with the reason per field:

```python
try:
    api("POST", "/api/v2/annotations", json={"image": image["id"], "annotation_type": mitosis["id"], "vector": {"x1": 5, "y1": 5, "x2": 5, "y2": 9}})
except ApiError as e:
    print(e.status, e.body["errors"])
```
```text
400 {'vector': ['The vector is not valid for this annotation type.']}
```

### Labels of a whole image, or of one frame

A *global* annotation (type `7`) labels the whole image, so it has no coordinates: send `null` (or `{}`). On a stack, a volume or a movie it may name the **frame** it is for, counted from 1; there is one label per image, type and frame, so sending it again does not duplicate it, and every frame can have its own:

```python
whole = api("POST", "/api/v2/annotations", json={"image": image["id"], "annotation_type": focus["id"], "vector": None})
frame3 = api("POST", "/api/v2/annotations", json={"image": image["id"], "annotation_type": focus["id"], "vector": {"frame": 3}})
frame3_again = api("POST", "/api/v2/annotations", json={"image": image["id"], "annotation_type": focus["id"], "vector": {"frame": 3}})
print(whole["vector"], frame3["vector"], frame3_again["id"] == frame3["id"], whole["id"] != frame3["id"])
```
```text
None {'frame': 3} True True
```

To unset a label, delete it (`DELETE /api/v2/annotations/{id}`); setting it again on that frame brings the same annotation back.

## A picture of a region

`GET /images/image/centered_snapshot/{image}/{cx}/{cy}/{w}/{h}/` answers the region of the slide at full resolution, centred on a pixel, exactly `w` × `h` pixels (up to 8192; PNG, or `?format=jpeg`). It is made for cutting out patches around annotations:

```python
x, y = 2000, 1500
r = s.get(f"{URL}/images/image/centered_snapshot/{image['id']}/{x}/{y}/512/512/", timeout=60)
with open("patch.png", "wb") as f:
    f.write(r.content)
print(r.status_code, r.headers["content-type"], Image.open("patch.png").size)
```
```text
200 image/png (512, 512)
```

## A limited token for a script

A script should not hold your password. Make it a **personal access token** that can do only what the script needs and expires. A token is made with your password or a signed-in session (a token cannot make tokens); `scopes` are `jobs`, `annotate`, `images` and `catalog`, and a token without scopes can do everything you can:

```python
made = api("POST", "/api/v2/me/tokens", json={"name": "annotator script", "expires_in_days": 30, "scopes": ["annotate"]})
token = made["token"]            # shown this once: the server keeps only a hash of it

script = requests.Session()
script.headers["Authorization"] = "Bearer " + token
look = script.get(f"{URL}/api/v2/auth/me")
annotate = script.post(f"{URL}/api/v2/annotations", json={
    "image": image["id"], "annotation_type": mitosis["id"], "vector": {"x1": 300, "y1": 300, "x2": 350, "y2": 350}})
other = script.post(f"{URL}/api/v2/image-sets", json={"name": "not allowed", "team": team["id"]})
print(look.status_code, annotate.status_code, other.status_code, other.json()["detail"])
```
```text
200 201 403 This token is limited and may not do this.
```

Revoke it when the script is retired, or at once if it leaks; it stops working immediately:

```python
api("DELETE", f"/api/v2/me/tokens/{made['id']}")
print(script.get(f"{URL}/api/v2/auth/me").status_code)
```
```text
403
```

## Registration and analyses

Queueing a registration (also with DeeperHistReg) and waiting for the result is shown in [Queue a registration with DeeperHistReg and wait for it](api#queue-a-registration-with-deeperhistreg-and-wait-for-it), with the same `requests` style as here. The calls for analyses are `POST /api/v2/images/{id}/analyze` and `GET /api/v2/jobs`; see [Plugins and workers](plugins).

## Cleaning up

An image set, a team and the rest are deleted with `DELETE` on their address (the image set first, because a team with image sets cannot go). Deleting an image removes its file as well:

```python
api("DELETE", f"/api/v2/images/{image['id']}")                         # 204
api("DELETE", f"/api/v2/image-sets/{image_set['id']}")
for resource, item in [("annotation-types", mitosis), ("annotation-types", focus), ("products", product), ("teams", team)]:
    api("DELETE", f"/api/v2/{resource}/{item['id']}")
print("done")
```
```text
done
```

## What the answers mean

| Status | Meaning | In the examples |
|---|---|---|
| `200`, `201`, `204` | done; created; done without a body | `api()` returns the JSON, or `None` for `204` |
| `202` | accepted: a job was queued (registration, analysis) | poll the job address in the answer |
| `400` | the request is wrong; `errors` names the fields | `ApiError.body["errors"]` |
| `401`, `403` | not signed in, or not allowed (also a token that is revoked, expired or limited) | `ApiError.status` |
| `404` | it does not exist, or you may not see it | |
| `409` | somebody changed it meanwhile; `current` is the object as it is now | `move()` above |

## With exact-sync (v1)

Existing programs that use [exact-sync](https://github.com/DeepMicroscopy/EXACT-Sync) keep working. It speaks v1, which Rust answers exactly like Django, including deleting an image with the generated client (`DELETE /api/v1/images/images/{id}/`):

<!-- no-run -->
```python
import os
from exact_sync.v1.api_client import ApiClient
from exact_sync.v1.api.images_api import ImagesApi
from exact_sync.v1.configuration import Configuration

cfg = Configuration()
cfg.host, cfg.username, cfg.password = "https://exact.example.org", "alice", os.environ["EXACT_PASSWORD"]
images_api = ImagesApi(ApiClient(cfg))

image = images_api.create_image(file_path="slide.svs", image_type=0, image_set=7).results[0]   # upload
images_api.destroy_image(str(image.id))                                                         # delete: returns None
```
