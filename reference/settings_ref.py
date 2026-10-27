"""Reference-Django settings for the Rust port's conformance/perf baselines.

Runs the unmodified EXACT code from ~/code/Exact against the restored scratch DB
(exact_rust_test) and a private instance dir, so the live image folder is only ever
read through symlinks (logs, tile caches, uploads never land in it).
"""
import os
from exact.settings import *  # noqa

_HERE = os.path.dirname(os.path.abspath(__file__))
IMAGE_PATH = os.path.join(_HERE, 'instance', 'images')
MEDIA_ROOT = os.path.join(_HERE, 'instance', 'media')
DATA_PATH = os.path.join(_HERE, 'instance', 'data')
LOGGING['handlers']['file_info']['filename'] = os.path.join(_HERE, 'instance', 'exact_info.log')
DATABASES['default'].update(NAME='exact_rust_test', HOST='127.0.0.1')
DEBUG = False
ALLOWED_HOSTS = ['127.0.0.1', 'localhost']
EMAIL_BACKEND = 'django.core.mail.backends.filebased.EmailBackend'
EMAIL_FILE_PATH = os.path.join(_HERE, 'instance', 'mail')

PASSWORD_HASHERS = [
    'django.contrib.auth.hashers.PBKDF2PasswordHasher',
    'django.contrib.auth.hashers.PBKDF2SHA1PasswordHasher',
    'django.contrib.auth.hashers.Argon2PasswordHasher',
    'django.contrib.auth.hashers.BCryptSHA256PasswordHasher',
]

# Passkeys: WebAuthn only allows https origins or http://localhost, so the scratch instance uses "localhost".
FIDO_SERVER_ID = "localhost"
FIDO_SERVER_NAME = "EXACT"
ALLOWED_HOSTS = ['127.0.0.1', 'localhost']
