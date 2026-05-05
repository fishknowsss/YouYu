from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from PIL import Image, ImageDraw


ROOT = Path("/Users/fishknowsss/Documents/MMSS/Pet")
CONCEPTS = ROOT / "concepts"
OUT = ROOT / "rich-final-pack"
CELL_W = 192
CELL_H = 208

Anchor = Literal["center", "left", "right"]


@dataclass(frozen=True)
class Candidate:
    key: str
    source: str
    row: int
    col: int
    raw: Image.Image


@dataclass(frozen=True)
class FrameRef:
    key: str
    profile: str
    anchor: Anchor = "center"
    y_offset: int = 0
    mirror: bool = False
    keep_detached: bool = False


SOURCES: list[tuple[str, Path, int, int]] = [
    ("base", Path("/Users/fishknowsss/Downloads/spritesheet.png"), 8, 6),
    ("a", CONCEPTS / "original-style-variant-a-basic-interaction.png", 6, 4),
    ("a_no_mouth", CONCEPTS / "original-style-variant-a-basic-interaction-no-mouth.png", 6, 4),
    ("b_no_mouth", CONCEPTS / "original-style-variant-b-desktop-behavior-no-mouth.png", 6, 4),
    ("c_no_mouth", CONCEPTS / "original-style-variant-c-emotion-companion-no-mouth.png", 6, 4),
]

PROFILES = {
    "normal": {"target_h": 166, "max_w": 160, "baseline": 202},
    "walk": {"target_h": 158, "max_w": 170, "baseline": 202},
    "small": {"target_h": 150, "max_w": 156, "baseline": 202},
    "low": {"target_h": 112, "max_w": 178, "baseline": 202},
    "very_low": {"target_h": 88, "max_w": 182, "baseline": 202},
    "tall": {"target_h": 188, "max_w": 150, "baseline": 202},
    "edge": {"target_h": 158, "max_w": 170, "baseline": 202},
    "reward": {"target_h": 160, "max_w": 176, "baseline": 202},
}


def black_to_alpha(image: Image.Image) -> Image.Image:
    image = image.convert("RGBA")
    px = image.load()
    width, height = image.size
    for y in range(height):
        for x in range(width):
            r, g, b, a = px[x, y]
            if r < 26 and g < 26 and b < 32:
                px[x, y] = (0, 0, 0, 0)
    return image


def components_for(image: Image.Image) -> list[tuple[int, int, int, int, int, list[tuple[int, int]]]]:
    alpha = image.convert("RGBA").getchannel("A")
    width, height = image.size
    pix = alpha.load()
    seen: set[tuple[int, int]] = set()
    comps: list[tuple[int, int, int, int, int, list[tuple[int, int]]]] = []
    for y in range(height):
        for x in range(width):
            if pix[x, y] == 0 or (x, y) in seen:
                continue
            stack = [(x, y)]
            seen.add((x, y))
            points: list[tuple[int, int]] = []
            min_x = max_x = x
            min_y = max_y = y
            while stack:
                px, py = stack.pop()
                points.append((px, py))
                min_x = min(min_x, px)
                max_x = max(max_x, px)
                min_y = min(min_y, py)
                max_y = max(max_y, py)
                for nx in (px - 1, px, px + 1):
                    for ny in (py - 1, py, py + 1):
                        if nx < 0 or ny < 0 or nx >= width or ny >= height:
                            continue
                        if (nx, ny) in seen or pix[nx, ny] == 0:
                            continue
                        seen.add((nx, ny))
                        stack.append((nx, ny))
            comps.append((len(points), min_x, min_y, max_x, max_y, points))
    return sorted(comps, reverse=True, key=lambda c: c[0])


def isolate_subject(image: Image.Image, *, keep_detached: bool) -> Image.Image:
    image = black_to_alpha(image)
    if keep_detached:
        return image

    comps = components_for(image)
    if not comps:
        return image
    size, lx0, ly0, lx1, ly1, points = comps[0]
    keep = set(points)
    for comp_size, x0, y0, x1, y1, comp_points in comps[1:]:
        comp_w = x1 - x0 + 1
        comp_h = y1 - y0 + 1
        is_thin_line = comp_w <= 7 and comp_h >= 18
        overlaps_body = x1 >= lx0 and x0 <= lx1 and y1 >= ly0 and y0 <= ly1
        close_to_body = x1 >= lx0 - 8 and x0 <= lx1 + 8 and y1 >= ly0 - 8 and y0 <= ly1 + 8
        if (overlaps_body or close_to_body) and comp_size >= 10 and not is_thin_line:
            keep.update(comp_points)

    out = Image.new("RGBA", image.size, (0, 0, 0, 0))
    src = image.load()
    dst = out.load()
    for x, y in keep:
        dst[x, y] = src[x, y]
    return out


def crop_grid_cell(sheet: Image.Image, row: int, col: int, cols: int, rows: int) -> Image.Image:
    width, height = sheet.size
    cw = width / cols
    ch = height / rows
    return sheet.crop((
        round(col * cw),
        round(row * ch),
        round((col + 1) * cw),
        round((row + 1) * ch),
    ))


