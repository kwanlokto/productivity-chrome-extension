#!/usr/bin/env python3
"""Generate Focus Guard's leaf icons (16/48/128) from one SVG source.

Indigo rounded background (matches the app accent #6366f1) with a fresh green
leaf and a clean central vein. Run: python3 make_icons.py
"""
import cairosvg

# A diagonal leaf: symmetric almond body pointing up, rotated for a natural
# tilt, with a curved midrib + a couple of side veins and a short stem.
SVG = """<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#7c83f6"/>
      <stop offset="1" stop-color="#4f46e5"/>
    </linearGradient>
    <linearGradient id="leaf" x1="0.2" y1="0.1" x2="0.8" y2="1">
      <stop offset="0" stop-color="#86efac"/>
      <stop offset="0.55" stop-color="#34d399"/>
      <stop offset="1" stop-color="#10b981"/>
    </linearGradient>
  </defs>

  <!-- background -->
  <rect x="6" y="6" width="116" height="116" rx="30" fill="url(#bg)"/>

  <!-- leaf, tilted -45deg for a natural diagonal -->
  <g transform="rotate(-45 64 64)">
    <!-- short stem -->
    <path d="M64 104 q0 8 -5 14" fill="none" stroke="#0f8a5f"
          stroke-width="6" stroke-linecap="round"/>
    <!-- leaf body -->
    <path d="M64 24
             C 36 42 34 78 64 106
             C 94 78 92 42 64 24 Z"
          fill="url(#leaf)"/>
    <!-- midrib + side veins -->
    <g fill="none" stroke="#ecfdf5" stroke-width="4"
       stroke-linecap="round" opacity="0.92">
      <path d="M64 100 C 62 74 62 50 64 32"/>
      <path d="M63 70 q -14 -2 -22 -12" stroke-width="3.2"/>
      <path d="M64 84 q 13 -2 20 -11" stroke-width="3.2"/>
    </g>
  </g>
</svg>"""

# A simplified, bolder leaf for 16px — bigger body, deeper green, thin vein, no
# side veins, so it stays legible in the toolbar.
SVG_SMALL = """<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#7c83f6"/>
      <stop offset="1" stop-color="#4f46e5"/>
    </linearGradient>
    <linearGradient id="leaf" x1="0.2" y1="0.1" x2="0.8" y2="1">
      <stop offset="0" stop-color="#6ee7a8"/>
      <stop offset="1" stop-color="#16a34a"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="128" height="128" rx="28" fill="url(#bg)"/>
  <g transform="rotate(-45 64 64)">
    <path d="M64 14
             C 26 38 24 86 64 118
             C 104 86 102 38 64 14 Z"
          fill="url(#leaf)"/>
    <path d="M64 110 C 61 76 61 48 64 24" fill="none"
          stroke="#f0fdf4" stroke-width="6" stroke-linecap="round" opacity="0.95"/>
  </g>
</svg>"""

for size in (48, 128):
    cairosvg.svg2png(bytestring=SVG.encode(), write_to=f"icon{size}.png",
                     output_width=size, output_height=size)

cairosvg.svg2png(bytestring=SVG_SMALL.encode(), write_to="icon16.png",
                 output_width=16, output_height=16)

print("wrote icon16.png, icon48.png, icon128.png")
