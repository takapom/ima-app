import base64
import hashlib
import json
import random

from PIL import Image

from specs import H, SCALE, W


def dedupe(frames):
    out = []
    for cv, ms in frames:
        if out and out[-1][0] == cv:
            out[-1] = (cv, out[-1][1] + ms)
        else:
            out.append((cv, ms))
    return out


def to_rgba(cv, scale):
    im = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    px = im.load()
    for y in range(H):
        for x in range(W):
            if cv[y][x] is not None:
                px[x, y] = (*cv[y][x], 255)
    return im.resize((W * scale, H * scale), Image.NEAREST)


def save_gif(frames, path):
    colors = sorted({c for cv, _ in frames for row in cv for c in row if c is not None})
    assert len(colors) < 256
    index = {c: i + 1 for i, c in enumerate(colors)}
    flat = [255, 0, 255] + [v for c in colors for v in c]
    flat += [0] * (768 - len(flat))
    images = []
    for cv, _ in frames:
        im = Image.new("P", (W, H), 0)
        im.putpalette(flat)
        px = im.load()
        for y in range(H):
            for x in range(W):
                if cv[y][x] is not None:
                    px[x, y] = index[cv[y][x]]
        images.append(im.resize((W * SCALE, H * SCALE), Image.NEAREST))
    images[0].save(
        path,
        save_all=True,
        append_images=images[1:],
        duration=[ms for _, ms in frames],
        loop=0,
        transparency=0,
        disposal=2,
        optimize=False,
    )


def frame_paths(cv):
    by_color = {}
    for y in range(H):
        x = 0
        while x < W:
            c = cv[y][x]
            if c is None:
                x += 1
                continue
            start = x
            while x < W and cv[y][x] == c:
                x += 1
            by_color.setdefault(c, []).append(f"M{start} {y}h{x - start}v1h-{x - start}z")
    return "".join(
        f'<path fill="#{c[0]:02x}{c[1]:02x}{c[2]:02x}" d="{"".join(d)}"/>' for c, d in by_color.items()
    )


def save_svg(frames, path):
    unique = []
    for cv, _ in frames:
        if cv not in unique:
            unique.append(cv)
    total = sum(ms for _, ms in frames)
    defs = "".join(f'<g id="f{i}">{frame_paths(cv)}</g>' for i, cv in enumerate(unique))
    uses = []
    t = 0
    for cv, ms in frames:
        s, e = t / total, (t + ms) / total
        t += ms
        if s == 0:
            values, times = "visible;hidden", f"0;{e:.4f}"
        elif t == total:
            values, times = "hidden;visible", f"0;{s:.4f}"
        else:
            values, times = "hidden;visible;hidden", f"0;{s:.4f};{e:.4f}"
        uses.append(
            f'<use href="#f{unique.index(cv)}" visibility="hidden">'
            f'<animate attributeName="visibility" values="{values}" keyTimes="{times}" '
            f'calcMode="discrete" dur="{total}ms" repeatCount="indefinite"/></use>'
        )
    path.write_text(
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W * SCALE}" height="{H * SCALE}" '
        f'shape-rendering="crispEdges"><defs>{defs}</defs>{"".join(uses)}</svg>\n'
    )


def save_contact(frames, path):
    scale = 4
    sheet = Image.new("RGBA", (len(frames) * (W * scale + 4), H * scale * 2 + 4), (24, 24, 27, 255))
    light = Image.new("RGBA", (W * scale, H * scale), (245, 245, 247, 255))
    for i, (cv, _) in enumerate(frames):
        im = to_rgba(cv, scale)
        x = i * (W * scale + 4)
        sheet.alpha_composite(im, (x, 0))
        sheet.alpha_composite(light, (x, H * scale + 4))
        sheet.alpha_composite(im, (x, H * scale + 4))
    sheet.save(path)


def excalidraw_element(rng, prefix, kind, x, y, width, height, **extra):
    return {
        "id": f"{prefix}-{kind}-{rng.getrandbits(48):012x}",
        "type": kind,
        "x": x,
        "y": y,
        "width": width,
        "height": height,
        "angle": 0,
        "strokeColor": "#1e1e1e" if kind == "text" else "transparent",
        "backgroundColor": "transparent",
        "fillStyle": "solid",
        "strokeWidth": 2,
        "strokeStyle": "solid",
        "roughness": 1,
        "opacity": 100,
        "groupIds": [],
        "frameId": None,
        "roundness": None,
        "seed": rng.getrandbits(31),
        "version": 1,
        "versionNonce": rng.getrandbits(31),
        "isDeleted": False,
        "boundElements": None,
        "updated": 1791100000000,
        "link": None,
        "locked": False,
        **extra,
    }


def excalidraw_text(rng, prefix, label, x, y, width, size=16):
    return excalidraw_element(
        rng,
        prefix,
        "text",
        x,
        y,
        width,
        size * 1.25,
        text=label,
        originalText=label,
        fontSize=size,
        fontFamily=5,
        textAlign="center",
        verticalAlign="top",
        containerId=None,
        autoResize=True,
        lineHeight=1.25,
    )


def excalidraw_scene(rows, prefix):
    rng = random.Random(prefix)
    elements, files = [], {}
    size, gap_x, gap_y = 160, 200, 220
    for r, (title, items) in enumerate(rows):
        top = r * (gap_y + 60)
        if title:
            elements.append(excalidraw_text(rng, prefix, title, 0, top, len(title) * 14, 28))
            top += 50
        for i, (path, label) in enumerate(items):
            data = path.read_bytes()
            file_id = hashlib.sha1(data).hexdigest()
            files[file_id] = {
                "mimeType": "image/png",
                "id": file_id,
                "dataURL": "data:image/png;base64," + base64.b64encode(data).decode(),
                "created": 1791100000000,
                "lastRetrieved": 1791100000000,
            }
            columns = len(items) if title else 5
            x, y = (i % columns) * gap_x, top + (i // columns) * gap_y
            elements.append(
                excalidraw_element(
                    rng, prefix, "image", x, y, size, size, status="saved", fileId=file_id, scale=[1, 1], crop=None
                )
            )
            width = len(label) * 16
            elements.append(excalidraw_text(rng, prefix, label, x + (size - width) / 2, y + size + 4, width))
    return {
        "type": "excalidraw",
        "version": 2,
        "source": "https://excalidraw.com",
        "elements": elements,
        "appState": {"viewBackgroundColor": "#ffffff", "gridSize": 20},
        "files": files,
    }


def write_json(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")


def preview_html(chars, anims):
    sections = "".join(
        f"<h2>{c}</h2><div class=\"row\">"
        + "".join(f'<div class="cell"><img src="{c}/{c}-{a}.gif" alt=""><div>{a}</div></div>' for a in anims)
        + "</div>"
        for c in chars
    )
    return f"""<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Character Animations</title>
<style>
  body {{ margin: 0; padding: 24px 16px; background: #111113; color: #ececf0; font-family: system-ui, sans-serif; }}
  h2 {{ font-size: 16px; margin: 24px 0 8px; }}
  .row {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 8px; }}
  .cell {{ background: #1c1c20; border-radius: 10px; padding: 6px; text-align: center; font-size: 11px; color: #9a9aa5; }}
  .cell img {{ width: 100%; image-rendering: pixelated; }}
</style>
</head>
<body>{sections}</body>
</html>
"""
