"""Build optimized in-app tutorial assets from the private guide sources."""

from pathlib import Path

from PIL import Image

APP_ROOT = Path(__file__).resolve().parents[1]
WORKSPACE = APP_ROOT.parents[1]
OUTPUT = APP_ROOT / "assets" / "tutorial"

SOURCES = [
    APP_ROOT / "source_art" / "whatsapp_status_guide_step_01.jpeg",
    WORKSPACE / "public" / "tutorial" / "02-send-the-code.png",
    WORKSPACE / "public" / "tutorial" / "03-read-and-download.png",
    WORKSPACE / "public" / "tutorial" / "04-open-chat-and-gallery.png",
    WORKSPACE / "public" / "tutorial" / "05-select-your-video.png",
    WORKSPACE / "public" / "tutorial" / "06-add-caption-and-send.png",
    WORKSPACE / "public" / "tutorial" / "07-forward-the-new-video.png",
    WORKSPACE / "public" / "tutorial" / "08-choose-status-and-send.png",
    WORKSPACE / "public" / "tutorial" / "09-status-posted.png",
]


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    for index, source in enumerate(SOURCES, start=1):
        image = Image.open(source).convert("RGB")
        target = OUTPUT / f"step_{index:02d}.webp"
        image.save(target, format="WEBP", quality=92, method=6)
        print(f"{target.name}: {image.width}x{image.height}, {target.stat().st_size} bytes")


if __name__ == "__main__":
    main()
