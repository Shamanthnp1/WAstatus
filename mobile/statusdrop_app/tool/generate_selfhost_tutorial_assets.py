"""Build the setup and self-host tutorial posters for the app.

Reads the raw phone screenshots in source_art/tutorial images/ (gitignored:
they contain private data) and writes 793x1983 WebP posters in the style of
the original StatusDrop guide (dark header, green STEP pill, yellow callouts):

  assets/tutorial/setup/   2 posters shown to everyone before step 1
  assets/tutorial/own/     steps 1-7 for "My WhatsApp (Message yourself)"
  assets/tutorial/bot/     steps 1-7 for "My second number as a bot"
  assets/tutorial/shared/  steps 8-13, the same in both self-host flows

Phone numbers and the WhatsApp profile name are blurred. Linking codes are
left as they are (they were already used). Windows fonts (Segoe UI) are used
to match the original posters, so run this on Windows.

    python tool/generate_selfhost_tutorial_assets.py [--preview DIR]
"""

from __future__ import annotations

import argparse
import math
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

APP_ROOT = Path(__file__).resolve().parents[1]
SOURCE = APP_ROOT / "source_art" / "tutorial images"
OWN_SRC = SOURCE / "for send yourself"
BOT_SRC = SOURCE / "for sending as bot"
SETUP_SRC = SOURCE / "pre requirment images ( globally)"
OUTPUT = APP_ROOT / "assets" / "tutorial"

# Poster geometry, measured from the original posters.
W, H = 793, 1983
S = 2  # draw at 2x, then downsample, for smooth lines and curves
HEADER_H = 200
HEADER_H_SUB = 252
FOOTER_TOP = 1895
TOTAL_STEPS = 13

HEADER_BG = (28, 34, 39)
FOOTER_BG = (31, 37, 42)
PILL_GREEN = (1, 156, 74)
YELLOW = (255, 252, 0)
EDGE = (0, 0, 0)
CALLOUT_FILL = (14, 19, 22)
WHITE = (255, 255, 255)
SOFT_WHITE = (236, 239, 241)

FONTS = Path(r"C:\Windows\Fonts")
BLACK = FONTS / "seguibl.ttf"
SEMIBOLD = FONTS / "seguisb.ttf"
REGULAR = FONTS / "segoeui.ttf"

# The bot flow reuses this activation code from its step 5 screenshot.
BOT_CODE = "4DIAX6YKK"


def s(value: float) -> int:
    return round(value * S)


@lru_cache(maxsize=None)
def font(path: Path, size: float) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(path), s(size))


def text_width(fnt: ImageFont.FreeTypeFont, text: str) -> float:
    left, _, right, _ = fnt.getbbox(text, anchor="ls")
    return (right - left) / S


def cap_height(fnt: ImageFont.FreeTypeFont) -> float:
    return -fnt.getbbox("H", anchor="ls")[1] / S


def fit_font(path: Path, size: float, text: str, max_width: float):
    while size > 20 and text_width(font(path, size), text) > max_width:
        size -= 1
    return font(path, size)


def wrap(fnt: ImageFont.FreeTypeFont, text: str, max_width: float) -> list[str]:
    words = text.split(" ")
    lines: list[str] = []
    current = ""
    for word in words:
        candidate = f"{current} {word}".strip()
        if current and text_width(fnt, candidate) > max_width:
            lines.append(current)
            current = word
        else:
            current = candidate
    lines.append(current)
    return lines


