"""settings_ref with the database name taken from SQL_DATABASE (settings_ref pins it to exact_rust_test)."""
import os

from settings_ref import *  # noqa

DATABASES['default']['NAME'] = os.environ['SQL_DATABASE']
