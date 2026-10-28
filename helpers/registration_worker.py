#!/usr/bin/env python3
"""Registration worker (kept for existing setups): the queue worker serving only the registration plugin
`qt-wsi-registration`. New setups use helpers/queue_worker.py, which hosts every plugin in helpers/plugins/.

    registration_worker.py --url http://localhost:8000 --user worker --password ... [--name w1] [--once]
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import queue_worker  # noqa: E402

if __name__ == "__main__":
    sys.exit(queue_worker.main(["--only", "quad", *sys.argv[1:]]))
