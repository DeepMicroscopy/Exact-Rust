"""Auth/paging/filter cases with explicit credentials, recorded from Django and replayed against Rust.

Only requests that do not change data (writes that are *refused* are fine).
"""
import base64
import httpx
from common import BASE, PW, normalize

TOK = {
    "full": "pat_rtfull000001.secret-full", "readonly": "pat_rtreadonly01.secret-ro", "team1": "pat_rtteam100001.secret-team1",
    "revoked": "pat_rtrevoked001.secret-rev", "expired": "pat_rtexpired001.secret-exp",
}


def basic(user, pw=PW):
    return {"Authorization": "Basic " + base64.b64encode(f"{user}:{pw}".encode()).decode()}


def bearer(t):
    return {"Authorization": f"Bearer {t}"}


U = "/api/v1/users/users/"
T = "/api/v1/users/teams/"
M = "/api/v1/users/team_membership/"

CASES = {
    # authentication
    "anon/users": ("GET", U, {}, {}, None),
    "anon/timesync": ("GET", "/timesync/", {}, {}, None),
    "basic/wrong-password": ("GET", U, {}, basic("rt_member", "nope"), None),
    "basic/unknown-user": ("GET", U, {}, basic("nobody"), None),
    "basic/inactive-user": ("GET", U, {}, basic("rt_inactive"), None),
    "basic/argon2": ("GET", U, {}, basic("rt_argon"), None),
    "basic/bcrypt_sha256": ("GET", U, {}, basic("rt_bcrypt"), None),
    "basic/pbkdf2_sha1": ("GET", U, {}, basic("rt_sha1"), None),
    "basic/malformed-header": ("GET", U, {}, {"Authorization": "Basic !!!"}, None),
    "other-scheme": ("GET", U, {}, {"Authorization": "Token abc"}, None),
    "bearer/full": ("GET", U, {}, bearer(TOK["full"]), None),
    "bearer/readonly-get": ("GET", U, {}, bearer(TOK["readonly"]), None),
    "bearer/readonly-post": ("POST", T, {}, bearer(TOK["readonly"]), {"name": "should-not-exist"}),
    "bearer/readonly-delete": ("DELETE", T + "1/", {}, bearer(TOK["readonly"]), None),
    "bearer/team1": ("GET", T, {}, bearer(TOK["team1"]), None),
    "bearer/revoked": ("GET", U, {}, bearer(TOK["revoked"]), None),
    "bearer/expired": ("GET", U, {}, bearer(TOK["expired"]), None),
    "bearer/wrong-secret": ("GET", U, {}, bearer("pat_rtfull000001.wrong"), None),
    "bearer/unknown-prefix": ("GET", U, {}, bearer("pat_unknownprefx.secret"), None),
    "bearer/no-pat-format": ("GET", U, {}, bearer("abc"), None),
    "bearer/too-many-parts": ("GET", U, {}, {"Authorization": "Bearer a b"}, None),
    # model permissions (DjangoModelPermissions): refused writes only
    "perm/member-post-team": ("POST", T, {}, basic("rt_member"), {"name": "should-not-exist"}),
    "perm/member-put-team": ("PUT", T + "1/", {}, basic("rt_member"), {"name": "x"}),
    "perm/member-patch-team": ("PATCH", T + "1/", {}, basic("rt_member"), {"name": "x"}),
    "perm/member-delete-team": ("DELETE", T + "1/", {}, basic("rt_member"), None),
    "perm/member-post-user": ("POST", U, {}, basic("rt_member"), {"username": "x"}),
    "perm/member-post-membership": ("POST", M, {}, basic("rt_member"), {"team": 1, "user": 5}),
    "perm/anon-post-team": ("POST", T, {}, {}, {"name": "x"}),
    # listing: pagination, filters, flex fields
    "page/limit2": ("GET", U, {"limit": 2}, basic("aubreville"), None),
    "page/limit2-offset2": ("GET", U, {"limit": 2, "offset": 2}, basic("aubreville"), None),
    "page/offset-past-end": ("GET", U, {"limit": 2, "offset": 100}, basic("aubreville"), None),
    "page/limit0": ("GET", U, {"limit": 0}, basic("aubreville"), None),
    "page/bad-limit": ("GET", U, {"limit": "x"}, basic("aubreville"), None),
    "filter/username": ("GET", U, {"username": "rt_member"}, basic("aubreville"), None),
    "filter/username-contains": ("GET", U, {"username__contains": "rt_"}, basic("aubreville"), None),
    "filter/is-staff": ("GET", U, {"is_staff": "true"}, basic("aubreville"), None),
    "filter/is-active-false": ("GET", U, {"is_active": "false"}, basic("aubreville"), None),
    "filter/team": ("GET", U, {"team": 3}, basic("aubreville"), None),
    "filter/id": ("GET", U, {"id": 4}, basic("aubreville"), None),
    "filter/bad-id": ("GET", U, {"id": "x"}, basic("aubreville"), None),
    "filter/unknown-param": ("GET", U, {"nonsense": "1"}, basic("aubreville"), None),
    "teams/filter-name-contains": ("GET", T, {"name__contains": "Team"}, basic("aubreville"), None),
    "teams/filter-members": ("GET", T, {"members": 6}, basic("aubreville"), None),
    "teams/filter-memberships": ("GET", T, {"memberships": 8}, basic("aubreville"), None),
    "memberships/filter-team": ("GET", M, {"team": 1}, basic("aubreville"), None),
    "memberships/filter-is-admin": ("GET", M, {"is_admin": "true"}, basic("aubreville"), None),
    "memberships/filter-user": ("GET", M, {"user": 3}, basic("aubreville"), None),
    "flex/fields": ("GET", U, {"fields": "id,username"}, basic("aubreville"), None),
    "flex/omit": ("GET", U, {"omit": "team_set,is_staff"}, basic("aubreville"), None),
    "flex/expand-team_set": ("GET", U, {"expand": "team_set", "limit": 2}, basic("aubreville"), None),
    "flex/expand-members": ("GET", T, {"expand": "members"}, basic("aubreville"), None),
    "flex/expand-memberships": ("GET", T, {"expand": "memberships"}, basic("aubreville"), None),
    "flex/expand-membership-team-user": ("GET", M, {"expand": "team,user", "limit": 3}, basic("aubreville"), None),
    "flex/expand-and-fields": ("GET", T, {"expand": "members", "fields": "id,members"}, basic("aubreville"), None),
    "flex/expand-unknown": ("GET", U, {"expand": "nonsense"}, basic("aubreville"), None),
    # detail
    "detail/user-self": ("GET", U + "4/", {}, basic("rt_teamadmin"), None),
    "detail/user-not-visible": ("GET", U + "1/", {}, basic("rt_member"), None),
    "detail/user-missing": ("GET", U + "9999/", {}, basic("aubreville"), None),
    "detail/team-ok": ("GET", T + "1/", {}, basic("rt_member"), None),
    "detail/team-not-member": ("GET", T + "2/", {}, basic("rt_member"), None),
    "detail/team-expand": ("GET", T + "1/", {"expand": "members"}, basic("rt_member"), None),
    "detail/membership-ok": ("GET", M + "1/", {}, basic("rt_member"), None),
    "detail/membership-hidden": ("GET", M + "3/", {}, basic("rt_member"), None),
    "detail/non-integer": ("GET", U + "abc/", {}, basic("aubreville"), None),
}


