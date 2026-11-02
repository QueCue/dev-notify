"""本机系统凭据：Windows 用户级 DPAPI、macOS Keychain。不经命令行传递秘密。"""

import ctypes
import json
import os
import re
import sys
from pathlib import Path

SERVICE = b"dev-notify.credentials.v1"
FIELDS = {"telegram_token", "feishu_webhook", "feishu_secret"}


class CredentialError(ValueError):
    """只使用安全摘要，不包含系统返回的原始凭据或文件正文。"""


def validate_id(identifier: str) -> None:
    if not isinstance(identifier, str) or not re.fullmatch(r"[0-9a-f]{32}", identifier):
        raise CredentialError("系统凭据引用无效")


def decode_bundle(raw: bytes) -> dict[str, str]:
    try:
        values = json.loads(raw.decode("utf-8"))
        if (not isinstance(values, dict) or set(values) - FIELDS
                or any(not isinstance(v, str) for v in values.values())):
            raise ValueError()
        return values
    except (ValueError, UnicodeError):
        raise CredentialError("系统凭据内容无效；请重新运行配置向导") from None


def dpapi(data: bytes, *, decrypt: bool = False) -> bytes:
    from ctypes import wintypes

    class Blob(ctypes.Structure):
        _fields_ = [("size", wintypes.DWORD), ("data", ctypes.POINTER(ctypes.c_ubyte))]

    crypt = ctypes.WinDLL("crypt32", use_last_error=True)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    function = crypt.CryptUnprotectData if decrypt else crypt.CryptProtectData
    function.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.POINTER(Blob),
                         ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
    function.restype = wintypes.BOOL
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    kernel.LocalFree.restype = ctypes.c_void_p
    buffer = ctypes.create_string_buffer(data)
    source = Blob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte)))
    output = Blob()
    # CRYPTPROTECT_UI_FORBIDDEN；不使用 LOCAL_MACHINE，绑定当前用户。
    if not function(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(output)):
        raise CredentialError("DPAPI 操作失败；请使用原 Windows 用户，或重新配置凭据")
    try:
        return ctypes.string_at(output.data, output.size)
    finally:
        kernel.LocalFree(output.data)


class WindowsStore:
    def __init__(self, config_path: Path):
        self.directory = config_path.parent / "credentials"

    def _path(self, identifier: str) -> Path:
        validate_id(identifier)
        return self.directory / (identifier + ".dpapi")

    def read(self, identifier: str) -> bytes:
        try:
            path = self._path(identifier)
            with path.open("rb") as stream:
                data = stream.read(1024 * 1024 + 1)
            if len(data) > 1024 * 1024:
                raise CredentialError("DPAPI 凭据文件过大")
            return dpapi(data, decrypt=True)
        except OSError:
            raise CredentialError("无法读取 DPAPI 凭据；文件缺失或权限不足") from None

    def write(self, identifier: str, data: bytes) -> None:
        path = self._path(identifier)
        encrypted = dpapi(data)
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(encrypted)
                stream.flush()
                os.fsync(stream.fileno())
        except BaseException:
            path.unlink(missing_ok=True)
            raise

    def delete(self, identifier: str) -> None:
        self._path(identifier).unlink(missing_ok=True)


class MacStore:
    def __init__(self, *, interactive: bool = False):
        self.interactive = interactive

    def _api(self):
        security = ctypes.CDLL("/System/Library/Frameworks/Security.framework/Security")
        core = ctypes.CDLL("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
        pointer = ctypes.c_void_p
        uint = ctypes.c_uint32
        security.SecKeychainSetUserInteractionAllowed.argtypes = [ctypes.c_ubyte]
        security.SecKeychainSetUserInteractionAllowed.restype = ctypes.c_int32
        security.SecKeychainFindGenericPassword.argtypes = [pointer, uint, ctypes.c_char_p,
            uint, ctypes.c_char_p, ctypes.POINTER(uint), ctypes.POINTER(pointer), ctypes.POINTER(pointer)]
        security.SecKeychainFindGenericPassword.restype = ctypes.c_int32
        security.SecKeychainAddGenericPassword.argtypes = [pointer, uint, ctypes.c_char_p,
            uint, ctypes.c_char_p, uint, pointer, ctypes.POINTER(pointer)]
        security.SecKeychainAddGenericPassword.restype = ctypes.c_int32
        security.SecKeychainItemFreeContent.argtypes = [pointer, pointer]
        security.SecKeychainItemFreeContent.restype = ctypes.c_int32
        security.SecKeychainItemDelete.argtypes = [pointer]
        security.SecKeychainItemDelete.restype = ctypes.c_int32
        core.CFRelease.argtypes = [pointer]
        core.CFRelease.restype = None
        status = security.SecKeychainSetUserInteractionAllowed(self.interactive)
        self._check(status)
        return security, core

    @staticmethod
    def _check(status: int) -> None:
        if status:
            raise CredentialError("Keychain 操作失败；请解锁登录钥匙串并允许本程序访问，或重新配置")

    def read(self, identifier: str) -> bytes:
        validate_id(identifier)
        security, _ = self._api()
        account = identifier.encode("ascii")
        length, password = ctypes.c_uint32(), ctypes.c_void_p()
        status = security.SecKeychainFindGenericPassword(None, len(SERVICE), SERVICE, len(account),
            account, ctypes.byref(length), ctypes.byref(password), None)
        self._check(status)
        try:
            return ctypes.string_at(password, length.value)
        finally:
            security.SecKeychainItemFreeContent(None, password)

    def write(self, identifier: str, data: bytes) -> None:
        validate_id(identifier)
        security, _ = self._api()
        account = identifier.encode("ascii")
        buffer = ctypes.create_string_buffer(data)
        status = security.SecKeychainAddGenericPassword(None, len(SERVICE), SERVICE, len(account),
            account, len(data), buffer, None)
        self._check(status)

    def delete(self, identifier: str) -> None:
        validate_id(identifier)
        security, core = self._api()
        account = identifier.encode("ascii")
        item = ctypes.c_void_p()
        status = security.SecKeychainFindGenericPassword(None, len(SERVICE), SERVICE, len(account),
            account, None, None, ctypes.byref(item))
        if status == -25300:  # errSecItemNotFound
            return
        self._check(status)
        try:
            self._check(security.SecKeychainItemDelete(item))
        finally:
            core.CFRelease(item)


def system_store(config_path: Path, *, interactive: bool = False):
    if sys.platform == "win32":
        return WindowsStore(config_path)
    if sys.platform == "darwin":
        return MacStore(interactive=interactive)
    raise CredentialError("系统凭据存储只支持 Windows/macOS；其他系统请使用环境变量")


def load_bundle(config_path: Path, identifier: str) -> dict[str, str]:
    validate_id(identifier)
    return decode_bundle(system_store(config_path).read(identifier))
