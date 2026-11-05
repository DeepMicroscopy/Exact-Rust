"""settings_ref_db with the folders taken from the environment, so that Django and the Rust server can share one image store and one MEDIA_ROOT
(scripts/coexistence.sh)."""
import os

from settings_ref_db import *  # noqa

IMAGE_PATH = os.environ['IMAGE_PATH']
MEDIA_ROOT = os.environ['MEDIA_ROOT']
DATA_PATH = os.environ.get('DATA_PATH', DATA_PATH)  # noqa: F405
