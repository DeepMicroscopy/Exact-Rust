"""Writes to /api/v1/users/teams/ (EXACT PR 169): the name is the only field a client writes, the relations are read-only. Both servers have to
answer the same, and a team made by one is the other's team."""
import json

from coex import BOTH, django, rust, sql

URL = "/api/v1/users/teams"
U = "rt_perm"  # member of the first team, with add/change/delete_team


def own_team():
    return sql("select t.id, t.name from users_team t join users_teammembership m on m.team_id = t.id join users_user u on u.id = m.user_id "
               f"where u.username = '{U}' order by t.id limit 1")[0]


def relations(team):
    return {
        "image_sets": sql(f"select id from images_imageset where team_id = {team} order by id"),
        "products": sql(f"select id from administration_product where team_id = {team} order by id"),
        "memberships": sql(f"select id, team_id from users_teammembership where team_id = {team} order by id"),
    }


def both(method, path, user=U, **kw):
    out = {}
    for s in BOTH:
        r = s.basic(user).request(method, f"{URL}{path}", **kw)
        try:
            body = r.json()
        except Exception:
            body = r.text[:200]
        out[s.name] = (r.status_code, body)
    return out


def same_status_and_errors(res):
    d, r = res["django"], res["rust"]
    assert d[0] == r[0], json.dumps(res, indent=1, default=str)
    if d[0] >= 400:
        assert d[1] == r[1], json.dumps(res, indent=1, default=str)
    return d[0]


def test_create_with_only_a_name_makes_the_creator_admin_on_both():
    created = {}
    for s in BOTH:
        name = f"coex-{s.name}-team"
        r = s.basic(U).post(f"{URL}/", json={"name": name})
        assert r.status_code == 201, f"{s.name}: {r.status_code} {r.text[:300]}"
        body = r.json()
        assert body["name"] == name and set(body) == {"id", "name", "members", "image_sets", "product_set", "memberships"}, body
        # Django answers with the serializer data of before it adds the creator
        assert body["members"] == [] and body["memberships"] == [], body
        created[s.name] = body["id"]
        rows = sql(f"select m.is_admin, u.username from users_teammembership m join users_user u on u.id = m.user_id where m.team_id = {body['id']}")
        assert rows == [{"is_admin": True, "username": U}], rows
    # each team is the other server's team as well
    for s in BOTH:
        for tid in created.values():
            r = s.basic(U).get(f"{URL}/{tid}/")
            assert r.status_code == 200 and r.json()["members"], f"{s.name}: {r.status_code} {r.text[:200]}"


def test_create_checks_the_name_like_django():
    for body in ({}, {"name": ""}, {"name": None}, {"name": "ab"}, {"name": "x" * 101}, {"name": [1]}, {"name": own_team()["name"]}):
        assert same_status_and_errors(both("POST", "/", json=body)) == 400, body


def test_create_needs_the_model_permission():
    assert same_status_and_errors(both("POST", "/", user="rt_member", json={"name": "coex-denied"})) == 403
    assert not sql("select 1 as x from users_team where name = 'coex-denied'")


def test_put_with_empty_relations_keeps_image_sets_products_and_memberships():
    t = own_team()
    before = relations(t["id"])
    assert before["image_sets"] and before["memberships"], "the fixture team needs image sets and memberships"
    for s in BOTH:
        r = s.basic(U).put(f"{URL}/{t['id']}/", json={"name": t["name"], "image_sets": [], "product_set": [], "memberships": [], "members": []})
        assert r.status_code == 200, f"{s.name}: {r.status_code} {r.text[:300]}"
        assert relations(t["id"]) == before, s.name
        assert sorted(r.json()["image_sets"]) == [i["id"] for i in before["image_sets"]]


def test_patch_with_another_teams_membership_moves_nothing():
    t = own_team()
    foreign = sql(f"select id, team_id from users_teammembership where team_id <> {t['id']} order by id limit 1")[0]
    for s in BOTH:
        r = s.basic(U).patch(f"{URL}/{t['id']}/", json={"memberships": [foreign["id"]]})
        assert r.status_code == 200, f"{s.name}: {r.status_code} {r.text[:300]}"
        assert sql(f"select team_id from users_teammembership where id = {foreign['id']}")[0]["team_id"] == foreign["team_id"], s.name


def test_rename_by_put_and_patch_and_their_errors():
    made = {}
    for s in BOTH:
        made[s.name] = s.basic(U).post(f"{URL}/", json={"name": f"coex-ren-{s.name}"}).json()["id"]
    for s in BOTH:
        c, tid = s.basic(U), made[s.name]
        assert c.put(f"{URL}/{tid}/", json={"name": f"coex-put-{s.name}"}).json()["name"] == f"coex-put-{s.name}"
        assert c.patch(f"{URL}/{tid}/", json={"name": f"coex-pat-{s.name}"}).json()["name"] == f"coex-pat-{s.name}"
        assert c.patch(f"{URL}/{tid}/", json={}).status_code == 200
        r = c.put(f"{URL}/{tid}/", json={})
        assert r.status_code == 400 and r.json() == {"name": ["This field is required."]}, f"{s.name}: {r.text}"
        r = c.patch(f"{URL}/{tid}/", json={"name": own_team()["name"]})
        assert r.status_code == 400 and "already exists" in r.text, f"{s.name}: {r.text}"
        assert sql(f"select name from users_team where id = {tid}")[0]["name"] == f"coex-pat-{s.name}"


def test_a_team_of_someone_else_is_not_found_and_unknown_ids_too():
    other = sql("select id from users_team where id not in (select team_id from users_teammembership m join users_user u on u.id = m.user_id "
                f"where u.username = '{U}') order by id limit 1")[0]["id"]
    for tid in (other, 999999):
        assert same_status_and_errors(both("PATCH", f"/{tid}/", json={"name": "coex-nope"})) == 404
        assert same_status_and_errors(both("PUT", f"/{tid}/", json={"name": "coex-nope"})) == 404


def test_a_name_between_31_and_100_characters_is_accepted_by_both():
    # the model's validator says 30, the serializer enforces the field's 100
    for s in BOTH:
        r = s.basic(U).post(f"{URL}/", json={"name": ("y" * 40) + s.name})
        assert r.status_code == 201, f"{s.name}: {r.status_code} {r.text[:200]}"
