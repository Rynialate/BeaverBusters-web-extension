"""Generate the extension icons (brown shield with a check mark).

Usage: python3 scripts/make-icons.py
Requires Pillow. The generated PNGs are committed, so this only needs to run
when the design changes.
"""
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "src" / "icons"
SIZES = [16, 32, 48, 128]
S = 1024  # draw large, then downscale for smooth edges

BROWN = (138, 79, 29, 255)
BROWN_DARK = (98, 54, 18, 255)
CREAM = (255, 246, 232, 255)


def shield(scale_inset=0):
    i = scale_inset
    top = 70 + i
    return [
        (S * 0.5, top),
        (S * 0.88 - i, S * 0.2 + i * 0.4),
        (S * 0.88 - i, S * 0.5),
        (S * 0.84 - i, S * 0.66),
        (S * 0.72 - i * 0.8, S * 0.82 - i * 0.4),
        (S * 0.5, S * 0.95 - i),
        (S * 0.28 + i * 0.8, S * 0.82 - i * 0.4),
        (S * 0.16 + i, S * 0.66),
        (S * 0.12 + i, S * 0.5),
        (S * 0.12 + i, S * 0.2 + i * 0.4),
    ]


def draw():
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.polygon(shield(), fill=BROWN_DARK)
    d.polygon(shield(36), fill=BROWN)
    # check mark
    w = 96
    pts = [(S * 0.31, S * 0.5), (S * 0.45, S * 0.64), (S * 0.71, S * 0.36)]
    d.line(pts, fill=CREAM, width=w, joint="curve")
    for x, y in (pts[0], pts[2]):
        d.ellipse([x - w / 2, y - w / 2, x + w / 2, y + w / 2], fill=CREAM)
    return img


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    big = draw()
    for size in SIZES:
        big.resize((size, size), Image.LANCZOS).save(OUT / f"icon-{size}.png", optimize=True)
        print("wrote", OUT / f"icon-{size}.png")


if __name__ == "__main__":
    main()
