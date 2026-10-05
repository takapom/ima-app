#!/usr/bin/env python3
import shutil
import sys
import zipfile
from math import floor, hypot
from pathlib import Path

from PIL import Image

from export import dedupe, excalidraw_scene, preview_html, save_contact, save_gif, save_svg, to_rgba, write_json
from specs import (
    BANG,
    BLACK,
    CELL,
    CHARS,
    CLAUDE,
    DROP,
    DUST,
    DUST_LIGHT,
    EYE_SIZE,
    EYE_SPRITES,
    FRAME,
    GLASS,
    GLYPH_CYCLE,
    GLYPHS,
    GRID,
    HANDLE,
    HEART,
    OX,
    OY,
    PINK,
    QMARK,
    QUESTION,
    RIM,
    SCALE,
    SHADOW,
    SPARK,
    SPARKLE_BIG,
    SPARKLE_SMALL,
    SPEED,
    SWEAT,
    WHITE,
    H,
    W,
)

ROOT = Path(__file__).resolve().parent.parent


def put(g, x, y, c):
    if 0 <= y < len(g) and 0 <= x < len(g[0]):
        g[y][x] = c


def sprite(g, rows, x0, y0, colors):
    for dy, row in enumerate(rows):
        for dx, ch in enumerate(row):
            if ch != ".":
                put(g, x0 + dx, y0 + dy, colors[ch])


def mix(a, b, t):
    return tuple(round(a[i] * (1 - t) + b[i] * t) for i in range(3))


