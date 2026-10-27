"""A software WebAuthn authenticator (ES256) for tests: creates and uses passkeys without a browser.

It speaks the browser-side JSON of the WebAuthn spec (base64url without padding), so the same code
exercises the Django `django-passkeys` endpoints and the Rust v2 passkey endpoints.
"""
import base64, hashlib, json, os, struct

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from fido2 import cbor
from fido2.cose import ES256


def b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def unb64u(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


class SoftKey:
    def __init__(self, rp_id, origin, key=None, credential_id=None):
        self.rp_id, self.origin = rp_id, origin
        self.key = key or ec.generate_private_key(ec.SECP256R1())
        self.credential_id = credential_id or os.urandom(32)
        self.counter = 0

    # -- (de)serialisation for fixtures
    def to_json(self):
        pem = self.key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode()
        return {"rp_id": self.rp_id, "origin": self.origin, "credential_id": b64u(self.credential_id), "private_key_pem": pem}

    @classmethod
    def from_json(cls, d, rp_id=None, origin=None):
        key = serialization.load_pem_private_key(d["private_key_pem"].encode(), None)
        return cls(rp_id or d["rp_id"], origin or d["origin"], key, unb64u(d["credential_id"]))

    # -- WebAuthn
    def _client_data(self, typ, challenge):
        return json.dumps({"type": typ, "challenge": challenge, "origin": self.origin, "crossOrigin": False}, separators=(",", ":")).encode()

    def credential_data(self):
        cose = cbor.encode(dict(ES256.from_cryptography_key(self.key.public_key())))
        return b"\x00" * 16 + struct.pack(">H", len(self.credential_id)) + self.credential_id + cose

    def create(self, options, flags=0x45):
        """options = `publicKey` of a registration begin response."""
        auth_data = hashlib.sha256(self.rp_id.encode()).digest() + bytes([flags]) + struct.pack(">I", 0) + self.credential_data()
        att = cbor.encode({"fmt": "none", "attStmt": {}, "authData": auth_data})
        cd = self._client_data("webauthn.create", options["challenge"])
        return {"id": b64u(self.credential_id), "rawId": b64u(self.credential_id), "type": "public-key",
                "response": {"attestationObject": b64u(att), "clientDataJSON": b64u(cd)},
                "clientExtensionResults": {}}

    def get(self, options, flags=0x05, rp_id=None, origin_override=None, challenge_override=None):
        self.counter += 1
        auth_data = hashlib.sha256((rp_id or self.rp_id).encode()).digest() + bytes([flags]) + struct.pack(">I", self.counter)
        cd = self._client_data("webauthn.get", challenge_override or options["challenge"])
        if origin_override:
            cd = json.dumps({"type": "webauthn.get", "challenge": options["challenge"], "origin": origin_override, "crossOrigin": False}, separators=(",", ":")).encode()
        sig = self.key.sign(auth_data + hashlib.sha256(cd).digest(), ec.ECDSA(hashes.SHA256()))
        return {"id": b64u(self.credential_id), "rawId": b64u(self.credential_id), "type": "public-key",
                "response": {"authenticatorData": b64u(auth_data), "clientDataJSON": b64u(cd), "signature": b64u(sig), "userHandle": None},
                "clientExtensionResults": {}}
