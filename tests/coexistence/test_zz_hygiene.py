"""After everything above: nothing is left hanging in the database that could stall the other server."""
from coex import sql


def test_no_session_is_idle_in_a_transaction_and_no_lock_is_waiting():
    import time

    time.sleep(1)
    idle = sql("select pid, application_name, state, left(query, 80) q from pg_stat_activity where datname = current_database() and state like 'idle in transaction%'")
    assert not idle, idle
    waiting = sql("select l.pid, l.locktype, l.mode from pg_locks l join pg_stat_activity a on a.pid = l.pid where not l.granted and a.datname = current_database()")
    assert not waiting, waiting


def test_the_two_servers_together_stay_well_below_the_connection_limit():
    limit = int(sql("select setting from pg_settings where name = 'max_connections'")[0]["setting"])
    used = sql("select count(*) n from pg_stat_activity where datname = current_database()")[0]["n"]
    assert used < limit * 0.6, f"{used} of {limit} connections in use by two idle servers (Rust's pool + Django); production's own limit is shared with other clients"
