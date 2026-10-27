"""Generated per-resource cases: every filter parameter Django's FilterSets accept (tests/conformance/filters.json, dumped by
reference/dump-filters.sh), with sample values taken from the real data, plus `expand`/`fields`/`omit`, pagination and
invalid values. Recorded from Django, replayed against Rust, for several roles."""
import json, pathlib

FILTERS = json.loads((pathlib.Path(__file__).parent / "filters.json").read_text())
ROLES = ["aubreville", "rt_member", "rt_outsider"]
# filter parameters whose name differs from the serializer field
FIELD_OF = {"image__image_set": "image", "image__image_type": None, "verified_by": None, "annotationversion": None, "product": None,
            "imagesets": "imagesets", "annotationtype": None, "set_versions": None, "images": "images"}
EXPANDABLE_SKIP = {"vector", "meta_data", "screening_tiles", "transformation_matrix", "get_scale", "get_inv_scale", "inv_matrix"}


def sample_params(coll, item, admin_items):
    """Yield (case name suffix, params list) for one collection."""
    params = []
    spec = FILTERS.get(coll)
    if not isinstance(spec, list):
        return
    for entry in spec:
        pname, cls = entry[0], entry[1]
        base = pname.split("__")[0]
        field = FIELD_OF.get(pname, base)
        val = item.get(field) if field else None
        if cls == "NumberFilter" and val is not None and not isinstance(val, (list, dict)):
            params.append((pname, [(pname, str(val))]))
        elif cls in ("CharFilter",) and isinstance(val, str) and val:
            if pname.endswith("__contains"):
                params.append((pname, [(pname, val[1:-1] or val)]))
            else:
                params.append((pname, [(pname, val)]))
        elif cls == "BooleanFilter" and isinstance(item.get(base), bool):
            params.append((pname + "=1", [(pname, "true" if item[base] else "false")]))
            params.append((pname + "=0", [(pname, "false" if item[base] else "true")]))
        elif cls in ("DateTimeFilter", "IsoDateTimeFilter") and isinstance(val, str):
            if pname.endswith("__contains"):
                continue
            params.append((pname, [(pname, val)]))
        elif cls == "UUIDFilter" and isinstance(val, str):
            params.append((pname, [(pname, val)]))
        elif cls == "UUIDInFilter" and isinstance(item.get("unique_identifier"), str):
            params.append((pname, [(pname, item["unique_identifier"])]))
        elif cls == "NumberInFilter" and isinstance(item.get(base), (int, float)):
            params.append((pname, [(pname, f"{item[base]},{item[base] + 1000}")]))
        elif cls == "CharInFilter" and isinstance(item.get(base), str):
            params.append((pname, [(pname, f"{item[base]},nonexistent-name")]))
        elif cls == "NumberRangeFilter" and isinstance(item.get(base), (int, float)):
            params.append((pname, [(pname, f"{item[base] - 1},{item[base] + 1}")]))
            params.append((pname + "-empty", [(pname, f"{item[base] + 100},{item[base] + 200}")]))
        elif cls in ("DateTimeRangeFilter", "IsoDateTimeRangeFilter"):
            params.append((pname, [(pname, "2000-01-01,2100-01-01")]))
            params.append((pname + "-empty", [(pname, "2000-01-01,2000-01-02")]))
        elif cls in ("ModelChoiceFilter",) and isinstance(item.get(field), int):
            params.append((pname, [(pname, str(item[field]))]))
            params.append((pname + "-invalid", [(pname, "999999")]))
        elif cls == "ModelChoiceInFilter" and isinstance(item.get(base), int):
            params.append((pname, [(pname, f"{item[base]},{item[base]}")]))
        elif cls == "ModelMultipleChoiceFilter":
            v = item.get(field)
            if isinstance(v, list) and v:
                params.append((pname, [(pname, str(v[0]))]))
                if len(v) > 1:
                    params.append((pname + "-multi", [(pname, str(v[0])), (pname, str(v[1]))]))
            elif isinstance(v, int):
                params.append((pname, [(pname, str(v))]))
            params.append((pname + "-invalid", [(pname, "999999")]))
        elif cls == "ChoiceFilter" and isinstance(item.get(base), int):
            params.append((pname, [(pname, str(item[base]))]))
            params.append((pname + "-invalid", [(pname, "77")]))
    # method filters / specials that do not map to a field by name
    extras = {
        "images/images": [("annotation_type", [("annotation_type", "1")]), ("num_annotations_min", [("num_annotations_min", "1")]),
                          ("num_annotations_max", [("num_annotations_max", "0")]), ("verified-true", [("verified", "true")]),
                          ("verified-false", [("verified", "false")])],
        "annotations/annotations": [("vector_type", [("vector_type", "1")]), ("vector__isnull", [("vector__isnull", "true")]),
                                    ("meta_data__isnull-false", [("meta_data__isnull", "false")]), ("vector_x_max", [("vector_x_max", "100000")]),
                                    ("vector_y_min", [("vector_y_min", "0")]), ("deleted=false", [("deleted", "false")])],
        "annotations/annotation_versions": [("has_changes", [("has_changes", "true")])],
        "processing/plugins": [("imageset_from_image_id", [("imageset_from_image_id", str(item.get("id", 1)))])],
        "processing/pluginjobs": [("image_id", [("image_id", "1")]), ("user_id", [("user_id", "1")]), ("filter_ids", [("filter_ids", "1,2,3")])],
        "processing/pluginresults": [("image_id", [("image_id", "1")]), ("job_id", [("job_id", "1")]), ("plugin_id", [("plugin_id", "1")])],
        "processing/pluginresultannotations": [("image", [("image", "1")]), ("plugin", [("plugin", "1")])],
        "processing/pluginresultbitmaps": [("image", [("image", "1")])],
    }.get(coll, [])
    for n, p in extras:
        params.append((n, p))
    for name, p in params:
        yield "filter/" + name, p


# Django lists these without ORDER BY (physical order); pagination windows cannot be compared, full lists can
UNORDERED_IN_DJANGO = {"images/images", "annotations/log_image_actions"}


def cases_for(coll, item):
    out = []
    if coll not in UNORDERED_IN_DJANGO:
        out.append(("page/limit1-offset1", [("limit", "1"), ("offset", "1")]))
        out.append(("page/limit0", [("limit", "0")]))
    for name, p in sample_params(coll, item, None):
        out.append((name, p))
    keys = [k for k, v in item.items() if k not in EXPANDABLE_SKIP and (isinstance(v, list) or (isinstance(v, int) and not isinstance(v, bool) and k != "id"))]
    for k in keys:
        out.append((f"expand/{k}", [("expand", k)]))
    if len(keys) >= 2:
        out.append(("expand/two", [("expand", ",".join(keys[:2]))]))
    out.append(("flex/fields-id", [("fields", "id")]))
    if keys:
        out.append(("flex/omit", [("omit", ",".join(keys[:2]))]))
        out.append(("flex/expand+fields", [("expand", keys[0]), ("fields", f"id,{keys[0]}")]))
    return out


def with_full_limit(coll, params):
    """Compare complete result sets (order-independent) unless the case is about pagination."""
    if any(k == "limit" for k, _ in params):
        return params
    return list(params) + [("limit", "1000000")]