def load_candidates() -> dict[str, Candidate]:
    candidates: dict[str, Candidate] = {}
    for source_key, path, cols, rows in SOURCES:
        sheet = Image.open(path).convert("RGBA")
        for row in range(rows):
            for col in range(cols):
                key = f"{source_key}_r{row + 1}c{col + 1}"
                candidates[key] = Candidate(
                    key=key,
                    source=source_key,
                    row=row,
                    col=col,
                    raw=crop_grid_cell(sheet, row, col, cols, rows),
                )
    return candidates


def render_frame(candidate: Candidate, ref: FrameRef) -> Image.Image:
    image = isolate_subject(candidate.raw, keep_detached=ref.keep_detached)
    if ref.mirror:
        image = image.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
    bbox = image.getchannel("A").getbbox()
    canvas = Image.new("RGBA", (CELL_W, CELL_H), (0, 0, 0, 0))
    if not bbox:
        return canvas
    sprite = image.crop(bbox)
    sw, sh = sprite.size
    profile = PROFILES[ref.profile]
    ratio = profile["target_h"] / sh
    if sw * ratio > profile["max_w"]:
        ratio = profile["max_w"] / sw
    nw = max(1, round(sw * ratio))
    nh = max(1, round(sh * ratio))
    sprite = sprite.resize((nw, nh), Image.Resampling.LANCZOS)
    if ref.anchor == "left":
        x = 0
    elif ref.anchor == "right":
        x = CELL_W - nw
    else:
        x = (CELL_W - nw) // 2
    y = profile["baseline"] - nh + ref.y_offset
    y = max(2, min(y, CELL_H - nh - 2))
    canvas.alpha_composite(sprite, (x, y))
    return canvas


def f(key: str, profile: str = "normal", y_offset: int = 0, anchor: Anchor = "center", *, mirror: bool = False, keep_detached: bool = False) -> FrameRef:
    return FrameRef(key=key, profile=profile, y_offset=y_offset, anchor=anchor, mirror=mirror, keep_detached=keep_detached)


