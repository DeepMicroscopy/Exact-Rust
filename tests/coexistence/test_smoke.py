"""Both servers are up on the same database and see the same data."""
from coex import BOTH, DB, django, rust, sql


def test_both_servers_answer():
    for s in BOTH:
        assert s.basic("rt_member").get("/api/v1/users/users/").status_code == 200, s.name


def test_they_read_the_same_database():
    ids = {s.name: sorted(i["id"] for i in s.basic("aubreville").get("/api/v1/images/image_sets/", params={"limit": 1000}).json()["results"]) for s in BOTH}
    assert ids["django"] == ids["rust"] and ids["django"], ids
    assert len(ids["django"]) == sql("select count(*) n from images_imageset")[0]["n"]
