"""Render the brand's vector social card using the project's Jost font.

Run from any directory with ImageMagick installed:
uv run --with fonttools --with brotli python apps/meeting/scripts/generate-social-image.py
"""

from html import escape
from pathlib import Path
import subprocess

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont


ROOT = Path(__file__).resolve().parents[1]
FONT = ROOT / "node_modules/@fontsource-variable/jost/files/jost-latin-wght-normal.woff2"
font = instantiateVariableFont(TTFont(FONT), {"wght": 500})
glyphs = font.getGlyphSet()
cmap = font.getBestCmap()
units = font["head"].unitsPerEm
parts = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">',
    '<title>Weave In — Browser meetings, every voice woven in</title>',
    '<rect width="1200" height="630" fill="#141A33"/>',
]


def rect(x, y, width, height, color, radius=0):
    parts.append(f'<rect x="{x}" y="{y}" width="{width}" height="{height}" rx="{radius}" fill="{color}"/>')


def text(value, x, baseline, size, color="#F3EEE3"):
    scale = size / units
    parts.append(f'<g aria-label="{escape(value)}" fill="{color}" transform="translate({x} {baseline}) scale({scale} {-scale})">')
    advance = 0
    for char in value:
        glyph = glyphs[cmap[ord(char)]]
        pen = SVGPathPen(glyphs)
        glyph.draw(pen)
        path = pen.getCommands()
        if path:
            parts.append(f'<path transform="translate({advance} 0)" d="{path}"/>')
        advance += glyph.width
    parts.append('</g>')


# Reuse the exact woven mark, independent of installed system fonts.
mark = (ROOT / "public/favicon.svg").read_text()
mark = mark[mark.index('>') + 1:mark.rindex('</svg>')]
parts.append(f'<g transform="translate(62 52) scale(0.875)">{mark}</g>')
text("Weave In", 132, 92, 36)
text("Keep the thread.", 64, 247, 66)
text("Weave everyone in.", 64, 320, 66)
text("Meet in your browser.", 66, 393, 30, "#C9C4B8")
text("Video, screen sharing, and chat.", 66, 435, 26, "#C9C4B8")
rect(64, 514, 1072, 1, "#303A6B")
text("One link. No account needed.", 64, 568, 24)
text("weave.nycu.ai", 922, 568, 24, "#E9B44C")

# The incumbent draft: coloured warp threads interlaced with cotton weft.
colors = ["#E0563F", "#E9B44C", "#5FC7A2", "#7FB3E6", "#B79BE8", "#F4A27E"]
for column, color in enumerate(colors):
    rect(814 + column * 48, 118, 28, 338, color, 3)
for row in range(6):
    y = 153 + row * 48
    rect(786, y, 342, 28, "#F3EEE3", 3)
    for column, color in enumerate(colors):
        if (column + row) % 2 == 0:
            rect(814 + column * 48, y, 28, 28, color)
parts.append('</svg>')

source = ROOT / "public/og-image.svg"
source.write_text('\n'.join(parts) + '\n')
output = ROOT / "public/og-image.png"
subprocess.run(["magick", "-background", "#141A33", str(source), "-strip", f"PNG24:{output}"], check=True)
print(f"Generated {output} (1200 × 630) and {source}")