def load_grid(path):
    im = Image.open(path).convert("RGBA")
    px = im.load()
    g = [[None] * GRID for _ in range(GRID)]
    for y in range(GRID):
        for x in range(GRID):
            r, gr, b, a = px[x * CELL + CELL // 2, y * CELL + CELL // 2]
            if a:
                g[y][x] = (r, gr, b)
    return g


def canvas():
    return [[None] * W for _ in range(H)]


def blit(cv, g, ox, oy):
    for y, row in enumerate(g):
        for x, c in enumerate(row):
            if c is not None:
                put(cv, x + ox, y + oy, c)


def shadow(cv, x0, x1, y):
    for x in range(x0, x1 + 1):
        put(cv, x, y, SHADOW)


def lift(g, split):
    out = [row[:] for row in g]
    for r in range(split):
        out[r] = g[r + 1][:]
    out[split] = g[split][:]
    return out


def lean(g, dx, split):
    out = [row[:] for row in g]
    for r in range(split + 1):
        if dx > 0:
            out[r] = [None] * dx + g[r][:-dx]
        elif dx < 0:
            out[r] = g[r][-dx:] + [None] * -dx
    return out


class Character:
    def __init__(self, key, spec):
        self.key = key
        self.spec = spec
        self.dir = ROOT / key
        self.ew, self.eh = EYE_SIZE[spec["eye_shape"]]
        grid = load_grid(self.dir / "wait.png")
        self.mouth_pixels = []
        self.cheek_pixels = []
        shadow_xs = []
        for y in range(GRID):
            for x in range(GRID):
                c = grid[y][x]
                if c == SHADOW:
                    shadow_xs.append(x)
                    self.shadow_row = y
                    grid[y][x] = None
                elif c == PINK:
                    self.cheek_pixels.append((x, y, c))
                    grid[y][x] = spec["cheek_fill"]
        self.shadow_range = (min(shadow_xs), max(shadow_xs))
        for ex, ey in spec["eyes"]:
            for y in range(ey, ey + self.eh):
                for x in range(ex, ex + self.ew):
                    grid[y][x] = spec["eye_fill"]
        if spec["mouth"]:
            (x0, y0, x1, y1), fill = spec["mouth"]
            for y in range(y0, y1 + 1):
                for x in range(x0, x1 + 1):
                    if grid[y][x] != fill:
                        self.mouth_pixels.append((x, y, grid[y][x]))
                        grid[y][x] = fill
        for x, y in spec.get("brows", ()):
            grid[y][x] = spec["brow_fill"]
        self.body = grid
        (lx, ly), (rx, _) = spec["eyes"]
        self.sad_brows = ((lx - 1, ly - 1), (lx, ly - 2), (rx + self.ew - 1, ly - 2), (rx + self.ew, ly - 1))
        self.lens_w, self.lens_h = self.ew + 4, self.eh + 3
        self.lens_xs = (lx - 2, rx - 2)
        self.lens_top = ly - 2
        row = self.lens_top + 1
        self.glasses_bar = list(range(self.lens_xs[0] + self.lens_w, self.lens_xs[1]))
        for start, step in ((self.lens_xs[0] - 1, -1), (self.lens_xs[1] + self.lens_w, 1)):
            x = start
            while 0 <= x < GRID and grid[row][x] not in (None, spec["outline"]):
                self.glasses_bar.append(x)
                x += step
        self.cx_left = OX + lx + self.ew // 2
        self.cx_right = OX + rx + self.ew // 2
        self.cx_mid = (self.cx_left + self.cx_right) // 2
        self.cy_eye = OY + ly + self.eh // 2

    def draw_face(self, g, eyes, dx):
        s = self.spec
        brows = self.sad_brows if eyes == "sad" else s.get("brows", ())
        for x, y in brows:
            put(g, x + dx, y, s["brow_color"])
        left, right, ox, oy = EYE_SPRITES[s["eye_shape"]][eyes]
        for i, (ex, ey) in enumerate(s["eyes"]):
            rows = right if i == 1 and right is not None else left
            sprite(g, rows, ex + dx + ox, ey + oy, {"E": WHITE, "K": BLACK})
        for x, y, c in self.mouth_pixels:
            put(g, x + dx, y, c)
        for x, y, c in self.cheek_pixels:
            put(g, x + dx, y, c)

    def draw_glasses(self, g, dy=0, glint=None):
        top = self.lens_top + dy
        w, h = self.lens_w, self.lens_h
        frame = ["." + "F" * (w - 2) + "."] + ["F" + "." * (w - 2) + "F"] * (h - 2) + ["." + "F" * (w - 2) + "."]
        for lx in self.lens_xs:
            for x in range(lx + 1, lx + w - 1):
                for y in range(top + 1, top + h - 1):
                    c = g[y][x]
                    if c is not None and c not in (BLACK, WHITE):
                        g[y][x] = mix(c, GLASS, 0.45)
                if glint is not None:
                    for y in range(top + 1, top + h - 1):
                        if (x - lx - 1) + (y - top - 1) == glint:
                            g[y][x] = WHITE
            sprite(g, frame, lx, top, {"F": FRAME})
        for x in self.glasses_bar:
            put(g, x, self.lens_top + 1 + dy, FRAME)

    def draw_feet(self, g, left, right):
        f = self.spec["feet"]
        for row in f["clear"]:
            g[row] = [None] * GRID
        for down, x in zip((left, right), f["xs"]):
            if down:
                sprite(g, [".BB.", "OBBO", ".OO."], x, f["row"], {"O": self.spec["outline"], "B": f["color"]})

    def figure(self, eyes="open", dx=0, breath=0, tilt=0, glasses=None, feet=None, ears="up"):
        g = [row[:] for row in self.body]
        if ears == "down" and "droop" in self.spec:
            self.spec["droop"](g)
        self.draw_face(g, eyes, dx)
        if glasses is not None:
            self.draw_glasses(g, **glasses)
        split1, split2 = self.spec["split"]
        if breath == 1:
            g = lift(g, split1)
        elif breath == 2:
            g = lift(g, split2)
        if tilt:
            g = lean(g, tilt, split2)
        if feet is not None:
            self.draw_feet(g, *feet)
        return g

    def scene(self, oy=OY, **kw):
        cv = canvas()
        x0, x1 = self.shadow_range
        shadow(cv, OX + x0, OX + x1, oy + self.shadow_row)
        blit(cv, self.figure(**kw), OX, oy)
        return cv

    def magnifier(self, cv, cx, cy, magnify=True, paw=True):
        src = [row[:] for row in cv]
        for y in range(cy - 6, cy + 6):
            for x in range(cx - 6, cx + 6):
                vx, vy = x + 0.5 - cx, y + 0.5 - cy
                d = hypot(vx, vy)
                if d <= 3.5:
                    if d > 1.9 and vx < 0 and vy < 0 and abs(vx - vy) < 1.5:
                        put(cv, x, y, WHITE)
                        continue
                    sx, sy = floor(cx + vx / 2), floor(cy + vy / 2)
                    c = src[sy][sx] if magnify and 0 <= sy < H and 0 <= sx < W else None
                    put(cv, x, y, GLASS if c is None else mix(c, GLASS, 0.18))
                elif d <= 4.6:
                    put(cv, x, y, RIM)
        o = self.spec["outline"]
        if paw:
            sprite(cv, ["XY", ".X"], cx + 3, cy + 3, {"X": o, "Y": HANDLE})
            colors = {"O": o, "L": self.spec["light"], "B": self.spec["body"]}
            sprite(cv, [".OO.", "OLBO", "OBBO", ".OO."], cx + 4, cy + 4, colors)
        else:
            sprite(cv, ["XY..", ".XY.", "..XY", "...X"], cx + 3, cy + 3, {"X": o, "Y": HANDLE})

    def found_lens(self):
        cx, cy, paw = self.spec.get("found", (6, 22, False))
        return dict(cx=cx, cy=cy, paw=paw)

    def anim_breath(self):
        seq = [
            (dict(), 450),
            (dict(breath=1), 140),
            (dict(breath=2), 650),
            (dict(breath=1), 140),
            (dict(), 450),
            (dict(breath=1), 140),
            (dict(breath=2), 650),
            (dict(breath=1), 140),
            (dict(), 250),
            (dict(eyes="blink"), 110),
            (dict(), 200),
        ]
        return [(self.scene(**kw), ms) for kw, ms in seq]

    def anim_magnifier(self):
        frames = []
        l, r, c = self.cx_left, self.cx_right, self.cx_mid
        path = list(range(c, l, -1)) + [l] * 4 + list(range(l + 1, r)) + [r] * 4 + list(range(r - 1, c - 1, -1))
        for i, cx in enumerate(path):
            cv = self.scene(eyes="blink" if i == 13 else "open")
            self.magnifier(cv, cx, self.cy_eye + 1 if c - 2 <= cx <= c + 2 else self.cy_eye)
            sprite(cv, QUESTION, 26, 3 - (i // 3) % 2, {"X": QMARK})
            frames.append((cv, 100))
        found = [
            ("wide", 0, 3, None, 200),
            ("happy", 2, 2, SPARKLE_BIG, 220),
            ("happy", 0, 3, SPARKLE_SMALL, 220),
            ("happy", 2, 2, SPARKLE_BIG, 220),
            ("happy", 0, 3, None, 260),
        ]
        for eyes, breath, bang_y, sparkle, ms in found:
            cv = self.scene(eyes=eyes, breath=breath)
            self.magnifier(cv, **self.found_lens())
            sprite(cv, BANG, 26, bang_y, {"X": HEART})
            if sparkle is not None:
                sprite(cv, sparkle, 3 if sparkle is SPARKLE_BIG else 4, 6, {"X": SPARK})
            frames.append((cv, ms))
        return frames

    def anim_claude_search(self):
        frames = []
        for f in range(24):
            phase = f // 6
            dx = (-1, 0, 1, 0)[phase]
            hop = -1 if f % 6 == 0 and phase in (1, 3) else 0
            cv = self.scene(oy=OY + hop, eyes="blink" if f == 20 else "open", dx=dx, tilt=dx)
            sprite(cv, GLYPHS[GLYPH_CYCLE[f % len(GLYPH_CYCLE)]], 1, 1, {"X": CLAUDE})
            for i in range((f // 6) % 4):
                sprite(cv, ["XX", "XX"], 10 + i * 3, 6, {"X": CLAUDE})
            frames.append((cv, 100))
        return frames

    def anim_run(self):
        frames = []
        ox, ground = 6, 6
        puffs = [
            [(["XX", "XX"], 8, 27, DUST)],
            [([".X.", "XXX", ".X."], 5, 26, DUST)],
            [(["X.X", ".X."], 2, 26, DUST_LIGHT)],
            [],
        ]
        x0, x1 = self.shadow_range
        foot_row = self.spec["feet"]["row"]
        for f in range(8):
            step = f % 4
            up = step in (1, 3)
            feet = {0: (True, False), 1: (False, False), 2: (False, True), 3: (False, False)}[step]
            cv = canvas()
            inset = 1 + (1 if up else 0)
            shadow(cv, ox + x0 + inset, ox + x1 - inset, ground + foot_row + 3)
            for row, phase in ((13, 0), (18, 5), (23, 3)):
                start = 5 - ((step * 2 + phase) % 8)
                for x in range(start, start + 3):
                    if 0 <= x <= 5:
                        put(cv, x, row, SPEED)
            figure = self.figure(eyes="blink" if f == 6 else "open", tilt=1, feet=feet)
            blit(cv, figure, ox, ground - (1 if up else 0))
            for shape, x, y, color in puffs[step]:
                sprite(cv, shape, x, y, {"X": color})
            frames.append((cv, 80))
        return frames

    def anim_glasses(self):
        seq = []

        def add(ms, eyes="open", breath=0, gdy=0, glint=None, sparkle=None):
            cv = self.scene(eyes=eyes, breath=breath, glasses=dict(dy=gdy, glint=glint))
            if sparkle == "big":
                sprite(cv, SPARKLE_BIG, 26, 6, {"X": SPARK})
            elif sparkle == "small":
                sprite(cv, SPARKLE_SMALL, 27, 7, {"X": SPARK})
            seq.append((cv, ms))

        add(450)
        add(140, breath=1)
        add(650, breath=2)
        add(140, breath=1)
        add(350)
        add(110, gdy=-1)
        add(160)
        for k in range(self.lens_w + self.lens_h - 5):
            add(60, glint=k)
        add(160, sparkle="big")
        add(160, sparkle="small")
        add(300)
        add(140, breath=1)
        add(650, breath=2)
        add(140, breath=1)
        add(250)
        add(110, eyes="blink")
        add(300)
        return seq

    def pose(self, name):
        cv = canvas()
        blit(cv, load_grid(self.dir / f"{name}.png"), OX, OY)
        return cv

    def sticker_magnifier(self):
        cv = self.scene()
        self.magnifier(cv, self.cx_left, self.cy_eye)
        sprite(cv, QUESTION, 26, 3, {"X": QMARK})
        return cv

    def sticker_found(self):
        cv = self.scene(eyes="happy", breath=2)
        self.magnifier(cv, **self.found_lens())
        sprite(cv, BANG, 26, 2, {"X": HEART})
        sprite(cv, SPARKLE_BIG, 3, 6, {"X": SPARK})
        return cv

    def sticker_empty(self):
        cv = self.scene(eyes="sad", ears="down")
        self.magnifier(cv, 6, 22, magnify=False, paw=False)
        sprite(cv, SWEAT, 27, 9, {"X": DROP, "E": WHITE})
        return cv

    def sticker_claude_search(self):
        cv = self.scene()
        sprite(cv, GLYPHS[3], 1, 1, {"X": CLAUDE})
        for i in range(3):
            sprite(cv, ["XX", "XX"], 10 + i * 3, 6, {"X": CLAUDE})
        return cv

    def sticker_glasses(self):
        cv = self.scene(glasses=dict(glint=2))
        sprite(cv, SPARKLE_BIG, 26, 6, {"X": SPARK})
        return cv

    def animations(self):
        return {
            "breath": self.anim_breath,
            "magnifier": self.anim_magnifier,
            "claude-search": self.anim_claude_search,
            "run": self.anim_run,
            "glasses": self.anim_glasses,
        }

    def stickers(self):
        return [
            ("wait", "待機", lambda: self.pose("wait")),
            ("search", "考え中", lambda: self.pose("search")),
            ("decided", "決定", lambda: self.pose("decided")),
            ("oops", "エラー", lambda: self.pose("oops")),
            ("pet", "なでる", lambda: self.pose("pet")),
            ("magnifier", "虫眼鏡で探す", self.sticker_magnifier),
            ("found", "見つけた", self.sticker_found),
            ("empty", "0件", self.sticker_empty),
            ("claude-search", "検索中", self.sticker_claude_search),
            ("run", "移動中", lambda: self.anim_run()[0][0]),
            ("glasses", "詳しく見る", self.sticker_glasses),
        ]


def build(ch, extras):
    out = ch.dir / "anim"
    (out / "stickers").mkdir(parents=True, exist_ok=True)
    gifs = []
    for name, make in ch.animations().items():
        frames = dedupe(make())
        gif = out / f"{ch.key}-{name}.gif"
        save_gif(frames, gif)
        gifs.append(gif)
        if extras:
            save_svg(frames, extras / ch.key / f"{ch.key}-{name}.svg")
            save_contact(frames, extras / "contact" / f"{ch.key}-{name}.png")
            shutil.copy(gif, extras / ch.key / gif.name)
    items = []
    for name, label, make in ch.stickers():
        path = out / "stickers" / f"{ch.key}-{name}.png"
        to_rgba(make(), SCALE).save(path)
        items.append((path, label))
    if extras:
        write_json(extras / ch.key / f"{ch.key}-stickers.excalidraw", excalidraw_scene([(None, items)], ch.key))
    print(ch.key, "ok")
    return gifs, items


def export_extras(extras, rows, files):
    write_json(extras / "all-stickers.excalidraw", excalidraw_scene(rows, "all"))
    (extras / "anim-preview.html").write_text(preview_html(list(CHARS), ["breath", "magnifier", "claude-search", "run", "glasses"]))
    with zipfile.ZipFile(extras / "character-anim-all.zip", "w") as z:
        for path in files:
            z.write(path, path.relative_to(ROOT))
        z.write(extras / "all-stickers.excalidraw", "all-stickers.excalidraw")


def main():
    extras = None
    if len(sys.argv) == 3 and sys.argv[1] == "--extras":
        extras = Path(sys.argv[2]).resolve()
        for key in [*CHARS, "contact"]:
            (extras / key).mkdir(parents=True, exist_ok=True)
    rows, files = [], []
    for key, spec in CHARS.items():
        gifs, items = build(Character(key, spec), extras)
        rows.append((key, items))
        files += gifs + [path for path, _ in items]
    if extras:
        export_extras(extras, rows, files)


if __name__ == "__main__":
    main()
