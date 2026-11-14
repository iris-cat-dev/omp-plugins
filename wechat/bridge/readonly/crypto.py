"""Authenticated SQLCipher-4/WCDB pages, without native runtime or key discovery.

PBKDF2, page layout and AES logic adapted from wechatauto-replica
wechatauto/db.py, https://github.com/fanyuantaier/wechatauto-replica.
Changes: authenticate every page, fixed safe errors, no extraction,
no process/native imports and no persisted keys.
"""
import hashlib
import hmac
import struct
from dataclasses import dataclass

from .errors import ReaderError

PAGE_SIZE = 4096
RESERVE_SIZE = 80
SQLITE_HEADER = b"SQLite format 3\x00"


def pbkdf2(key: bytes, salt: bytes, iterations: int) -> bytes:
    return hashlib.pbkdf2_hmac("sha512", key, salt, iterations, dklen=32)


@dataclass(frozen=True, repr=False)
class PageCipher:
    key: bytes
    mac_key: bytes
    plaintext_header: bool = False

    @classmethod
    def from_input(cls, supplied: bytes, first: bytes):
        if len(first) != PAGE_SIZE:
            raise ReaderError("INVALID_DATABASE")
        if len(supplied) == 48:
            candidates = [(supplied[:32], supplied[32:], True)]
        else:
            salt = first[:16]
            candidates = [(supplied, salt, False), (None, salt, False)]
        for key, salt, plaintext_header in candidates:
            if key is None:
                key = pbkdf2(supplied, salt, 256000)
            cipher = cls(key, pbkdf2(key, bytes(b ^ 0x3A for b in salt), 2), plaintext_header)
            if cipher.authenticated(first, 1):
                return cipher
        raise ReaderError("INVALID_KEY")

    def authenticated(self, page: bytes, number: int) -> bool:
        if len(page) != PAGE_SIZE or not 1 <= number <= 0xFFFFFFFF:
            return False
        start = 16 if number == 1 else 0
        digest = hmac.new(self.mac_key, page[start:PAGE_SIZE - 64] + struct.pack("<I", number), hashlib.sha512).digest()
        return hmac.compare_digest(digest, page[-64:])

    def decrypt(self, page: bytes, number: int) -> bytes:
        if not self.authenticated(page, number):
            raise ReaderError("INVALID_DATABASE")
        try:
            from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
        except ImportError:
            raise ReaderError("DEPENDENCY_MISSING") from None
        start = 16 if number == 1 else 0
        iv = page[PAGE_SIZE - RESERVE_SIZE:PAGE_SIZE - 64]
        decryptor = Cipher(algorithms.AES(self.key), modes.CBC(iv)).decryptor()
        plaintext = decryptor.update(page[start:PAGE_SIZE - RESERVE_SIZE]) + decryptor.finalize()
        header = (page[:16] if self.plaintext_header else SQLITE_HEADER) if number == 1 else b""
        return header + plaintext + bytes(RESERVE_SIZE)