def checker(size: tuple[int, int], block: int = 16) -> Image.Image:
    width, height = size
    bg = Image.new("RGBA", size, (255, 255, 255, 255))
    px = bg.load()
    for y in range(height):
        for x in range(width):
            v = 232 if ((x // block) + (y // block)) % 2 == 0 else 204
            px[x, y] = (v, v, v, 255)
    return bg


def build_atlas(name: str, states: dict[str, list[FrameRef]], candidates: dict[str, Candidate]) -> dict[str, object]:
    atlas = Image.new("RGBA", (8 * CELL_W, len(states) * CELL_H), (0, 0, 0, 0))
    frames_root = OUT / "frames" / name
    rows: dict[str, object] = {}
    for row_idx, (state, frame_refs) in enumerate(states.items()):
        state_dir = frames_root / state
        state_dir.mkdir(parents=True, exist_ok=True)
        rows[state] = {
            "row": row_idx,
            "frames": len(frame_refs),
            "sourceKeys": [ref.key for ref in frame_refs],
            "profiles": [ref.profile for ref in frame_refs],
        }
        for col_idx, ref in enumerate(frame_refs[:8]):
            frame = render_frame(candidates[ref.key], ref)
            atlas.alpha_composite(frame, (col_idx * CELL_W, row_idx * CELL_H))
            frame.save(state_dir / f"{col_idx:02d}.png")
    OUT.mkdir(parents=True, exist_ok=True)
    atlas.save(OUT / f"{name}.png")
    atlas.save(OUT / f"{name}.webp", lossless=True, quality=100)
    preview = checker(atlas.size)
    preview.alpha_composite(atlas)
    (OUT / "qa").mkdir(parents=True, exist_ok=True)
    preview.save(OUT / "qa" / f"{name}-checker.png")
    return rows


def make_contact_sheet(candidates: dict[str, Candidate]) -> None:
    thumb_w, thumb_h, label_h = 128, 139, 18
    cols = 8
    rows = math.ceil(len(candidates) / cols)
    sheet = Image.new("RGBA", (cols * thumb_w, rows * (thumb_h + label_h)), (20, 20, 20, 255))
    draw = ImageDraw.Draw(sheet)
    for idx, (key, cand) in enumerate(candidates.items()):
        x = (idx % cols) * thumb_w
        y = (idx // cols) * (thumb_h + label_h)
        bg = checker((thumb_w, thumb_h), 12)
        sprite = render_frame(cand, f(key)).resize((thumb_w, thumb_h), Image.Resampling.LANCZOS)
        bg.alpha_composite(sprite)
        sheet.alpha_composite(bg, (x, y))
        draw.text((x + 4, y + thumb_h + 2), key, fill=(255, 255, 255, 255))
    (OUT / "qa").mkdir(parents=True, exist_ok=True)
    sheet.save(OUT / "qa/all-candidates-checker.png")


def main() -> None:
    candidates = load_candidates()
    make_contact_sheet(candidates)

    main_states = {
        "idle": [
            f("a_no_mouth_r1c1"), f("a_no_mouth_r1c2"), f("a_no_mouth_r1c3"),
            f("a_no_mouth_r1c4"), f("a_no_mouth_r1c5"), f("a_no_mouth_r1c6"),
        ],
        "walkRight": [f(f"base_r5c{i}", "walk") for i in range(1, 7)],
        "walkLeft": [f(f"base_r5c{i}", "walk", mirror=True) for i in range(1, 7)],
        "wave": [
            f("a_no_mouth_r2c1"), f("a_no_mouth_r2c2"), f("a_no_mouth_r2c3"),
            f("a_no_mouth_r2c4"), f("a_no_mouth_r2c5"), f("a_no_mouth_r2c6"),
        ],
        "jump": [
            f("a_no_mouth_r3c1", "very_low"), f("a_no_mouth_r3c2", "normal", 8),
            f("a_no_mouth_r3c3", "normal", -18), f("a_no_mouth_r3c4", "normal", -34),
            f("a_no_mouth_r3c5", "very_low"), f("a_no_mouth_r3c6", "normal"),
        ],
        "drag": [
            f("a_no_mouth_r4c1", "normal"), f("a_no_mouth_r4c2", "tall"),
            f("a_no_mouth_r4c3", "tall"), f("a_no_mouth_r4c4", "tall"),
            f("a_no_mouth_r4c5", "normal"), f("a_no_mouth_r4c6", "normal"),
        ],
        "sleepWake": [
            f("b_no_mouth_r1c1"), f("b_no_mouth_r1c2", "low"),
            f("b_no_mouth_r1c3", "low"), f("b_no_mouth_r1c4", "low"),
            f("b_no_mouth_r1c5"), f("b_no_mouth_r1c6"),
        ],
        "focusWait": [
            f("b_no_mouth_r4c1"), f("b_no_mouth_r4c2"), f("b_no_mouth_r4c3"),
            f("b_no_mouth_r4c4"), f("b_no_mouth_r4c5"), f("b_no_mouth_r4c6"),
        ],
        "happy": [
            f("c_no_mouth_r1c1"), f("c_no_mouth_r1c2"), f("c_no_mouth_r1c3"),
            f("c_no_mouth_r1c4"), f("c_no_mouth_r1c5"), f("c_no_mouth_r1c6"),
        ],
    }

    extra_states = {
        "edgePeek": [
            f("b_no_mouth_r2c1", "edge", anchor="left"), f("b_no_mouth_r2c2", "edge"),
            f("b_no_mouth_r2c3", "very_low"), f("b_no_mouth_r2c4", "edge", anchor="right"),
            f("b_no_mouth_r2c5", "very_low"), f("b_no_mouth_r2c6"),
        ],
        "fallRecover": [
            f("b_no_mouth_r3c1", "normal", -24), f("b_no_mouth_r3c2", "normal", -10),
            f("b_no_mouth_r3c3", "very_low"), f("b_no_mouth_r3c4", keep_detached=True),
            f("b_no_mouth_r3c5"), f("b_no_mouth_r3c6"),
        ],
        "annoyed": [
            f("c_no_mouth_r2c1"), f("c_no_mouth_r2c2"), f("c_no_mouth_r2c3"),
            f("c_no_mouth_r2c4"), f("c_no_mouth_r2c5", keep_detached=True), f("c_no_mouth_r2c6"),
        ],
        "comfortSad": [
            f("c_no_mouth_r3c1"), f("c_no_mouth_r3c2"), f("c_no_mouth_r3c3", "very_low"),
            f("c_no_mouth_r3c4", "very_low"), f("c_no_mouth_r3c5"), f("c_no_mouth_r3c6"),
        ],
        "rewardObserve": [
            f("c_no_mouth_r4c1"), f("c_no_mouth_r4c2"), f("c_no_mouth_r4c3", "reward"),
            f("c_no_mouth_r4c4", "reward"), f("c_no_mouth_r4c5", "reward"), f("c_no_mouth_r4c6"),
        ],
    }

    main_rows = build_atlas("main-spritesheet", main_states, candidates)
    extra_rows = build_atlas("extra-spritesheet", extra_states, candidates)
    manifest = {
        "frame": {"width": CELL_W, "height": CELL_H},
        "background": "transparent",
        "source": "Rich version: preserves most liked no-mouth concept poses, plus original base walking frames. Clear original mouth frames are not used.",
        "rules": {
            "noOriginalMouthFrames": True,
            "rewardInterpretedAsHoldObserveNotEating": True,
            "stateAwareScaleAndBaseline": True,
            "transparentBackground": True,
        },
        "atlases": {
            "main": {"file": "main-spritesheet.png", "webp": "main-spritesheet.webp", "rows": main_rows},
            "extra": {"file": "extra-spritesheet.png", "webp": "extra-spritesheet.webp", "rows": extra_rows},
        },
        "qa": {
            "mainChecker": "qa/main-spritesheet-checker.png",
            "extraChecker": "qa/extra-spritesheet-checker.png",
            "allCandidates": "qa/all-candidates-checker.png",
        },
    }
    (OUT / "spritesheet-manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
