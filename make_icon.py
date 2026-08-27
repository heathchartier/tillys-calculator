"""
Tilly's Cut Calc — app icon generator.
Matches CutListIQ's actual icon (not its make_icon.py's plain 3x3 grid, which was never what
shipped): an offset/staggered guillotine cut, not a symmetric tic-tac-toe grid — one dominant
box, cut lines that don't line up across rows, like a real nested cut layout.

Layout: one big top box spanning the full width (holds "Tilly's" so the icon reads at a glance),
then the bottom strip splits into a narrow empty box + a wider box holding "IQ" — mirroring
CutListIQ's bottom-row proportions.
"""
from PIL import Image, ImageDraw, ImageFont
import os

OUT_DIR = r"C:\Users\heath\Documents\tillys-calculator"

BG = (15, 17, 18)          # #0f1112
PANEL = (26, 29, 33)       # #1a1d21
TEAL = (0, 229, 184)       # #00e5b8
WHITE = (240, 242, 245)    # #f0f2f5
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

def fit_font(draw, text, max_width, start_size, min_size=10):
    size = start_size
    while size > min_size:
        font = load_font(size)
        bbox = draw.textbbox((0, 0), text, font=font)
        if (bbox[2] - bbox[0]) <= max_width:
            return font, bbox
        size -= 2
    font = load_font(min_size)
    return font, draw.textbbox((0, 0), text, font=font)

def rounded_rect(draw, xy, radius, fill):
    x0, y0, x1, y1 = xy
    if radius <= 0:
        draw.rectangle(xy, fill=fill)
        return
    draw.rectangle([x0 + radius, y0, x1 - radius, y1], fill=fill)
    draw.rectangle([x0, y0 + radius, x1, y1 - radius], fill=fill)
    draw.ellipse([x0, y0, x0 + radius * 2, y0 + radius * 2], fill=fill)
    draw.ellipse([x1 - radius * 2, y0, x1, y0 + radius * 2], fill=fill)
    draw.ellipse([x0, y1 - radius * 2, x0 + radius * 2, y1], fill=fill)
    draw.ellipse([x1 - radius * 2, y1 - radius * 2, x1, y1], fill=fill)

def build(size, out_path, show_text=True, corner_radius_frac=0.14):
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    radius = int(size * corner_radius_frac)
    rounded_rect(draw, (0, 0, size, size), radius, BG)

    margin = int(size * 0.10)
    x0, y0, x1, y1 = margin, margin, size - margin, size - margin
    w, h = x1 - x0, y1 - y0

    # Sheet panel fill
    draw.rectangle([x0 + 1, y0 + 1, x1 - 1, y1 - 1], fill=PANEL)

    # Offset guillotine cut: one full-width horizontal cut (top box dominant),
    # then the bottom strip gets one vertical cut at a different position than
    # a centered grid would — this is what avoids the tic-tac-toe look.
    h_cut = y0 + int(h * 0.56)
    v_cut = x0 + int(w * 0.37)

    line_w = max(2, size // 75)
    glow_w = line_w * 3

    glow_img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow_img)
    glow_color = (0, 229, 184, 45)
    glow_draw.line([(x0, h_cut), (x1, h_cut)], fill=glow_color, width=glow_w)
    glow_draw.line([(v_cut, h_cut), (v_cut, y1)], fill=glow_color, width=glow_w)
    img = Image.alpha_composite(img, glow_img)
    draw = ImageDraw.Draw(img)

    draw.line([(x0, h_cut), (x1, h_cut)], fill=TEAL, width=line_w)
    draw.line([(v_cut, h_cut), (v_cut, y1)], fill=TEAL, width=line_w)

    tick = max(2, size // 130)
    draw.ellipse([v_cut - tick, h_cut - tick, v_cut + tick, h_cut + tick], fill=TEAL)

    draw.rectangle([x0, y0, x1, y1], outline=BORDER, width=max(1, size // 260))

    if show_text:
        # "Tilly's" — big, white, centered in the dominant top box
        top_box_w = w - int(size * 0.06)
        font, bbox = fit_font(draw, "Tilly's", top_box_w, int(size * 0.20))
        tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
        tx = x0 + (w - tw) / 2 - bbox[0]
        ty = y0 + ((h_cut - y0) - th) / 2 - bbox[1]
        draw.text((tx, ty), "Tilly's", font=font, fill=WHITE)

        # "IQ" — teal, in the bottom-right box
        if size >= 96:
            iq_box_w = (x1 - v_cut) - int(size * 0.05)
            font_iq, bbox_iq = fit_font(draw, "IQ", iq_box_w, int(size * 0.13))
            tw2, th2 = bbox_iq[2] - bbox_iq[0], bbox_iq[3] - bbox_iq[1]
            ix = v_cut + ((x1 - v_cut) - tw2) / 2 - bbox_iq[0]
            iy = h_cut + ((y1 - h_cut) - th2) / 2 - bbox_iq[1]
            draw.text((ix, iy), "IQ", font=font_iq, fill=TEAL)

    final = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    final = Image.alpha_composite(final, img)
    final.save(out_path, 'PNG')
    print(f"Saved {out_path} ({size}x{size})")

if __name__ == "__main__":
    build(512, os.path.join(OUT_DIR, "icon-512.png"))
    build(192, os.path.join(OUT_DIR, "icon-192.png"))
    build(180, os.path.join(OUT_DIR, "apple-touch-icon.png"), corner_radius_frac=0.0)
    build(32, os.path.join(OUT_DIR, "favicon-32.png"), show_text=False)
    print("Done.")
