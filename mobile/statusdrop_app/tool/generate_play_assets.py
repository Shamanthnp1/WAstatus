"""Generate Google Play listing graphics from original StatusDrop branding."""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

APP_ROOT = Path(__file__).resolve().parents[1]
WORKSPACE = APP_ROOT.parents[1]
OUTPUT = APP_ROOT / "play" / "assets"


def font(size: int, bold: bool = False):
    candidates = [
        Path(f"C:/Windows/Fonts/{'segoeuib' if bold else 'segoeui'}.ttf"),
        Path(f"C:/Windows/Fonts/{'arialbd' if bold else 'arial'}.ttf"),
        Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
    ]
    source = next((path for path in candidates if path.exists()), None)
    return ImageFont.truetype(str(source), size) if source else ImageFont.load_default()


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    width, height = 1024, 500
    image = Image.new("RGB", (width, height), "#07170f")
    draw = ImageDraw.Draw(image)

    start = (14, 113, 58)
    end = (4, 35, 19)
    for x in range(width):
        ratio = x / (width - 1)
        color = tuple(round(start[i] * (1 - ratio) + end[i] * ratio) for i in range(3))
        draw.line((x, 0, x, height), fill=color)

    draw.ellipse((720, -210, 1170, 240), fill="#137a3e")
    draw.ellipse((810, 260, 1090, 540), fill="#0d5b31")

    logo = Image.open(WORKSPACE / "public" / "logo.png").convert("RGB").resize((250, 250), Image.Resampling.LANCZOS)
    image.paste(logo, (704, 125))

    draw.text((70, 82), "StatusDrop", font=font(65, bold=True), fill="#ffffff")
    draw.text((72, 176), "HD status clips.", font=font(48, bold=True), fill="#d9f7e5")
    draw.text((72, 235), "Made on your phone.", font=font(48, bold=True), fill="#d9f7e5")
    draw.text((73, 332), "Local processing  •  No login  •  Accessible", font=font(24), fill="#b9d9c5")
    draw.text((73, 382), "Independent open-source Android client", font=font(21), fill="#8fbaa0")

    image.save(OUTPUT / "feature_graphic.png", format="PNG", optimize=True)
    icon = Image.open(APP_ROOT / "assets" / "images" / "statusdrop_logo.png").convert("RGB")
    icon.save(OUTPUT / "app_icon_512.png", format="PNG", optimize=True)


if __name__ == "__main__":
    main()
