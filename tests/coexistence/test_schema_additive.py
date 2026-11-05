"""What `exact-cli migrate` did to the shared database must not be able to hurt Django, which keeps writing to it: it may only ADD. Compares the
migrated database with a pristine restore of the same dump."""
from coex import DB, PRISTINE, sql

COLUMNS = "select table_name t, column_name c, data_type ty, is_nullable n, column_default d, character_maximum_length l from information_schema.columns where table_schema = 'public'"
CONSTRAINTS = ("select conrelid::regclass::text t, conname c, contype ty, pg_get_constraintdef(oid) def from pg_constraint where connamespace = 'public'::regnamespace")
INDEXES = "select tablename t, indexname i, indexdef def from pg_indexes where schemaname = 'public'"


def by(rows, *keys):
    return {tuple(r[k] for k in keys): r for r in rows}


def test_no_table_column_or_type_of_django_is_removed_or_changed():
    before, after = by(sql(COLUMNS, PRISTINE), "t", "c"), by(sql(COLUMNS, DB), "t", "c")
    gone = sorted(set(before) - set(after))
    assert not gone, f"columns removed: {gone}"
    changed = [(k, before[k], after[k]) for k in before if before[k] != after[k]]
    assert not changed, f"columns changed: {changed}"


def test_new_columns_of_django_tables_do_not_stop_django_from_inserting():
    # a column Django's model does not know is left out of its INSERT: it must be nullable or have a default
    before_tables = {r["t"] for r in sql(COLUMNS, PRISTINE)}
    before = by(sql(COLUMNS, PRISTINE), "t", "c")
    new = [r for r in sql(COLUMNS, DB) if r["t"] in before_tables and (r["t"], r["c"]) not in before]
    bad = [f"{r['t']}.{r['c']}" for r in new if r["n"] == "NO" and r["d"] is None]
    assert not bad, f"NOT NULL columns without default on Django tables: {bad}"


def test_no_constraint_or_index_of_django_is_dropped_or_changed():
    for what, key in ((CONSTRAINTS, ("t", "c")), (INDEXES, ("t", "i"))):
        before, after = by(sql(what, PRISTINE), *key), by(sql(what, DB), *key)
        assert not (set(before) - set(after)), f"dropped: {sorted(set(before) - set(after))}"
        assert not [k for k in before if before[k] != after[k]], f"changed: {[k for k in before if before[k] != after[k]]}"


def test_no_new_constraint_on_a_django_table_that_a_django_write_could_violate():
    before_tables = {r["t"] for r in sql(COLUMNS, PRISTINE)}
    before = by(sql(CONSTRAINTS, PRISTINE), "t", "c")
    new = [r for r in sql(CONSTRAINTS, DB) if r["t"] in before_tables and (r["t"], r["c"]) not in before]
    # NOT NULL is not a constraint here; a new CHECK / UNIQUE / EXCLUDE on a Django table could reject a row Django writes. (A FOREIGN KEY on a
    # Django table to one of ours does not exist: ours point at theirs.)
    assert not new, f"new constraints on Django tables: {new}"


def test_no_new_unique_index_on_a_django_table():
    before_tables = {r["t"] for r in sql(COLUMNS, PRISTINE)}
    before = by(sql(INDEXES, PRISTINE), "t", "i")
    new = [r for r in sql(INDEXES, DB) if r["t"] in before_tables and (r["t"], r["i"]) not in before]
    bad = [r for r in new if "UNIQUE" in r["def"].upper()]
    assert not bad, f"unique indexes added to Django tables: {bad}"


def test_our_tables_never_block_django_from_deleting_rows():
    # a foreign key from one of our tables to a Django table must cascade (or null) on delete, or Django's `image.delete()` /
    # `imageset.delete()` / `user.delete()` fails with an integrity error as soon as we have a row that points at it
    before_tables = {r["t"] for r in sql(COLUMNS, PRISTINE)}
    rows = sql(
        "select c.conrelid::regclass::text t, c.conname n, c.confrelid::regclass::text target, c.confdeltype d "
        "from pg_constraint c where c.contype = 'f' and c.connamespace = 'public'::regnamespace",
        DB,
    )
    blocking = [r for r in rows if r["t"] not in before_tables and r["target"] in before_tables and r["d"] in ("a", "r")]
    assert not blocking, "foreign keys that would block a Django delete (ON DELETE NO ACTION / RESTRICT): " + ", ".join(f"{r['t']}.{r['n']} -> {r['target']}" for r in blocking)


def test_no_trigger_was_added_to_a_django_table():
    before_tables = {r["t"] for r in sql(COLUMNS, PRISTINE)}
    rows = sql("select event_object_table t, trigger_name n from information_schema.triggers where trigger_schema = 'public'", DB)
    assert not [r for r in rows if r["t"] in before_tables], rows


def test_the_migration_state_of_django_is_untouched():
    q = "select app, name from django_migrations order by app, name"
    # the pristine copy went through Django's own `migrate` (a Django checkout newer than the dump needs it), the Rust migration must not have
    # marked anything as applied that Django alone would not have
    mine, ref = {(r["app"], r["name"]) for r in sql(q, DB)}, {(r["app"], r["name"]) for r in sql(q, PRISTINE)}
    assert mine <= ref, f"the Rust migration marked Django migrations as applied: {sorted(mine - ref)}"


def test_the_rows_of_django_tables_are_not_rewritten_by_the_migration():
    # the migration may add rows to its own tables, the data of Django's own tables stays as it was
    for t in ("images_image", "annotations_annotation", "users_user", "images_imageset", "users_team"):
        cols = ", ".join(r["c"] for r in sql(f"select column_name c from information_schema.columns where table_name = '{t}' and table_schema='public' order by 1", PRISTINE))
        # only the columns that existed before; users_user is compared without the columns the seeding and the tests change (last_login, password, date_joined)
        skip = {"last_login", "password", "date_joined"} if t == "users_user" else set()
        cols = ", ".join(f'"{c}"' for c in cols.split(", ") if c not in skip)
        # the rows that were in the dump (the tests add their own rows later)
        top = sql(f"select max(id) m from {t}", PRISTINE)[0]["m"]
        q = f"select md5(string_agg(t::text, '' order by id)) m from (select {cols} from {t} where id <= {top}) t"
        assert sql(q, DB)[0]["m"] == sql(q, PRISTINE)[0]["m"], t