# token scoping applies to *every* resource (User.team_set is narrowed to the token's teams)
from common import collections as _collections
for _col in _collections():
    CASES[f"scope/team1-token/{_col}"] = ("GET", f"/api/v1/{_col}/", {"limit": 1000000}, bearer(TOK["team1"]), None)
    CASES[f"scope/readonly-token/{_col}"] = ("GET", f"/api/v1/{_col}/", {"limit": 1000000}, bearer(TOK["readonly"]), None)

# legacy endpoints: parameters and permission edge cases
_L = "/images/api/imageset/load/"
for _fid in ("1", "5", "Unverified", "Verified", "NoAnnotations", "ComputerGenerated", "Other"):
    CASES[f"legacy/imageset_load/filter={_fid}"] = ("GET", _L, {"image_set_id": 1, "filter_annotation_type_id": _fid}, basic("aubreville"), None)
CASES["legacy/imageset_load/no-param"] = ("GET", _L, {}, basic("aubreville"), None)
CASES["legacy/imageset_load/bad-param"] = ("GET", _L, {"image_set_id": "x"}, basic("aubreville"), None)
CASES["legacy/imageset_load/missing"] = ("GET", _L, {"image_set_id": 9999}, basic("aubreville"), None)
CASES["legacy/imageset_load/outsider"] = ("GET", _L, {"image_set_id": 1}, basic("rt_outsider"), None)
CASES["legacy/imageset_load/other-team-member"] = ("GET", _L, {"image_set_id": 5}, basic("rt_member"), None)
CASES["legacy/imageset_load/token-other-team"] = ("GET", _L, {"image_set_id": 5}, bearer(TOK["team1"]), None)
CASES["legacy/imageset_load/anon"] = ("GET", _L, {"image_set_id": 1}, {}, None)
for _u in ("aubreville", "rt_member", "rt_outsider"):
    CASES[f"legacy/list_imagesets/{_u}"] = ("GET", "/images/api/list_imagesets/", {}, basic(_u), None)
