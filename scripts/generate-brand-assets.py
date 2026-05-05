from __future__ import annotations

import math
import shutil
import struct
import zlib
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / "build"
SOURCE_ICON = ROOT / "youyu.png"
RENDERER_ICON = ROOT / "src" / "renderer" / "assets" / "youyu-icon.png"

INK = (36, 26, 51, 255)
INK_SOFT = (77, 63, 93, 255)
PAPER = (252, 249, 255, 255)
LAVENDER = (239, 229, 255, 255)
LAVENDER_SOFT = (247, 241, 255, 255)
PURPLE = (143, 88, 215, 255)
PURPLE_DARK = (113, 68, 186, 255)
WHITE = (255, 255, 255, 255)


def clamp(value: float, low: float = 0, high: float = 255) -> int:
    return int(max(low, min(high, round(value))))


def blend(
    dst: tuple[int, int, int, int],
    src: tuple[int, int, int, int],
    alpha: float,
) -> tuple[int, int, int, int]:
    alpha = max(0.0, min(1.0, alpha)) * (src[3] / 255)
    inv = 1 - alpha
    return (
        clamp(dst[0] * inv + src[0] * alpha),
        clamp(dst[1] * inv + src[1] * alpha),
        clamp(dst[2] * inv + src[2] * alpha),
        clamp((dst[3] / 255 * inv + alpha) * 255),
    )


def new_image(width: int, height: int, color: tuple[int, int, int, int]):
    return [[color for _ in range(width)] for _ in range(height)]


