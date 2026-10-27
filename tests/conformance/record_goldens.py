"""Record golden responses for every role against a reference server (Django): `python record_goldens.py [dir]`."""
import json, pathlib, sys
from common import BASE, USERS, client, endpoints, fetch, normalize

out = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else pathlib.Path(__file__).parent / "goldens" / "django")
out.mkdir(parents=True, exist_ok=True)
n = 0
for user in USERS:
    with client(user) as c:
        golden = {}
        # discover endpoints as the *superuser* so every role is asked about the same objects
        with client("aubreville") as admin:
            eps = list(endpoints(admin))
        for name, path, params in eps:
            golden[name] = {"path": path, "params": params, **fetch(c, path, params)}
            n += 1
        (out / f"{user}.json").write_text(json.dumps(golden, indent=1, sort_keys=True, default=str))
import resource_cases
from common import collections as all_collections
resource = {}
with client("aubreville") as admin:
    for col in all_collections():
        r = admin.get(f"/api/v1/{col}/", params={"limit": 1})
        items = r.json().get("results", []) if r.status_code == 200 else []
        # sample from the first item that has data in most fields (richer cases), else the first
        r2 = admin.get(f"/api/v1/{col}/", params={"limit": 5})
        cands = r2.json().get("results", []) if r2.status_code == 200 else items
        if not cands:
            continue
        item = max(cands, key=lambda i: sum(1 for v in i.values() if v not in (None, [], "", {})))
        for case_name, params in resource_cases.cases_for(col, item):
            for role in resource_cases.ROLES:
                params = resource_cases.with_full_limit(col, params)
                with client(role) as c:
                    resp = c.get(f"/api/v1/{col}/", params=params)
                if resp.status_code == 500:
                    continue  # Django bug (e.g. deleted=<bool> on annotations); not reproduced
                try:
                    body = normalize(resp.json())
                except Exception:
                    body = {"_non_json_len": len(resp.content)}
                resource[f"{role}:{col}:{case_name}"] = {"path": f"/api/v1/{col}/", "params": params, "user": role, "status": resp.status_code, "body": body}
import gzip
with gzip.open(out / "resource_cases.json.gz", "wt", compresslevel=9) as fh:  # 90 MB as plain JSON
    fh.write(json.dumps(resource, indent=1, sort_keys=True, default=str))
n += len(resource)
import auth_cases
res = {name: {"case": [auth_cases.CASES[name][0], auth_cases.CASES[name][1], auth_cases.CASES[name][2]], **auth_cases.run(name)} for name in auth_cases.CASES}
(out / "auth_cases.json").write_text(json.dumps(res, indent=1, sort_keys=True, default=str))
n += len(res)
print(f"recorded {n} responses from {BASE} into {out}")