CASES["legacy/list_imagesets/name-body"] = ("POST", "/images/api/list_imagesets/", {}, basic("aubreville"), {"name": "Whole"})
CASES["legacy/list_imagesets/team-body"] = ("POST", "/images/api/list_imagesets/", {}, basic("aubreville"), {"team": {"id": 2}})
CASES["legacy/list_imagesets/id-body"] = ("POST", "/images/api/list_imagesets/", {}, basic("aubreville"), {"id": 3})
CASES["legacy/list_imagesets/public-body"] = ("POST", "/images/api/list_imagesets/", {}, basic("aubreville"), {"public": False})
CASES["legacy/list_imagesets/anon"] = ("GET", "/images/api/list_imagesets/", {}, {}, None)
_A = "/annotations/api/annotation/load/"
for _name, _p in {"basic": {"image_id": 41}, "all": {"image_id": 2}, "deleted": {"image_id": 2, "include_deleted": "1"}, "vector_type": {"image_id": 2, "vector_type": 1},
                  "since": {"image_id": 2, "since": 1000000000}, "box": {"image_id": 2, "min_x": 0, "min_y": 0, "max_x": 100000, "max_y": 100000},
                  "missing": {"image_id": 99999}, "bad": {"image_id": "x"}, "no-param": {}}.items():
    for _u in ("aubreville", "rt_outsider"):
        CASES[f"legacy/annotation_load/{_name}/{_u}"] = ("GET", _A, _p, basic(_u), None)
CASES["legacy/annotation_load/token-other-team"] = ("GET", _A, {"image_id": 90}, bearer(TOK["team1"]), None)
_T = "/annotations/api/annotation/loadannotationtypes/"
for _p in ({}, {"imageset_id": 1}, {"imageset_id": 5}, {"imageset_id": 9999}):
    for _u in ("aubreville", "rt_outsider"):
        CASES[f"legacy/loadannotationtypes/{_p}/{_u}"] = ("GET", _T, _p, basic(_u), None)
for _u in ("aubreville", "rt_member", "rt_outsider"):
    CASES[f"legacy/team_filter/{_u}"] = ("GET", "/users/api/team/filter/", {}, basic(_u), None)
CASES["legacy/team_filter/token-team1"] = ("GET", "/users/api/team/filter/", {}, bearer(TOK["team1"]), None)
# DRF details
CASES["v1/unknown-resource"] = ("GET", "/api/v1/users/nothing/", {}, basic("aubreville"), None)
CASES["v1/processing/detail-missing"] = ("GET", "/api/v1/processing/pluginjobs/99999/", {}, basic("rt_outsider"), None)
CASES["v1/processing/outsider-sees-all-jobs"] = ("GET", "/api/v1/processing/pluginjobs/", {}, basic("rt_outsider"), None)
CASES["v1/processing/job-expand-result"] = ("GET", "/api/v1/processing/pluginjobs/", {"expand": "result,creator"}, basic("rt_member"), None)
CASES["v1/processing/result-expand-entries"] = ("GET", "/api/v1/processing/pluginresults/", {"expand": "entries,plugin,job,image"}, basic("rt_member"), None)
CASES["v1/processing/entry-expand-all"] = ("GET", "/api/v1/processing/pluginresultentrys/", {"expand": "annotation_results,bitmap_results,pluginresult"}, basic("rt_member"), None)
CASES["v1/processing/plugin-expand"] = ("GET", "/api/v1/processing/plugins/", {"expand": "results,products"}, basic("rt_member"), None)


def run(name):
    method, path, params, headers, body = CASES[name]
    r = httpx.request(method, BASE + path, params=params, headers=headers, json=body, timeout=60)
    try:
        b = normalize(r.json())
    except Exception:
        b = {"_non_json_len": len(r.content), "_ctype": r.headers.get("content-type", "")}
    keep = {k: v for k, v in r.headers.items() if k.lower() in ("www-authenticate", "allow")}
    return {"status": r.status_code, "body": b, "headers": keep}