def read_png(path: Path):
    data = path.read_bytes()
    if not data.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ValueError(f"{path} is not a PNG file")

    offset = 8
    width = 0
    height = 0
    bit_depth = 0
    color_type = 0
    interlace = 0
    idat = bytearray()
    palette: list[tuple[int, int, int, int]] = []
    transparency = b""

    while offset < len(data):
        length = struct.unpack(">I", data[offset : offset + 4])[0]
        chunk_type = data[offset + 4 : offset + 8]
        chunk_data = data[offset + 8 : offset + 8 + length]
        offset += 12 + length

        if chunk_type == b"IHDR":
            width, height, bit_depth, color_type, _compression, _filter, interlace = struct.unpack(
                ">IIBBBBB", chunk_data
            )
        elif chunk_type == b"IDAT":
            idat.extend(chunk_data)
        elif chunk_type == b"PLTE":
            palette = [
                (chunk_data[index], chunk_data[index + 1], chunk_data[index + 2], 255)
                for index in range(0, len(chunk_data), 3)
            ]
        elif chunk_type == b"tRNS":
            transparency = chunk_data
        elif chunk_type == b"IEND":
            break

    if bit_depth != 8 or color_type not in (2, 3, 6) or interlace != 0:
        raise ValueError("Only 8-bit RGB/RGBA/palette non-interlaced PNG files are supported")

    channels = 4 if color_type == 6 else 3 if color_type == 2 else 1
    stride = width * channels
    raw = zlib.decompress(bytes(idat))
    rows = []
    previous = [0] * stride
    cursor = 0

    for _y in range(height):
        filter_type = raw[cursor]
        cursor += 1
        scanline = list(raw[cursor : cursor + stride])
        cursor += stride

        for x in range(stride):
            left = scanline[x - channels] if x >= channels else 0
            up = previous[x]
            up_left = previous[x - channels] if x >= channels else 0

            if filter_type == 1:
                scanline[x] = (scanline[x] + left) & 0xFF
            elif filter_type == 2:
                scanline[x] = (scanline[x] + up) & 0xFF
            elif filter_type == 3:
                scanline[x] = (scanline[x] + ((left + up) // 2)) & 0xFF
            elif filter_type == 4:
                scanline[x] = (scanline[x] + paeth(left, up, up_left)) & 0xFF
            elif filter_type != 0:
                raise ValueError(f"Unsupported PNG filter type {filter_type}")

        row = []
        if color_type == 3:
            for index in scanline:
                if index >= len(palette):
                    row.append((0, 0, 0, 0))
                    continue
                r, g, b, _a = palette[index]
                alpha = transparency[index] if index < len(transparency) else 255
                row.append((r, g, b, alpha))
        else:
            for x in range(0, stride, channels):
                if channels == 4:
                    row.append((scanline[x], scanline[x + 1], scanline[x + 2], scanline[x + 3]))
                else:
                    row.append((scanline[x], scanline[x + 1], scanline[x + 2], 255))
        rows.append(row)
        previous = scanline

    return rows


def paeth(a: int, b: int, c: int) -> int:
    p = a + b - c
    pa = abs(p - a)
    pb = abs(p - b)
    pc = abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    if pb <= pc:
        return b
    return c


def resize_image(src, width: int, height: int):
    src_height = len(src)
    src_width = len(src[0])
    if src_width == width and src_height == height:
        return [row[:] for row in src]

    out = new_image(width, height, (0, 0, 0, 0))
    for y in range(height):
        sy = (y + 0.5) * src_height / height - 0.5
        y0 = max(0, math.floor(sy))
        y1 = min(src_height - 1, y0 + 1)
        wy = sy - y0
        for x in range(width):
            sx = (x + 0.5) * src_width / width - 0.5
            x0 = max(0, math.floor(sx))
            x1 = min(src_width - 1, x0 + 1)
            wx = sx - x0

            p00 = src[y0][x0]
            p10 = src[y0][x1]
            p01 = src[y1][x0]
            p11 = src[y1][x1]
            out[y][x] = tuple(
                clamp(
                    p00[i] * (1 - wx) * (1 - wy)
                    + p10[i] * wx * (1 - wy)
                    + p01[i] * (1 - wx) * wy
                    + p11[i] * wx * wy
                )
                for i in range(4)
            )
    return out


def transparent_bounds(src, threshold: int = 10) -> tuple[int, int, int, int]:
    xs: list[int] = []
    ys: list[int] = []
    for y, row in enumerate(src):
        for x, pixel in enumerate(row):
            if pixel[3] > threshold:
                xs.append(x)
                ys.append(y)

    if not xs:
        return 0, 0, len(src[0]), len(src)

    return min(xs), min(ys), max(xs) + 1, max(ys) + 1


def crop_image(src, x0: int, y0: int, x1: int, y1: int):
    return [row[x0:x1] for row in src[y0:y1]]


def fit_icon_subject(src, size: int, padding: int):
    x0, y0, x1, y1 = transparent_bounds(src)
    cropped = crop_image(src, x0, y0, x1, y1)
    target = max(1, size - padding * 2)
    src_height = len(cropped)
    src_width = len(cropped[0])
    if src_width >= src_height:
        width = target
        height = max(1, round(target * src_height / src_width))
    else:
        height = target
        width = max(1, round(target * src_width / src_height))

    resized = resize_image(cropped, width, height)
    out = new_image(size, size, (0, 0, 0, 0))
    paste(out, resized, (size - width) // 2, (size - height) // 2)
    return out


def icon_padding(size: int) -> int:
    if size <= 16:
        return 0
    if size <= 32:
        return 1
    if size <= 48:
        return 2
    if size <= 64:
        return 3
    if size <= 128:
        return 6
    if size <= 256:
        return 12
    return 20


def png_bytes(img):
    height = len(img)
    width = len(img[0])
    raw = bytearray()
    for row in img:
        raw.append(0)
        for r, g, b, a in row:
            raw.extend([r, g, b, a])

    def chunk(name: bytes, payload: bytes) -> bytes:
        return (
            struct.pack(">I", len(payload))
            + name
            + payload
            + struct.pack(">I", zlib.crc32(name + payload) & 0xFFFFFFFF)
        )

    data = b"\x89PNG\r\n\x1a\n"
    data += chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
    data += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    data += chunk(b"IEND", b"")
    return data


def write_png(path: Path, img):
    path.write_bytes(png_bytes(img))


def write_bmp(path: Path, img):
    height = len(img)
    width = len(img[0])
    row_size = ((width * 3 + 3) // 4) * 4
    pixel_data = bytearray()
    for row in reversed(img):
        start = len(pixel_data)
        for r, g, b, _a in row:
            pixel_data.extend([b, g, r])
        pixel_data.extend(b"\x00" * (row_size - (len(pixel_data) - start)))

    header_size = 14 + 40
    file_size = header_size + len(pixel_data)
    header = b"BM" + struct.pack("<IHHI", file_size, 0, 0, header_size)
    dib = struct.pack("<IIIHHIIIIII", 40, width, height, 1, 24, 0, len(pixel_data), 2835, 2835, 0, 0)
    path.write_bytes(header + dib + pixel_data)


def write_ico(path: Path, png_entries: list[tuple[int, bytes]]):
    header = struct.pack("<HHH", 0, 1, len(png_entries))
    directory = bytearray()
    data = bytearray()
    offset = 6 + 16 * len(png_entries)
    for size, png in png_entries:
        directory.extend(
            struct.pack(
                "<BBBBHHII",
                0 if size >= 256 else size,
                0 if size >= 256 else size,
                0,
                0,
                1,
                32,
                len(png),
                offset,
            )
        )
        data.extend(png)
        offset += len(png)
    path.write_bytes(header + directory + data)


def draw_rect(img, x0: int, y0: int, x1: int, y1: int, color):
    height = len(img)
    width = len(img[0])
    for y in range(max(0, y0), min(height, y1)):
        for x in range(max(0, x0), min(width, x1)):
            img[y][x] = color


def draw_rounded_rect(img, x0, y0, x1, y1, radius, color):
    height = len(img)
    width = len(img[0])
    for y in range(max(0, int(y0)), min(height, math.ceil(y1))):
        for x in range(max(0, int(x0)), min(width, math.ceil(x1))):
            cx = min(max(x + 0.5, x0 + radius), x1 - radius)
            cy = min(max(y + 0.5, y0 + radius), y1 - radius)
            if math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= radius:
                img[y][x] = blend(img[y][x], color, 1)


def draw_circle(img, cx, cy, radius, color):
    height = len(img)
    width = len(img[0])
    for y in range(max(0, int(cy - radius - 1)), min(height, math.ceil(cy + radius + 1))):
        for x in range(max(0, int(cx - radius - 1)), min(width, math.ceil(cx + radius + 1))):
            distance = math.hypot(x + 0.5 - cx, y + 0.5 - cy)
            alpha = max(0, min(1, radius + 0.5 - distance))
            if alpha > 0:
                img[y][x] = blend(img[y][x], color, alpha)


def paste(dst, src, x0: int, y0: int, opacity: float = 1):
    for y, row in enumerate(src):
        yy = y0 + y
        if yy < 0 or yy >= len(dst):
            continue
        for x, pixel in enumerate(row):
            xx = x0 + x
            if xx < 0 or xx >= len(dst[0]):
                continue
            dst[yy][xx] = blend(dst[yy][xx], pixel, opacity)


def vertical_gradient(width: int, height: int, top, bottom):
    img = new_image(width, height, top)
    for y in range(height):
        t = y / max(1, height - 1)
        color = tuple(clamp(top[i] * (1 - t) + bottom[i] * t) for i in range(4))
        for x in range(width):
            img[y][x] = color
    return img


def sidebar(path: Path, icon):
    width = 1
    height = 1
    img = new_image(width, height, WHITE)
    write_bmp(path, img)


def header(path: Path, icon):
    img = vertical_gradient(150, 57, (250, 246, 255, 255), (241, 232, 254, 255))
    draw_rect(img, 0, 53, 150, 57, PURPLE)
    paste(img, fit_icon_subject(icon, 42, 1), 14, 8)
    write_bmp(path, img)


def main():
    if not SOURCE_ICON.exists():
        raise FileNotFoundError(f"Missing source icon: {SOURCE_ICON}")

    BUILD.mkdir(exist_ok=True)
    shutil.copyfile(SOURCE_ICON, BUILD / "source-icon.png")

    source_icon = read_png(SOURCE_ICON)
    write_png(RENDERER_ICON, fit_icon_subject(source_icon, 512, icon_padding(512)))
    sizes = [16, 24, 32, 48, 64, 128, 256]
    png_entries = []
    for size in sizes:
        img = fit_icon_subject(source_icon, size, icon_padding(size))
        png_path = BUILD / f"icon-{size}.png"
        write_png(png_path, img)
        png_entries.append((size, png_path.read_bytes()))

    write_png(BUILD / "icon.png", fit_icon_subject(source_icon, 512, icon_padding(512)))
    write_png(BUILD / "tray-icon.png", fit_icon_subject(source_icon, 32, 1))
    write_ico(BUILD / "icon.ico", png_entries)
    sidebar(BUILD / "installerSidebar.bmp", source_icon)
    sidebar(BUILD / "uninstallerSidebar.bmp", source_icon)


if __name__ == "__main__":
    main()
