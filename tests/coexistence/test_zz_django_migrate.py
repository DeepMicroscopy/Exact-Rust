"""The day Django is updated (or just migrated) on the database the Rust server has already migrated: Django's own `migrate` must go through on top of
the columns and tables the Rust migration added, and the Rust migration must go through again on top of Django's."""
import os
import subprocess

from coex import DB, sql

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


def django_manage(*args):
    env = dict(os.environ, SQL_DATABASE=DB, DJANGO_SETTINGS_MODULE="settings_ref_coexist")
    return subprocess.run([os.path.join(ROOT, "reference", "run-django.sh"), *args], capture_output=True, text=True, env=env, timeout=600)


def test_django_check_is_clean_on_the_migrated_database():
    r = django_manage("check")
    assert r.returncode == 0, r.stdout[-800:] + r.stderr[-800:]


def test_django_migrate_goes_through_on_top_of_the_rust_migration_and_is_then_a_no_op():
    r = django_manage("migrate", "--noinput")
    assert r.returncode == 0, "Django's migrate failed on the database the Rust migration had already changed:\n" + r.stdout[-1500:] + r.stderr[-1500:]
    r = django_manage("migrate", "--check")
    assert r.returncode == 0, "Django still has migrations to apply after migrate:\n" + r.stdout[-800:] + r.stderr[-800:]


def test_the_rust_migration_goes_through_again_on_top_of_djangos():
    env = dict(os.environ, SQL_DATABASE=DB)
    r = subprocess.run(["cargo", "run", "-q", "-p", "exact-cli", "--", "migrate", "--confirm-db", DB], capture_output=True, text=True, env=env, cwd=ROOT, timeout=900)
    assert r.returncode == 0, r.stdout[-800:] + r.stderr[-1500:]


def test_both_servers_still_serve_after_all_migrations():
    from coex import BOTH

    for s in BOTH:
        assert s.basic("rt_member").get("/api/v1/images/image_sets/").status_code == 200, s.name
    assert sql("select count(*) n from images_image")[0]["n"] > 0
