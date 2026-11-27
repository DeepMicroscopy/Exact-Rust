"""run_isolated: a job runs in a process of its own, so that running out of memory or a crash in a C library fails the job and not the
worker. Run: python -m pytest tests/helpers"""
import os
import pathlib
import signal
import sys
import time

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "helpers"))
import queue_worker as qw  # noqa: E402


def test_the_result_comes_back():
    assert qw.run_isolated(lambda: {"a": [1, 2, 3], "blob": b"x" * 5_000_000}, poll=0.2)["blob"][:3] == b"xxx"


def test_an_exception_of_the_job_is_reported_with_its_traceback():
    def boom():
        raise ValueError("no such image")

    with pytest.raises(qw.JobFailed) as e:
        qw.run_isolated(boom, poll=0.2)
    assert "ValueError: no such image" in str(e.value) and "Traceback" in str(e.value)


def test_a_process_that_is_killed_or_ends_itself_fails_the_job_only():
    with pytest.raises(qw.JobFailed) as e:
        qw.run_isolated(lambda: os.kill(os.getpid(), signal.SIGKILL), poll=0.2)
    assert "SIGKILL" in str(e.value) and "ran out of memory" in str(e.value)
    # libjpeg's default error handler calls exit(): the process ends without a word
    with pytest.raises(qw.JobFailed) as e:
        qw.run_isolated(lambda: os._exit(1), poll=0.2)
    assert "exit code 1" in str(e.value)


def test_a_job_above_the_memory_limit_is_stopped(monkeypatch):
    monkeypatch.setattr(qw, "tree_rss", lambda pid: 50 * 2**30)
    started = time.time()
    with pytest.raises(qw.JobFailed) as e:
        qw.run_isolated(lambda: time.sleep(60), limit=8 * 2**30, poll=0.2)
    assert "more than 8 GB" in str(e.value) and "50 GB" in str(e.value)
    assert time.time() - started < 10


def test_the_memory_limit_follows_the_setting(monkeypatch):
    monkeypatch.setenv("EXACT_WORKER_MAX_GB", "12")
    assert qw.memory_limit() == 12 * 2**30
    monkeypatch.delenv("EXACT_WORKER_MAX_GB")
    limit = qw.memory_limit()
    assert limit is None or limit > 0


@pytest.mark.skipif(not os.path.isdir("/proc/self"), reason="needs /proc")
def test_the_memory_of_a_process_tree_is_read():
    assert qw.tree_rss(os.getpid()) > 10 * 2**20
