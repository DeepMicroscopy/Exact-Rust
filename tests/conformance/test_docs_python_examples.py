"""The Python examples of docs/api-python.md run against the server under test, in the order of the page (Rust only). A block that
cannot run here (it needs a slide file, or the exact-sync package) is marked with `<!-- no-run -->` just before it."""
import os
import pathlib
import re

import httpx
import pytest
from common import BASE, PW

pytestmark = pytest.mark.skipif(httpx.get(BASE + "/api/version").status_code != 200, reason="server has no /api/version (Django)")

PAGE = pathlib.Path(__file__).resolve().parents[2] / "docs" / "api-python.md"


def blocks():
    out = []
    for m in re.finditer(r"(<!-- no-run -->\n)?```python\n(.*?)```", PAGE.read_text(), re.S):
        if not m.group(1):
            out.append(m.group(2))
    return out


def test_the_python_examples_of_the_api_page_run(tmp_path, monkeypatch, capsys):
    pytest.importorskip("requests")
    pytest.importorskip("PIL")
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("EXACT_URL", BASE)
    monkeypatch.setenv("EXACT_USER", "aubreville")
    monkeypatch.setenv("EXACT_PASSWORD", PW)
    code = blocks()
    assert len(code) >= 12
    ns = {"__name__": "docs_example"}
    try:
        for i, block in enumerate(code):
            try:
                exec(compile(block, f"api-python.md block {i + 1}", "exec"), ns)
            except Exception as e:
                raise AssertionError(f"block {i + 1} of api-python.md failed: {e}\n{block}") from e
    finally:
        # what a failed run leaves behind must not stop the next one: the demo objects are named alike
        s = ns.get("s")
        if s is not None:
            base = ns["URL"]
            for resource, key in (("image-sets", "Study images"), ("annotation-types", "Mitotic figure"), ("annotation-types", "Out of focus"),
                                  ("products", "Mitosis study"), ("teams", "Docs Demo Team")):
                for item in s.get(f"{base}/api/v2/{resource}", params={"limit": 500, "fields": "id,name"}).json().get("items", []):
                    if item["name"] == key:
                        s.delete(f"{base}/api/v2/{resource}/{item['id']}")
    out = capsys.readouterr().out
    assert "Out of focus" not in out and (tmp_path / "patch.png").exists()
