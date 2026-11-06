import sys, zipfile, ctypes as C, os
import numpy as np
import texture2ddecoder as t2d

ZIP = r"E:\forza2port_win\game\Anthem_1.0.0.64_x64__8wekyb3d8bbwe\Mount\media\ui\textures\data_bound\Anthem_Map.zip"
xg = C.WinDLL(os.environ.get("DYNMAP_XG_DLL", "xg.dll"))


class Desc(C.Structure):
    _fields_ = [(n, C.c_uint32) for n in
                ("Width Height MipLevels ArraySize Format SCount SQuality Usage BindFlags CPUAccess MiscFlags "
                 "EsramOff EsramSize TileMode Pitch").split()]


def vt(comp, i, restype, *argtypes):
    table = C.cast(C.cast(comp, C.POINTER(C.c_void_p))[0], C.POINTER(C.c_void_p))
    return C.WINFUNCTYPE(restype, C.c_void_p, *argtypes)(table[i])


def detile(data, w, h, mode, fmt=98, mips=1):
    d = Desc(w, h, mips, 1, fmt, 1, 0, 0, 8, 0, 0, 0, 0, mode, 0)
    comp = C.c_void_p()
    hr = xg.XGCreateTexture2DComputer(C.byref(d), C.byref(comp))
    if hr != 0 or not comp.value:
        return None
    size = vt(comp, 3, C.c_uint64)(comp)
    out = (C.c_ubyte * (w // 4 * h // 4 * 16))()
    src = C.create_string_buffer(bytes(data).ljust(int(size), b"\0"), int(size))
    hr = vt(comp, 9, C.c_int, C.c_void_p, C.c_uint32, C.c_uint32, C.c_void_p, C.c_uint32, C.c_uint32)(
        comp, out, 0, 0, src, w // 4 * 16, w // 4 * h // 4 * 16)
    return bytes(out) if hr == 0 else None


def decode(buf, w, h):
    return np.frombuffer(t2d.decode_bc7(buf, w, h), np.uint8).reshape(h, w, 4)


def score(img):
    a = img[..., :3].astype(np.int16)
    return np.abs(np.diff(a, axis=1)).mean() + np.abs(np.diff(a, axis=0)).mean()


if __name__ == "__main__":
    name, w, h = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
    raw = zipfile.ZipFile(ZIP).read(name)[83:]
    for mode in range(0, 32):
        out = detile(raw, w, h, mode)
        if out is None:
            continue
        img = decode(out, w, h)
        print(mode, round(score(img), 2), flush=True)
