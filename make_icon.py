"""
Tilly's Cut Calc — app icon generator.
Matches the established IQ-brand icon language (see CutListIQ's make_icon.py, LBI's icon-512.png):
near-black rounded-square background, a sheet-good panel divided by teal cut lines, teal "IQ" badge.
Reused here because Tilly's is itself a cut-list optimizer — the motif is a literal, not just
brand-matched, fit.
"""
from PIL import Image, ImageDraw, ImageFont
import os

OUT_DIR = r"C:\Users\heath\Documents\tillys-calculator"

BG = (15, 17, 18)          # #0f1112
PANEL = (26, 29, 33)       # #1a1d21
TEAL = (0, 229, 184)       # #00e5b8
BORDER = (58, 65, 73)      # #3a4149

FONT_PATHS = [
    r"C:\Windows\Fonts\ariblk.ttf",
    r"C:\Windows\Fonts\arialbd.ttf",
]

def load_font(size):
    for fp in FONT_PATHS:
        if os.path.exists(fp):
            try:
                return ImageFont.truetype(fp, size)
            except Exception:
                pass
    return ImageFont.load_default()

def rounded_rect(draw, xy, radius, fill):
    x0, y0, x1, y1 = xy
    draw.rectangle([x0 + radius, y0, x1 - radius, y1], fill=fill)
    draw.rectangle([x0, y0 + radius, x1, y1 - radius], fill=fill)
    draw.ellipse([x0, y0, x0 + radius * 2, y0 + radius * 2], fill=fill)
    draw.ellipse([x1 - radius * 2, y0, x1, y0 + radius * 2], fill=fill)
    draw.ellipse([x0, y1 - radius * 2, x0 + radius * 2, y1], fill=fill)
    draw.ellipse([x1 - radius * 2, y1 - radius * 2, x1, y1], fill=fill)

def build(size, out_path, detailed=True, corner_radius_frac=0.14, simple_grid=False):
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    radius = int(size * corner_radius_frac)
    rounded_rect(draw, (0, 0, size, size), radius, BG)

    margin = int(size * 0.10)
    x0, y0, x1, y1 = margin, margin, size - margin, size - margin
    w, h = x1 - x0, y1 - y0

    # Sheet panel fill
    draw.rectangle([x0 + 1, y0 + 1, x1 - 1, y1 - 1], fill=PANEL)

    if detailed:
        # Subtle grain
        for y in range(y0 + 1, y1, max(4, size // 90)):
            v = 4 if (y % 15 == 0) else 2
            c = (PANEL[0] + v, PANEL[1] + v, PANEL[2] + v, 255)
            draw.line([(x0 + 1, y), (x1 - 1, y)], fill=c, width=1)

    line_w = max(2, size // 75)
    if simple_grid:
        v_cuts = [x0 + int(w * 0.50)]
        h_cuts = [y0 + int(h * 0.50)]
    else:
        v_cuts = [x0 + int(w * 0.38), x0 + int(w * 0.68)]
        h_cuts = [y0 + int(h * 0.42), y0 + int(h * 0.70)]

    if detailed:
        glow_img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
        glow_draw = ImageDraw.Draw(glow_img)
        glow_w = line_w * 3
        glow_color = (0, 229, 184, 45)
        for x in v_cuts:
            glow_draw.line([(x, y0), (x, y1)], fill=glow_color, width=glow_w)
        for y in h_cuts:
            glow_draw.line([(x0, y), (x1, y)], fill=glow_color, width=glow_w)
        img = Image.alpha_composite(img, glow_img)
        draw = ImageDraw.Draw(img)

    for x in v_cuts:
        draw.line([(x, y0), (x, y1)], fill=TEAL, width=line_w)
    for y in h_cuts:
        draw.line([(x0, y), (x1, y)], fill=TEAL, width=line_w)

    tick = max(2, size // 130)
    for x in v_cuts:
        for y in h_cuts:
            draw.ellipse([x - tick, y - tick, x + tick, y + tick], fill=TEAL)

    draw.rectangle([x0, y0, x1, y1], outline=BORDER, width=max(1, size // 260))

    # Teal "IQ" badge, bottom-right of the sheet
    if size >= 96:
        font_size = int(size * 0.13)
        font = load_font(font_size)
        text = "IQ"
        bbox = draw.textbbox((0, 0), text, font=font)
        tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
        pad_x, pad_y = int(size * 0.027), int(size * 0.016)
        bx1 = x1 - int(size * 0.008)
        by1 = y1 - int(size * 0.008)
        bx0 = bx1 - tw - pad_x * 2
        by0 = by1 - th - pad_y * 2
        rounded_rect(draw, (bx0, by0, bx1, by1), int(size * 0.02), TEAL)
        draw.text((bx0 + pad_x - bbox[0], by0 + pad_y - bbox[1]), text, font=font, fill=BG)

    final = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    final = Image.alpha_composite(final, img)
    final.save(out_path, 'PNG')
    print(f"Saved {out_path} ({size}x{size})")

if __name__ == "__main__":
    build(512, os.path.join(OUT_DIR, "icon-512.png"), detailed=True)
    build(192, os.path.join(OUT_DIR, "icon-192.png"), detailed=True)
    build(180, os.path.join(OUT_DIR, "apple-touch-icon.png"), detailed=True, corner_radius_frac=0.0)
    build(32, os.path.join(OUT_DIR, "favicon-32.png"), detailed=False, simple_grid=True)
    print("Done.")
