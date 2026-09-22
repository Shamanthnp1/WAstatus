from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "play" / "assets" / "screenshots_raw"
OUTPUT = ROOT / "play" / "assets" / "screenshots"
OUTPUT.mkdir(parents=True, exist_ok=True)

for index, name in enumerate(("home", "tutorial", "zoom", "about"), start=1):
    image = Image.open(SOURCE / f"{name}.png").convert("RGB")
    width, height = image.size
    target_height = round(width * 16 / 9)
    top = 0 if name in {"home", "about", "zoom"} else max(0, (height - target_height) // 2)
    crop = image.crop((0, top, width, min(height, top + target_height)))
    if crop.height < target_height:
        canvas = Image.new("RGB", (width, target_height), "#07170f")
        canvas.paste(crop, (0, 0))
        crop = canvas
    target = OUTPUT / f"{index:02d}_{name}.png"
    crop.save(target, optimize=True)
    print(f"{target.name}|{crop.width}x{crop.height}|{target.stat().st_size}")
