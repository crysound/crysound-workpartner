"""Run a command with Linux Landlock: all files readable, only listed directories writable."""
import ctypes
import json
import os
import sys

libc = ctypes.CDLL(None, use_errno=True)


def checked(result):
    if result < 0:
        raise OSError(ctypes.get_errno(), os.strerror(ctypes.get_errno()))
    return result


class Ruleset(ctypes.Structure):
    _fields_ = [("handled_access_fs", ctypes.c_uint64)]


class PathRule(ctypes.Structure):
    _pack_ = 1
    _fields_ = [("allowed_access", ctypes.c_uint64), ("parent_fd", ctypes.c_int32)]


# ABI 3 adds truncate protection. Read, directory listing and execute stay unrestricted.
abi = checked(libc.syscall(444, 0, 0, 1))
if abi < 3:
    raise RuntimeError("These sandbox tests require Linux Landlock ABI >= 3")
writes = ((1 << 15) - 1) & ~((1 << 0) | (1 << 2) | (1 << 3))
ruleset = Ruleset(writes)
fd = checked(libc.syscall(444, ctypes.byref(ruleset), ctypes.sizeof(ruleset), 0))
try:
    # Node's ignored stdio opens the null device; this is not persistent filesystem storage.
    null = os.open('/dev/null', os.O_PATH | os.O_CLOEXEC)
    try:
        rule = PathRule((1 << 1) | (1 << 14), null)
        checked(libc.syscall(445, fd, 1, ctypes.byref(rule), 0))
    finally:
        os.close(null)
    for path in json.loads(sys.argv[1]):
        parent = os.open(path, os.O_PATH | os.O_CLOEXEC)
        try:
            rule = PathRule(writes, parent)
            checked(libc.syscall(445, fd, 1, ctypes.byref(rule), 0))
        finally:
            os.close(parent)
    checked(libc.prctl(38, 1, 0, 0, 0))  # PR_SET_NO_NEW_PRIVS
    checked(libc.syscall(446, fd, 0))
finally:
    os.close(fd)
os.execvpe(sys.argv[2], sys.argv[2:], os.environ)
