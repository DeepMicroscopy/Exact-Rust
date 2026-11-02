import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "helpers"))
sys.modules.setdefault("slideio", type(sys)("slideio"))  # only vsi_path is tested, not the reader
from slideio_helper import vsi_path  # noqa: E402


def test_the_folder_the_scanner_named_is_found(tmp_path):
    (tmp_path / "_slide_1_").mkdir()
    vsi = tmp_path / "slide-1.vsi"
    vsi.write_bytes(b"index")
    linked = vsi_path(str(vsi))
    assert os.path.basename(linked) == "slide_1.vsi"
    assert os.path.isdir(os.path.join(os.path.dirname(linked), "_slide_1_"))


def test_matching_names_and_other_formats_are_left_alone(tmp_path):
    (tmp_path / "_a-b_").mkdir()
    assert vsi_path(str(tmp_path / "a-b.vsi")) == str(tmp_path / "a-b.vsi")
    assert vsi_path(str(tmp_path / "x.czi")) == str(tmp_path / "x.czi")
    assert vsi_path(str(tmp_path / "none.vsi")) == str(tmp_path / "none.vsi")
