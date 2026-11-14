"""Read-only Windows loader module identity; data-file mappings are not modules."""
import ctypes as c
from ctypes import wintypes as w
from pathlib import Path

_kernel = None
MEM_IMAGE = 0x1000000


class MemoryInfo(c.Structure):
    _fields_ = [('BaseAddress', c.c_void_p), ('AllocationBase', c.c_void_p),
                ('AllocationProtect', w.DWORD), ('PartitionId', w.WORD),
                ('RegionSize', c.c_size_t), ('State', w.DWORD),
                ('Protect', w.DWORD), ('Type', w.DWORD)]


def kernel():
    global _kernel
    if _kernel is None:
        api = c.WinDLL('kernel32', use_last_error=True)
        for name, result, args in (
            ('OpenProcess', w.HANDLE, [w.DWORD, w.BOOL, w.DWORD]),
            ('CloseHandle', w.BOOL, [w.HANDLE]),
            ('K32EnumProcessModulesEx', w.BOOL, [w.HANDLE, c.POINTER(w.HMODULE), w.DWORD, c.POINTER(w.DWORD), w.DWORD]),
            ('K32GetModuleFileNameExW', w.DWORD, [w.HANDLE, w.HMODULE, w.LPWSTR, w.DWORD]),
            ('VirtualQueryEx', c.c_size_t, [w.HANDLE, c.c_void_p, c.POINTER(MemoryInfo), c.c_size_t]),
        ):
            method = getattr(api, name)
            method.restype, method.argtypes = result, args
        _kernel = api
    return _kernel


def loaded_modules(pid, module_names):
    """Resolve only the caller's required loader images for one selected PID.

    Unrelated entries may unload after enumeration. They cannot invalidate a
    resolved target, but unresolved entries prevent claiming a target absent.
    Every returned target must still be its registered MEM_IMAGE allocation.
    """
    wanted = {name.casefold() for name in module_names}
    api = kernel()
    handle = api.OpenProcess(0x410, False, pid)
    if not handle:
        raise c.WinError(c.get_last_error())
    try:
        handles = (w.HMODULE * 256)()
        needed = w.DWORD()
        if not api.K32EnumProcessModulesEx(handle, handles, c.sizeof(handles), c.byref(needed), 3):
            raise c.WinError(c.get_last_error())
        if needed.value > c.sizeof(handles):
            handles = (w.HMODULE * ((needed.value + c.sizeof(w.HMODULE) - 1) // c.sizeof(w.HMODULE)))()
            if not api.K32EnumProcessModulesEx(handle, handles, c.sizeof(handles), c.byref(needed), 3):
                raise c.WinError(c.get_last_error())
        if needed.value > c.sizeof(handles) or needed.value % c.sizeof(w.HMODULE):
            raise OSError('Loaded module list changed during observation')
        filename = c.create_unicode_buffer(32768)
        result, found = {}, set()
        unresolved = False
        for index in range(needed.value // c.sizeof(w.HMODULE)):
            base = handles[index]
            length = api.K32GetModuleFileNameExW(handle, base, filename, len(filename)) if base else 0
            if not length or length >= len(filename) - 1:
                unresolved = True
                continue
            module_path = Path(filename.value)
            module_name = module_path.name.casefold()
            if module_name not in wanted:
                continue
            info = MemoryInfo()
            if (api.VirtualQueryEx(handle, base, c.byref(info), c.sizeof(info)) != c.sizeof(info)
                    or info.Type != MEM_IMAGE or info.AllocationBase != base):
                raise OSError('Required module is not its registered image allocation')
            name = str(module_path).casefold()
            previous = result.get(name)
            if previous is not None and previous != base:
                raise OSError('Required module path has ambiguous image allocations')
            result[name] = base
            found.add(module_name)
        if unresolved and wanted - found:
            raise OSError('Required module absence could not be verified')
        return result
    finally:
        api.CloseHandle(handle)
