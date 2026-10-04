CELL = 12
GRID = 24
W = H = 32
SCALE = 10
OX, OY = 4, 7

WHITE = (255, 255, 255)
BLACK = (27, 27, 31)
PINK = (244, 160, 168)
SHADOW = (31, 31, 34)
SPARK = (244, 236, 176)
HEART = (242, 120, 140)
QMARK = (183, 201, 122)
CLAUDE = (217, 119, 87)
RIM = (62, 62, 78)
GLASS = (205, 228, 242)
HANDLE = (150, 95, 48)
FRAME = (58, 44, 40)
SPEED = (176, 182, 198)
DUST = (230, 211, 181)
DUST_LIGHT = (245, 236, 218)
DROP = (150, 205, 240)

EYE_SPRITES = {
    "2x2": {
        "open": (["EK", "KK"], None, 0, 0),
        "blink": (["KK"], None, 0, 1),
        "happy": ([".KK.", "K..K"], None, -1, -1),
        "wide": (["EK", "KK", "KK"], None, 0, -1),
        "sad": (["KE", "KK"], None, 0, 0),
    },
    "2x1": {
        "open": (["KK"], None, 0, 0),
        "blink": (["KK"], None, 0, 0),
        "happy": ([".KK.", "K..K"], None, -1, 0),
        "wide": (["EK", "KK"], None, 0, -1),
        "sad": ([".K", "K."], ["K.", ".K"], 0, 0),
    },
    "1x2": {
        "open": (["K", "K"], None, 0, 0),
        "blink": (["KKK"], None, -1, 1),
        "happy": ([".K.", "K.K"], None, -1, 0),
        "wide": (["K", "K", "K"], None, 0, -1),
        "sad": (["K", "K"], None, 0, 1),
    },
}
EYE_SIZE = {"2x2": (2, 2), "2x1": (2, 1), "1x2": (1, 2)}


def maru_droop(g, outline, inner):
    left_old = ((3, 3), (3, 4), (4, 4), (3, 5), (4, 5), (5, 5), (3, 6), (4, 6), (5, 6))
    left_new = [(2, 5, outline), (3, 5, outline), (4, 5, outline), (1, 6, outline), (2, 6, inner), (3, 6, inner)]
    left_new += [(4, 6, outline), (5, 6, outline), (1, 7, outline)]
    for x, y in left_old:
        g[y][x] = None
        g[y][GRID - 1 - x] = None
    for x, y, c in left_new:
        g[y][x] = c
        g[y][GRID - 1 - x] = c


CHARS = {
    "maru": dict(
        outline=(123, 74, 38),
        body=(233, 163, 91),
        light=(245, 195, 137),
        eye_shape="2x2",
        eyes=((6, 10), (16, 10)),
        eye_fill=(233, 163, 91),
        mouth=((10, 12, 13, 13), (251, 240, 220)),
        cheek_fill=(251, 240, 220),
        brows=((6, 8), (7, 8), (16, 8), (17, 8)),
        brow_fill=(233, 163, 91),
        brow_color=(251, 240, 220),
        split=(7, 14),
        feet=dict(xs=(4, 16), row=20, color=(233, 163, 91), clear=()),
        found=(16, 20, True),
        droop=lambda g: maru_droop(g, (123, 74, 38), (251, 240, 220)),
    ),
    "mocchi": dict(
        outline=(125, 139, 151),
        body=(243, 246, 249),
        light=(255, 255, 255),
        eye_shape="2x2",
        eyes=((7, 11), (15, 11)),
        eye_fill=(243, 246, 249),
        mouth=((9, 14, 14, 16), (243, 246, 249)),
        cheek_fill=(243, 246, 249),
        brow_color=(125, 139, 151),
        split=(8, 17),
        feet=dict(xs=(5, 15), row=20, color=(243, 246, 249), clear=()),
    ),
    "hoppe": dict(
        outline=(122, 82, 52),
        body=(234, 180, 122),
        light=(246, 210, 166),
        eye_shape="2x2",
        eyes=((6, 10), (16, 10)),
        eye_fill=(234, 180, 122),
        mouth=((11, 12, 12, 12), (252, 245, 234)),
        cheek_fill=(252, 245, 234),
        brow_color=(122, 82, 52),
        split=(8, 14),
        feet=dict(xs=(5, 15), row=20, color=(242, 163, 163), clear=(21,)),
        found=(16, 20, True),
    ),
    "fuwa": dict(
        outline=(154, 142, 123),
        body=(247, 243, 234),
        light=(255, 255, 255),
        eye_shape="1x2",
        eyes=((9, 12), (14, 12)),
        eye_fill=(242, 216, 198),
        mouth=None,
        cheek_fill=(242, 216, 198),
        brow_color=(154, 142, 123),
        split=(8, 16),
        feet=dict(xs=(6, 14), row=20, color=(90, 76, 68), clear=(21,)),
    ),
    "nonno": dict(
        outline=(79, 58, 40),
        body=(184, 139, 94),
        light=(210, 166, 120),
        eye_shape="2x1",
        eyes=((6, 10), (16, 10)),
        eye_fill=(184, 139, 94),
        mouth=((9, 15, 14, 17), (143, 106, 74)),
        cheek_fill=(184, 139, 94),
        brow_color=(79, 58, 40),
        split=(9, 18),
        feet=dict(xs=(5, 15), row=20, color=(184, 139, 94), clear=()),
    ),
}

QUESTION = ["XX.", "..X", ".X.", "...", ".X."]
BANG = ["XX", "XX", "XX", "..", "XX"]
SPARKLE_BIG = ["..X..", "..X..", "XXXXX", "..X..", "..X.."]
SPARKLE_SMALL = [".X.", "XXX", ".X."]
SWEAT = [".X.", "XXX", "XEX", ".X."]
GLYPHS = [
    [".......", ".......", ".......", "...X...", ".......", ".......", "......."],
    [".......", ".......", "...X...", "..XXX..", "...X...", ".......", "......."],
    [".......", ".X.X.X.", "..XXX..", ".XXXXX.", "..XXX..", ".X.X.X.", "......."],
    ["...X...", ".X.X.X.", "..XXX..", "XXXXXXX", "..XXX..", ".X.X.X.", "...X..."],
]
GLYPH_CYCLE = [0, 1, 2, 3, 2, 1]
