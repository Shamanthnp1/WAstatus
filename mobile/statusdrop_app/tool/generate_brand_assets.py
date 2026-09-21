"""Generate the original StatusDrop HD Check brand assets.

The generated mark is intentionally independent from WhatsApp/Meta branding.
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

APP_ROOT = Path(__file__).resolve().parents[1]
WORKSPACE = APP_ROOT.parents[1]
RES_ROOT = APP_ROOT / "android" / "app" / "src" / "main" / "res"


def find_bold_font() -> Path | None:
    candidates = [
        Path("C:/Windows/Fonts/arialbd.ttf"),
        Path("C:/Windows/Fonts/segoeuib.ttf"),
        Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
    ]
    return next((candidate for candidate in candidates if candidate.exists()), None)


def font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    source = find_bold_font()
    return ImageFont.truetype(str(source), size) if source else ImageFont.load_default()


def gradient(size: int) -> Image.Image:
    start = (32, 173, 97)
    end = (7, 92, 45)
    image = Image.new("RGB", (size, size))
    pixels = image.load()
    for y in range(size):
        for x in range(size):
            ratio = (x + y) / (2 * max(1, size - 1))
            pixels[x, y] = tuple(
                round(start[channel] * (1 - ratio) + end[channel] * ratio)
                for channel in range(3)
            )
    return image


def hd_symbol(size: int, *, background: bool) -> Image.Image:
    mode = "RGB" if background else "RGBA"
    image = gradient(size).convert(mode) if background else Image.new(mode, (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    if background:
        radius = round(size * 0.245)
        mask = Image.new("L", (size, size), 0)
        ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
        transparent = Image.new(mode, (size, size), (0, 0, 0, 0) if mode == "RGBA" else (19, 122, 62))
        transparent.paste(image, mask=mask)
        image = transparent
        draw = ImageDraw.Draw(image)
        draw.ellipse(
            (size * 0.51, -size * 0.09, size * 1.09, size * 0.49),
            fill=(255, 255, 255, 15) if mode == "RGBA" else (41, 145, 77),
        )

    hd_font = font(round(size * 0.405))
    text = "HD"
    box = draw.textbbox((0, 0), text, font=hd_font, stroke_width=0)
    text_width = box[2] - box[0]
    text_height = box[3] - box[1]
    text_x = size * 0.5 - text_width / 2
    text_y = size * 0.47 - text_height / 2 - box[1]
    draw.text((text_x, text_y), text, font=hd_font, fill="white", spacing=-round(size * 0.03))

    badge_x = size * 0.77
    badge_y = size * 0.77
    badge_radius = size * 0.185
    draw.ellipse(
        (
            badge_x - badge_radius,
            badge_y - badge_radius,
            badge_x + badge_radius,
            badge_y + badge_radius,
        ),
        fill="white",
        outline=(11, 103, 52),
        width=max(1, round(size * 0.027)),
    )
    draw.line(
        (
            badge_x - badge_radius * 0.50,
            badge_y,
            badge_x - badge_radius * 0.15,
            badge_y + badge_radius * 0.36,
            badge_x + badge_radius * 0.56,
            badge_y - badge_radius * 0.42,
        ),
        fill=(19, 122, 62),
        width=max(2, round(size * 0.053)),
        joint="curve",
    )
    return image


def hd_monochrome(size: int) -> Image.Image:
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    hd_font = font(round(size * 0.405))
    box = draw.textbbox((0, 0), "HD", font=hd_font, stroke_width=0)
    text_width = box[2] - box[0]
    text_height = box[3] - box[1]
    text_x = size * 0.5 - text_width / 2
    text_y = size * 0.47 - text_height / 2 - box[1]
    draw.text((text_x, text_y), "HD", font=hd_font, fill="white")

    badge_x = size * 0.77
    badge_y = size * 0.77
    badge_radius = size * 0.185
    draw.ellipse(
        (
            badge_x - badge_radius,
            badge_y - badge_radius,
            badge_x + badge_radius,
            badge_y + badge_radius,
        ),
        outline="white",
        width=max(2, round(size * 0.040)),
    )
    draw.line(
        (
            badge_x - badge_radius * 0.50,
            badge_y,
            badge_x - badge_radius * 0.15,
            badge_y + badge_radius * 0.36,
            badge_x + badge_radius * 0.56,
            badge_y - badge_radius * 0.42,
        ),
        fill="white",
        width=max(2, round(size * 0.053)),
        joint="curve",
    )
    return image


def save_png(image: Image.Image, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    image.save(target, format="PNG", optimize=True)


def main() -> None:
    master = hd_symbol(1024, background=True)
    save_png(master, WORKSPACE / "public" / "logo.png")
    save_png(master.resize((512, 512), Image.Resampling.LANCZOS), APP_ROOT / "assets" / "images" / "statusdrop_logo.png")

    densities = {
        "mipmap-mdpi": 48,
        "mipmap-hdpi": 72,
        "mipmap-xhdpi": 96,
        "mipmap-xxhdpi": 144,
        "mipmap-xxxhdpi": 192,
    }
    for folder, size in densities.items():
        save_png(master.resize((size, size), Image.Resampling.LANCZOS), RES_ROOT / folder / "ic_launcher.png")
        save_png(master.resize((size, size), Image.Resampling.LANCZOS), RES_ROOT / folder / "ic_launcher_round.png")

    # Adaptive icons use a separate background layer and a mask-safe foreground.
    foreground = Image.new("RGBA", (432, 432), (0, 0, 0, 0))
    foreground_symbol = hd_symbol(320, background=False)
    foreground.paste(foreground_symbol, (56, 56), foreground_symbol)
    save_png(foreground, RES_ROOT / "drawable-nodpi" / "ic_launcher_foreground.png")

    monochrome = Image.new("RGBA", (432, 432), (0, 0, 0, 0))
    monochrome_symbol = hd_monochrome(320)
    monochrome.paste(monochrome_symbol, (56, 56), monochrome_symbol)
    save_png(monochrome, RES_ROOT / "drawable-nodpi" / "ic_launcher_monochrome.png")


if __name__ == "__main__":
    main()
