"""Helper for the Rust server: converts points through the pickled quad tree of a registration (`qt-wsi-registration`).

    registration_helper.py convert <pickle file>        reads [[x, y], ...] as JSON on stdin, prints the converted points

Needs `qt-wsi-registration` in the Python it runs with (REGISTRATION_PYTHON) and REGISTRATION_EXACT_DIR in the server's environment.
The server starts it only for registrations that have a pickle (`images_imageregistration.file`); registrations that
have just a matrix are converted by the server itself.
"""
import json
import os
import pickle
import sys

# the pickled tree holds EXACT's slide objects (`util.slide_server`, ...): they unpickle only with EXACT's code on the path
# (`python -I` ignores PYTHONPATH, hence REGISTRATION_EXACT_DIR: the `exact` folder of an EXACT checkout)
if os.environ.get("REGISTRATION_EXACT_DIR"):
    sys.path.insert(0, os.environ["REGISTRATION_EXACT_DIR"])


def main() -> int:
    if len(sys.argv) != 3 or sys.argv[1] != "convert":
        print(__doc__, file=sys.stderr)
        return 2
    with open(sys.argv[2], "rb") as f:
        qt = pickle.load(f)
    points = json.load(sys.stdin)
    boxes = qt.transform_boxes([[x, y, 0, 0] for x, y in points])
    json.dump([[float(b[0]), float(b[1])] for b in boxes], sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