class Poster:
    def __init__(self, height: int = H):
        self.img = Image.new("RGB", (s(W), s(height)), HEADER_BG)
        self.draw = ImageDraw.Draw(self.img)

    def finish(self) -> Image.Image:
        return self.img.resize((W, self.img.height // S), Image.LANCZOS)

    def text(self, xy, text, fnt, fill, anchor="ls", shadow=0):
        x, y = s(xy[0]), s(xy[1])
        if shadow:
            left, top, right, bottom = self.draw.textbbox((x, y), text, font=fnt, anchor=anchor)
            pad = s(12)
            box = (max(0, left - pad), max(0, top - pad), min(self.img.width, right + pad),
                   min(self.img.height, bottom + pad + s(4)))
            mask = Image.new("L", (box[2] - box[0], box[3] - box[1]), 0)
            ImageDraw.Draw(mask).text((x - box[0], y - box[1] + s(3)), text, font=fnt,
                                      fill=shadow, anchor=anchor)
            mask = mask.filter(ImageFilter.GaussianBlur(s(3)))
            self.img.paste(EDGE, box, mask)
        self.draw.text((x, y), text, font=fnt, fill=fill, anchor=anchor)


# ---------------------------------------------------------------------------
# Header, footer and screenshot
# ---------------------------------------------------------------------------
def draw_header(p: Poster, pill: str, title: str, subtitle: str | None = None,
                height: int | None = None) -> None:
    height = height or (HEADER_H_SUB if subtitle else HEADER_H)
    p.draw.rectangle((0, 0, s(W), s(height)), fill=HEADER_BG)
    pill_font = font(BLACK, 48)
    pill_w = text_width(pill_font, pill) + 86
    x0 = (W - pill_w) / 2
    p.draw.rounded_rectangle((s(x0), s(19), s(x0 + pill_w), s(99)), radius=s(40), fill=PILL_GREEN)
    p.text((W / 2, 59 + cap_height(pill_font) / 2), pill, pill_font, WHITE, "ms", shadow=90)
    p.text((W / 2, 172), title, fit_font(BLACK, 72, title, W - 56), WHITE, "ms", shadow=150)
    if subtitle:
        p.text((W / 2, 218), subtitle, fit_font(SEMIBOLD, 32, subtitle, W - 44), SOFT_WHITE, "ms",
               shadow=120)


def draw_footer(p: Poster) -> None:
    p.draw.rectangle((0, s(FOOTER_TOP), s(W), s(H)), fill=FOOTER_BG)
    p.text((W / 2, 1942), "wastatusvideo.com", font(REGULAR, 29), (240, 241, 242), "ms")


@dataclass
class Shot:
    """Maps screenshot pixels to poster coordinates."""

    k: float
    x0: int
    y0: int
    top: float

    def pt(self, x: float, y: float) -> tuple[float, float]:
        return ((x - self.x0) * self.k, (y - self.y0) * self.k + self.top)

    def box(self, b, pad: float = 6) -> tuple[float, float, float, float]:
        x0, y0 = self.pt(b[0], b[1])
        x1, y1 = self.pt(b[2], b[3])
        return (x0 - pad, y0 - pad, x1 + pad, y1 + pad)


def blur_region(img: Image.Image, box, block: int = 24) -> Image.Image:
    """Pixelate and blur a box so the text under it cannot be read."""
    feather = 10
    outer = (max(0, box[0] - feather), max(0, box[1] - feather),
             min(img.width, box[2] + feather), min(img.height, box[3] + feather))
    region = img.crop(outer)
    w, h = region.size
    small = region.resize((max(1, w // block), max(1, h // block)), Image.BILINEAR)
    region = small.resize((w, h), Image.BILINEAR).filter(ImageFilter.GaussianBlur(block * 0.7))
    mask = Image.new("L", (w, h), 0)
    ImageDraw.Draw(mask).rounded_rectangle((feather, feather, w - feather, h - feather),
                                           radius=feather, fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(feather / 2))
    out = img.copy()
    out.paste(region, outer[:2], mask)
    return out


def place_shot(p: Poster, path: Path, crop, top: float, blurs=(), fill=None) -> Shot:
    img = Image.open(path).convert("RGB")
    for b in blurs:
        img = blur_region(img, b)
    region = img.crop(crop)
    k = W / region.width
    height = region.height * k
    if height > FOOTER_TOP - top + 0.5:
        raise ValueError(f"{path.name}: crop is {height:.0f}px tall, only {FOOTER_TOP - top}px fit")
    if fill is None:
        row = sorted(region.getpixel((x, region.height - 2)) for x in range(0, region.width, 4))
        fill = row[len(row) // 2]
    p.draw.rectangle((0, s(top), s(W), s(FOOTER_TOP)), fill=fill)
    p.img.paste(region.resize((s(W), s(height)), Image.LANCZOS), (0, s(top)))
    return Shot(k, crop[0], crop[1], top)


# ---------------------------------------------------------------------------
# Annotations
# ---------------------------------------------------------------------------
def highlight(p: Poster, box, radius: float = 24, width: float = 8) -> None:
    x0, y0, x1, y1 = box
    p.draw.rounded_rectangle((s(x0 - 2), s(y0 - 2), s(x1 + 2), s(y1 + 2)), radius=s(radius + 2),
                             outline=EDGE, width=s(width + 4))
    p.draw.rounded_rectangle((s(x0), s(y0), s(x1), s(y1)), radius=s(radius), outline=YELLOW,
                             width=s(width))


def highlight_circle(p: Poster, center, r: float, width: float = 8) -> None:
    cx, cy = center
    highlight(p, (cx - r, cy - r, cx + r, cy + r), radius=r, width=width)


def badge(p: Poster, center, label: str, r: float = 23) -> None:
    cx, cy = center
    p.draw.ellipse((s(cx - r - 3), s(cy - r - 3), s(cx + r + 3), s(cy + r + 3)), fill=EDGE)
    p.draw.ellipse((s(cx - r), s(cy - r), s(cx + r), s(cy + r)), fill=YELLOW)
    fnt = font(BLACK, 30)
    p.text((cx, cy + cap_height(fnt) / 2), label, fnt, CALLOUT_FILL, "ms")


def callout(p: Poster, center_x: float, top: float, title: str | None = None, lines=(),
            *, width: float | None = None, height: float | None = None, align: str = "center",
            title_size: float = 44, body_size: float = 27, title_color=WHITE,
            max_width: float = 720) -> tuple[float, float, float, float]:
    """Dark rounded box with a thick yellow border, like the original posters.

    `lines` items are wrapped; a line starting with a digit and a space is
    drawn as a numbered row with a yellow badge.
    """
    pad_x, pad_y, gap = 28, 20, 8
    title_font = font(BLACK, title_size)
    body_font = font(SEMIBOLD, body_size)
    title_lh = title_size * 1.22
    body_lh = body_size * 1.36
    inner_max = (width or max_width) - 2 * pad_x

    rows: list[tuple[str, str | None]] = []  # (text, badge label)
    for line in lines:
        label = None
        text = line
        if len(line) > 2 and line[0].isdigit() and line[1] == " ":
            label, text = line[0], line[2:]
        indent = 44 if label else 0
        for i, part in enumerate(wrap(body_font, text, inner_max - indent) if text else [""]):
            rows.append((part, label if i == 0 else ("" if label else None)))

    title_lines = wrap(title_font, title, inner_max) if title else []
    content_w = max([text_width(title_font, t) for t in title_lines] +
                    [text_width(body_font, t) + (44 if lab is not None else 0) for t, lab in rows] + [0])
    box_w = width or min(max_width, content_w + 2 * pad_x)
    content_h = len(title_lines) * title_lh + (gap if title_lines and rows else 0) + len(rows) * body_lh
    box_h = height or content_h + 2 * pad_y
    x0 = center_x - box_w / 2
    x1 = x0 + box_w
    y0, y1 = top, top + box_h

    p.draw.rounded_rectangle((s(x0 - 2), s(y0 - 2), s(x1 + 2), s(y1 + 2)), radius=s(28), fill=EDGE)
    p.draw.rounded_rectangle((s(x0), s(y0), s(x1), s(y1)), radius=s(26), fill=CALLOUT_FILL,
                             outline=YELLOW, width=s(8))
    p.draw.rounded_rectangle((s(x0 + 8), s(y0 + 8), s(x1 - 8), s(y1 - 8)), radius=s(19),
                             outline=EDGE, width=s(1.5))

    y = y0 + (box_h - content_h) / 2
    for t in title_lines:
        y += title_lh
        p.text((center_x, y - title_lh * 0.24), t, title_font, title_color, "ms")
    if title_lines and rows:
        y += gap
    left = center_x - content_w / 2 if align == "left" else None
    for t, label in rows:
        y += body_lh
        baseline = y - body_lh * 0.3
        if left is not None:
            indent = 44 if label is not None else 0
            if label:
                badge(p, (left + 16, baseline - cap_height(body_font) / 2), label, r=16)
            p.text((left + indent, baseline), t, body_font, SOFT_WHITE, "ls")
        else:
            p.text((center_x, baseline), t, body_font, SOFT_WHITE, "ms")
    return (x0, y0, x1, y1)


def arrow(p: Poster, start, end, bend: float = 0.25, width: float = 14, head: float = 40) -> None:
    """Thick yellow curved arrow with a dark outline, pointing at `end`."""
    (sx, sy), (ex, ey) = start, end
    dx, dy = ex - sx, ey - sy
    length = math.hypot(dx, dy)
    nx, ny = -dy / length, dx / length
    cx, cy = (sx + ex) / 2 + nx * bend * length, (sy + ey) / 2 + ny * bend * length

    def bez(t):
        u = 1 - t
        return (u * u * sx + 2 * u * t * cx + t * t * ex, u * u * sy + 2 * u * t * cy + t * t * ey)

    tx, ty = ex - cx, ey - cy
    tl = math.hypot(tx, ty)
    tx, ty = tx / tl, ty / tl
    px, py = -ty, tx
    base = (ex - tx * head, ey - ty * head)
    pts = [bez(i / 80) for i in range(81)]
    pts = [q for q in pts if math.hypot(q[0] - ex, q[1] - ey) > head * 0.9] + [base]
    scaled = [(s(x), s(y)) for x, y in pts]

    def head_poly(extra):
        tip = (ex + tx * extra, ey + ty * extra)
        b = (base[0] - tx * extra * 0.6, base[1] - ty * extra * 0.6)
        half = head * 0.62 + extra
        return [(s(tip[0]), s(tip[1])), (s(b[0] + px * half), s(b[1] + py * half)),
                (s(b[0] - px * half), s(b[1] - py * half))]

    r_edge = (width + 6) / 2
    p.draw.line(scaled, fill=EDGE, width=s(width + 6), joint="curve")
    p.draw.ellipse((s(sx - r_edge), s(sy - r_edge), s(sx + r_edge), s(sy + r_edge)), fill=EDGE)
    p.draw.polygon(head_poly(4), fill=EDGE)
    p.draw.line(scaled, fill=YELLOW, width=s(width), joint="curve")
    r = width / 2
    p.draw.ellipse((s(sx - r), s(sy - r), s(sx + r), s(sy + r)), fill=YELLOW)
    p.draw.polygon(head_poly(0), fill=YELLOW)


def pointer_left(p: Poster, box, tip_x: float, cy: float, half: float = 20) -> None:
    """Small yellow wedge on a callout's left edge pointing at `tip_x`."""
    base = box[0] + 6
    p.draw.polygon([(s(tip_x - 5), s(cy)), (s(base), s(cy - half - 5)), (s(base), s(cy + half + 5))],
                   fill=EDGE)
    p.draw.polygon([(s(tip_x), s(cy)), (s(base), s(cy - half)), (s(base), s(cy + half))], fill=YELLOW)


def pill(step: int) -> str:
    return f"STEP {step} / {TOTAL_STEPS}"


# ---------------------------------------------------------------------------
# Setup posters (shown to everyone)
# ---------------------------------------------------------------------------
def setup_hd() -> Image.Image:
    p = Poster()
    draw_header(p, "SETUP 1 / 2", "Turn on HD in WhatsApp", "WhatsApp > Settings > Storage and data")
    shot = place_shot(p, SETUP_SRC / "pre_requirment_1.png", (0, 0, 1080, 2237), HEADER_H_SUB)
    upload = shot.box((40, 1052, 1040, 1180))
    download = shot.box((40, 1228, 1040, 1356))
    highlight(p, upload, radius=20)
    highlight(p, download, radius=20)
    badge(p, (upload[2] - 4, upload[1] + 2), "1")
    badge(p, (download[2] - 4, download[1] + 2), "2")
    box = callout(p, W / 2, 742, "Set both to HD quality",
                  ["Tap each one and choose HD quality."])
    arrow(p, (box[2] - 90, box[3] + 4), (upload[2] - 120, upload[1] - 6), bend=-0.25)
    callout(p, W / 2, 1610, "Why?", [
        "With Standard quality, WhatsApp shrinks every video you send or save.",
    ], width=700)
    draw_footer(p)
    return p.finish()


def setup_delivery() -> Image.Image:
    p = Poster()
    draw_header(p, "SETUP 2 / 2", "Pick a delivery method", "Tap the 3-dot menu at the top right")
    shot = place_shot(p, SETUP_SRC / "pre_requirment_2.png", (0, 0, 1080, 2237), HEADER_H_SUB)
    item = shot.box((648, 150, 1052, 282))
    highlight(p, item, radius=18)
    box = callout(p, W / 2, 610, "Tap Delivery method", [
        "Default: StatusDrop number sends your clips.",
        "Or link your own WhatsApp: Message yourself, or a second number as your bot.",
    ], width=700)
    arrow(p, (box[2] - 150, box[1] - 4), ((item[0] + item[2]) / 2 + 30, item[3] + 8), bend=0.2)
    draw_footer(p)
    return p.finish()


# ---------------------------------------------------------------------------
# Self-host flows, steps 1-5 (own) / 1-5 (bot)
# ---------------------------------------------------------------------------
def choose_method(bot: bool) -> Image.Image:
    p = Poster()
    # Each crop stops above the "How it works" card so no half card shows
    # under the callout.
    if bot:
        draw_header(p, pill(1), "Choose the bot option", "Use a second WhatsApp number you own")
        shot = place_shot(p, BOT_SRC / "for_send_as_Bot_page_1.png", (0, 0, 1080, 1728), HEADER_H_SUB)
        card, field, button = (50, 668, 1030, 937), (100, 1143, 980, 1279), (100, 1365, 980, 1504)
        lines = ["1 Pick My second number as a bot",
                 "2 Type the bot number with country code",
                 "3 Tap Get a linking code",
                 "Keep WhatsApp installed for the bot number."]
        top = 1566
    else:
        draw_header(p, pill(1), "Choose Message yourself", "Delivery method > My WhatsApp")
        shot = place_shot(p, OWN_SRC / "send_yourself_page_1.png", (0, 0, 1080, 1982), HEADER_H_SUB)
        card, field, button = (50, 627, 1030, 896), (100, 1397, 980, 1533), (100, 1619, 980, 1758)
        lines = ["1 Pick My WhatsApp (Message yourself)",
                 "2 Type your number with country code",
                 "3 Tap Get a linking code"]
        top = 1712
    for label, b, r in (("1", card, 30), ("2", field, 10), ("3", button, 52)):
        hb = shot.box(b)
        highlight(p, hb, radius=r)
        badge(p, (hb[0] + 4, hb[1] + 4), label)
    callout(p, W / 2, top, "Link it once" if bot else None, lines, width=740, align="left",
            body_size=28)
    draw_footer(p)
    return p.finish()


def copy_code(bot: bool) -> Image.Image:
    p = Poster()
    draw_header(p, pill(2), "Copy the linking code", "Use it before the timer runs out")
    name = "as_bot_code_2.1.png" if bot else "send_yourself_code_2.1.png"
    shot = place_shot(p, (BOT_SRC if bot else OWN_SRC) / name, (0, 0, 1080, 2237), HEADER_H_SUB)
    copy = shot.box((368, 1650, 712, 1790))
    highlight(p, copy, radius=40)
    where = "WhatsApp of your bot number" if bot else "WhatsApp on this phone"
    callout(p, W / 2, copy[3] + 40, "Tap Copy code", [
        f"Then open {where}.",
        "You paste the code there in the next step.",
    ], width=720, height=196)
    draw_footer(p)
    return p.finish()


def paste_code(bot: bool) -> Image.Image:
    p = Poster()
    if bot:
        draw_header(p, pill(3), "Paste it for your bot", "In WhatsApp on your second number")
    else:
        draw_header(p, pill(3), "Paste it in WhatsApp", "WhatsApp logs in by itself")
    shot = place_shot(p, OWN_SRC / "whatsapp_connect_2.2.png", (0, 0, 1080, 2237), HEADER_H_SUB)
    codes = shot.box((62, 578, 1016, 694))
    highlight(p, codes, radius=18)
    box = callout(p, W / 2, 900, "Paste your code here")
    # Run the arrow up the left margin so it doesn't cover WhatsApp's warning.
    arrow(p, (box[0] + 34, box[1] - 4), (104, codes[3] + 8), bend=-0.2, head=36)
    callout(p, W / 2, 1330, "Where do I enter it?", [
        "1 Tap the WhatsApp notification that asks for a code.",
        "2 No notification? Open WhatsApp > Settings > Linked devices > Link a device.",
        "3 Tap Link with phone number instead, then paste the code.",
    ], width=740, align="left")
    draw_footer(p)
    return p.finish()


def go_back(bot: bool) -> Image.Image:
    p = Poster()
    if bot:
        draw_header(p, pill(4), "Bot linked! Now go back", "Then compress your videos as usual")
        shot = place_shot(p, BOT_SRC / "linked_send_as_bot_3.png", (0, 0, 1080, 2208), HEADER_H_SUB,
                          blurs=[(322, 1394, 642, 1458)], fill=(12, 20, 17))
        linked = (92, 1392, 652, 1460)
    else:
        draw_header(p, pill(4), "Linked! Now go back", "Then compress your videos as usual")
        shot = place_shot(p, OWN_SRC / "linked_as_send_yourself_3.png", (0, 0, 1080, 2237),
                          HEADER_H_SUB, blurs=[(322, 1464, 642, 1528)])
        linked = (92, 1462, 652, 1530)
    back = shot.pt(70, 196)
    highlight_circle(p, back, 40)
    highlight(p, shot.box(linked, pad=4), radius=16)
    # The callout sits on the app bar next to the back arrow, so nothing else
    # on the screen is covered.
    label = "Tap back to compress"
    fnt = font(BLACK, 38)
    box_w = text_width(fnt, label) + 56
    left = back[0] + 62
    box = callout(p, left + box_w / 2, back[1] - 43, label, width=box_w, height=86, title_size=38)
    pointer_left(p, box, back[0] + 46, back[1])
    draw_footer(p)
    return p.finish()


def own_sent() -> Image.Image:
    p = Poster()
    draw_header(p, pill(5), "Open WhatsApp", 'Clips go to your "Message yourself" chat')
    shot = place_shot(p, OWN_SRC / "sent_to_whtsapp_sendyourself_4.png", (0, 0, 1080, 2116),
                      HEADER_H_SUB, blurs=[(300, 1568, 634, 1634)])
    button = shot.box((105, 1772, 975, 1910))
    highlight(p, button, radius=52)
    callout(p, W / 2, button[3] + 30, "Tap Open WhatsApp", [
        'It opens your "Message yourself" chat.',
    ], width=720, height=168)
    draw_footer(p)
    return p.finish()


def bot_ready() -> Image.Image:
    p = Poster()
    draw_header(p, pill(5), "Open WhatsApp", "Send this code from your main WhatsApp")
    shot = place_shot(p, BOT_SRC / "as_bot_activation_code_sending_4.png", (0, 0, 1080, 2130),
                      HEADER_H_SUB, blurs=[(306, 1170, 554, 1224)])
    button = shot.box((105, 1787, 975, 1925))
    highlight(p, button, radius=52)
    callout(p, W / 2, button[3] + 30, "Tap Open WhatsApp", [
        "Your bot's chat opens with the code filled in.",
    ], width=720, height=168)
    draw_footer(p)
    return p.finish()


# ---------------------------------------------------------------------------
# Own-number flow, steps 6-7: open the clip and save it
# ---------------------------------------------------------------------------
def own_open_video() -> Image.Image:
    p = Poster()
    draw_header(p, pill(6), "Open your video", 'It is in your "Message yourself" chat')
    shot = place_shot(p, OWN_SRC / "recieving_sendyourself_5.png", (0, 0, 1536, 1745), HEADER_H_SUB,
                      blurs=[(338, 136, 716, 222)])
    video = shot.box((477, 497, 1479, 1565), pad=4)
    highlight(p, video, radius=26)
    callout(p, (video[0] + video[2]) / 2, 860, "Tap your video", width=400)
    callout(p, W / 2, 1300, "Don't forward this copy yet", [
        "Forwarding it straight to Status makes WhatsApp compress it again. For full HD:",
        "1 Open it and tap Download (next step).",
        "2 Send it again from Gallery, with your caption.",
        "3 Forward that new copy to My Status.",
    ], width=740, align="left", title_size=42, title_color=YELLOW, body_size=28)
    draw_footer(p)
    return p.finish()


def own_download() -> Image.Image:
    p = Poster()
    draw_header(p, pill(7), "Tap Download", "Save the full-quality copy to Gallery")
    shot = place_shot(p, OWN_SRC / "saving_sendyourself_byclicking_download_6.png",
                      (0, 0, 1536, 2752), HEADER_H_SUB, fill=(10, 12, 14))
    icon = shot.pt(967, 210)
    highlight_circle(p, icon, 40)
    box = callout(p, 430, 560, "Tap Download", ["It saves the video to your Gallery."], width=520)
    arrow(p, (box[2] - 70, box[1] - 4), (icon[0] + 6, icon[1] + 46), bend=0.2)
    callout(p, W / 2, 1694, "Next: send it again", [
        "Attach > Gallery in any chat, add your caption and send. Then forward that new copy.",
    ], width=740, height=188)
    draw_footer(p)
    return p.finish()


# ---------------------------------------------------------------------------
# Original posters, re-headed for the 13-step flows
# ---------------------------------------------------------------------------
def reheader(path: Path, header_end: int, step: int, title: str, subtitle: str | None = None):
    old = Image.open(path).convert("RGB")
    if old.size != (W, H):
        raise ValueError(f"{path.name}: expected {W}x{H}, got {old.size}")
    band = Poster(height=header_end)
    draw_header(band, pill(step), title, subtitle, height=header_end)
    out = old.copy()
    out.paste(band.finish(), (0, 0))
    return out


def bot_send_code() -> Image.Image:
    out = reheader(BOT_SRC / "05-send-the-code.png", 199, 6, "Send the code")
    # The original shows the StatusDrop-number message. The self-host bot gets
    # the app's prefilled "Hi! My StatusDrop code is ..." text instead.
    draw = ImageDraw.Draw(out)
    draw.rectangle((92, 1702, 590, 1826), fill=(24, 33, 37))
    fnt = ImageFont.truetype(str(REGULAR), 31)
    draw.text((101, 1756), "Hi! My StatusDrop code is", font=fnt, fill=(238, 240, 242), anchor="ls")
    draw.text((101, 1794), BOT_CODE, font=fnt, fill=(238, 240, 242), anchor="ls")
    return out


SHARED_TAIL = [
    # file, header end, title, subtitle
    ("07-open-chat-and-gallery.png", 251, "Open a chat & Gallery", "Any chat works. You can message yourself."),
    ("08-select-your-video.png", 207, "Select your video", None),
    ("09-add-caption-and-send.png", 204, "Add a caption & send", None),
    ("10-forward-the-new-video.png", 203, "Forward the new video", None),
    ("11-choose-status-and-send.png", 197, "Choose My status & send", None),
    ("12-status-posted.png", 203, "Done! Status posted", None),
]


def build() -> dict[str, Image.Image]:
    posters: dict[str, Image.Image] = {
        "setup/setup_01.webp": setup_hd(),
        "setup/setup_02.webp": setup_delivery(),
        "own/step_01.webp": choose_method(bot=False),
        "own/step_02.webp": copy_code(bot=False),
        "own/step_03.webp": paste_code(bot=False),
        "own/step_04.webp": go_back(bot=False),
        "own/step_05.webp": own_sent(),
        "own/step_06.webp": own_open_video(),
        "own/step_07.webp": own_download(),
        "bot/step_01.webp": choose_method(bot=True),
        "bot/step_02.webp": copy_code(bot=True),
        "bot/step_03.webp": paste_code(bot=True),
        "bot/step_04.webp": go_back(bot=True),
        "bot/step_05.webp": bot_ready(),
        "bot/step_06.webp": bot_send_code(),
        "bot/step_07.webp": reheader(BOT_SRC / "06-read-and-download.png", 200, 7, "Read & download"),
    }
    for index, (name, header_end, title, subtitle) in enumerate(SHARED_TAIL, start=8):
        posters[f"shared/step_{index:02d}.webp"] = reheader(BOT_SRC / name, header_end, index, title,
                                                            subtitle)
    return posters


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--preview", type=Path, help="also write a PNG contact sheet per folder here")
    args = parser.parse_args()

    posters = build()
    for rel, image in posters.items():
        target = OUTPUT / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        image.save(target, format="WEBP", quality=90, method=6)
        print(f"{rel}: {image.width}x{image.height}, {target.stat().st_size // 1024} KB")

    if args.preview:
        args.preview.mkdir(parents=True, exist_ok=True)
        groups: dict[str, list[Image.Image]] = {}
        for rel, image in posters.items():
            groups.setdefault(rel.split("/")[0], []).append(image)
        for group, images in groups.items():
            thumb_w, thumb_h = W // 2, H // 2
            sheet = Image.new("RGB", (thumb_w * len(images), thumb_h), (255, 0, 255))
            for i, image in enumerate(images):
                sheet.paste(image.resize((thumb_w, thumb_h), Image.LANCZOS), (i * thumb_w, 0))
            sheet.save(args.preview / f"{group}.png")


if __name__ == "__main__":
    main()
