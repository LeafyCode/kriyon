"""Draws Kriyon's three [Mascot]s -- Gem, Visor and Hex, glowing AI orbs with
faces -- as layered vector art and writes them as React components to
src/structured/mascotArt.tsx.

Each sits in a 200x200 box, built from flat shapes, with every moving part
in its own <g className="..."> that mascot.css animates: the whole figure
(it floats), its halo, its body, eight faces (one shows at a time, by
`data-face`), thought bubbles, an "aha" spark, little orbiting lights, and
each one's own parts (the Gem's glint, the Visor's scan line, the Hex's
facets).

Colours: the hue is the user's choice, so the hued colours are drawn as CSS
variables (--kr-m-<name>) the component sets from tokens.mascot.hues; the
rest (whites, the mouth, the spark) are named in tokens.mascot. This script
maps each hex it draws with to one or the other, and fails on one with no
name.

Run: python3 scripts/mascots.py   (then pnpm fix)"""
import math
import re
import sys

FACES = ("happy", "curious", "thinking", "surprised", "sleepy", "wink", "laugh", "puzzled")

# The default hue, as drawn; the component swaps each for the chosen hue's.
HUED = {"#3f4fc9": "shade0", "#5a6cf0": "shade1", "#7b8cff": "shade2", "#a3b0ff": "shade3",
        "#35429f": "deep", "#8fa2ff": "halo", "#141a4a": "ink"}
FIXED = {"#ffffff": "glint", "#eef1ff": "light", "#e9edf8": "thought", "#ffd45c": "spark",
         "#7a1f3d": "mouth", "#ff6f8e": "tongue"}

S0, S1, S2, S3, DEEP, HALO, INK = "#3f4fc9", "#5a6cf0", "#7b8cff", "#a3b0ff", "#35429f", "#8fa2ff", "#141a4a"
WHITE, LIGHT, MOUTH, TONGUE = "#ffffff", "#eef1ff", "#7a1f3d", "#ff6f8e"


def P(points, fill, extra=""):
    pts = " ".join(f"{x:.1f},{y:.1f}" for x, y in points)
    return f'<polygon points="{pts}" fill="{fill}"{extra}/>'


def ring(cx, cy, r, n, rot=0.0):
    return [(cx + r * math.cos(2 * math.pi * i / n + rot), cy + r * math.sin(2 * math.pi * i / n + rot)) for i in range(n)]


def line(d, color=INK, width=4.5):
    return f'<path d="{d}" stroke="{color}" stroke-width="{width}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>'


def halo():
    return (f'<g class="halo"><circle cx="100" cy="106" r="80" fill="{HALO}" opacity="0.16"/>'
            f'<circle cx="100" cy="106" r="71" fill="{HALO}" opacity="0.14"/></g>')


def extras(bubbles, spark):
    """Thought bubbles (small to large) and the "aha" spark, both hidden
    until mascot.css shows them, and three lights that circle it."""
    out = ['<g class="thought">']
    for i, (x, y, r) in enumerate(bubbles, start=1):
        out.append(f'<circle class="bubble bubble-{i}" cx="{x}" cy="{y}" r="{r}" fill="#e9edf8"/>')
    out.append('</g>')
    x, y = spark
    star = [(x, y - 11), (x + 3, y - 3), (x + 11, y), (x + 3, y + 3), (x, y + 11), (x - 3, y + 3), (x - 11, y), (x - 3, y - 3)]
    out.append('<g class="spark">' + P(star, "#ffd45c") + '</g>')
    out.append('<g class="orbit">' + "".join(
        f'<circle cx="{100 + 84 * math.cos(a):.1f}" cy="{106 + 84 * math.sin(a):.1f}" r="{r}" fill="#ffd45c"/>'
        for a, r in ((math.radians(-60), 4.5), (math.radians(60), 3.5), (math.radians(180), 3))) + '</g>')
    return out


def faces(drawn):
    out = ['<g class="head">']
    for name in FACES:
        out.append(f'<g class="face face-{name}">' + drawn[name] + '</g>')
    out.append('</g>')
    return out


# ---- face parts in dark ink (Gem, Hex) ----
def oval(x, y, rx, ry):
    return (f'<g class="blink"><ellipse cx="{x}" cy="{y}" rx="{rx}" ry="{ry}" fill="{INK}"/>'
            f'<circle cx="{x + rx * 0.35:.1f}" cy="{y - ry * 0.4:.1f}" r="{max(1.6, rx * 0.32):.1f}" fill="{WHITE}"/></g>')


def capsule(x, y, w, h):
    return (f'<g class="blink"><rect x="{x - w / 2:.1f}" y="{y - h / 2:.1f}" width="{w}" height="{h}" rx="{w / 2:.1f}" fill="{INK}"/>'
            f'<circle cx="{x + w * 0.18:.1f}" cy="{y - h * 0.3:.1f}" r="{w * 0.2:.1f}" fill="{WHITE}"/></g>')


def arc(x, y, w, up=True, color=INK, width=4.5):
    return line(f"M{x - w} {y} Q{x} {y - w if up else y + w} {x + w} {y}", color, width)


def ink_faces(eye, y=100, mouth_y=120):
    """The eight faces drawn in ink on a lit surface; `eye(x, y, big)` draws
    one open eye, so Gem's ovals and Hex's capsules share every face."""
    m = mouth_y
    return {
        "happy": eye(80, y, 1.0) + eye(120, y, 1.0) + line(f"M86 {m} Q100 {m + 14} 114 {m}"),
        "curious": eye(80, y, 0.85) + eye(121, y - 2, 1.25) + f'<ellipse cx="104" cy="{m + 4}" rx="5" ry="6" fill="{MOUTH}"/>',
        "thinking": eye(82, y - 3, 0.95) + eye(122, y - 5, 0.95) + line(f"M98 {m + 4} L114 {m + 1}")
                    + line(f"M72 {y - 14} L90 {y - 16}", width=3.5) + line(f"M112 {y - 18} L130 {y - 15}", width=3.5),
        "surprised": eye(80, y - 2, 1.3) + eye(120, y - 2, 1.3) + f'<ellipse cx="100" cy="{m + 6}" rx="8" ry="10" fill="{MOUTH}"/>',
        "sleepy": arc(80, y + 2, 8, up=False) + arc(120, y + 2, 8, up=False) + f'<ellipse cx="100" cy="{m + 2}" rx="4" ry="3" fill="{MOUTH}"/>'
                  + line("M140 70 h10 l-10 10 h10", "#e9edf8", 3),
        "wink": eye(80, y, 1.0) + arc(120, y + 2, 8)
                + f'<path d="M86 {m - 2} Q100 {m + 14} 114 {m - 2} Z" fill="{MOUTH}"/><path d="M96 {m + 6} Q101 {m + 11} 106 {m + 6} Z" fill="{TONGUE}"/>',
        "laugh": arc(80, y + 2, 8) + arc(120, y + 2, 8)
                 + f'<path d="M82 {m - 6} Q100 {m + 22} 118 {m - 6} Z" fill="{MOUTH}"/><path d="M92 {m + 6} Q100 {m + 16} 108 {m + 6} Z" fill="{TONGUE}"/>',
        "puzzled": eye(80, y, 1.0) + eye(120, y + 2, 0.7) + line(f"M110 {y - 16} L128 {y - 20}", width=3.5)
                   + line(f"M88 {m + 4} Q94 {m - 2} 100 {m + 4} Q106 {m + 10} 112 {m + 4}", width=4),
    }


# ---------------- Gem ----------------
def gem():
    """A gem-cut sphere: a lit cap at the top left, a shaded crescent at the
    bottom right, broad facets between; dark oval eyes with a glint."""
    cx, cy, R = 100, 106, 62
    out = [halo(), '<g class="body">']
    out.append(P(ring(cx, cy, R, 16), S1))
    out.append(P(ring(cx + 6, cy + 7, R - 6, 16, 0.1), S0))
    out.append(P(ring(cx - 2, cy - 2, R - 8, 16, 0.2), S1))
    out.append(P(ring(cx - 6, cy - 8, R - 14, 12, 0.3), S2))
    out.append(P(ring(cx - 16, cy - 20, R - 30, 9, 0.5), S3))
    out.append('<g class="glint">' + P([(70, 64), (84, 57), (76, 73)], WHITE, ' opacity="0.6"') + '</g>')
    out.append(P([(130, 140), (140, 128), (136, 142)], S3, ' opacity="0.5"'))
    out.append('</g>')

    def eye(x, y, big):
        return oval(x, y, round(7 * big, 1), round(9 * big, 1))

    out.append('<g transform="translate(100 110) scale(1.25) translate(-100 -110)">')
    out += faces(ink_faces(eye))
    out.append('</g>')
    out += extras([(150, 40, 5), (162, 26, 7), (178, 12, 9)], (150, 30))
    return "".join(out)


# ---------------- Visor ----------------
def visor():
    """A smooth two-tone sphere with a dark visor band; its eyes are light
    drawn on the screen, its mouth below it."""
    out = [halo(), '<g class="body">']
    out.append(f'<circle cx="100" cy="106" r="62" fill="{S0}"/>')
    out.append(f'<circle cx="94" cy="99" r="52" fill="{S1}"/>')
    out.append(f'<circle cx="82" cy="84" r="30" fill="{S2}"/>')
    out.append(f'<g class="glint"><ellipse cx="74" cy="68" rx="11" ry="6" fill="{WHITE}" opacity="0.45" transform="rotate(-30 74 68)"/></g>')
    out.append(f'<rect x="52" y="86" width="96" height="40" rx="20" fill="{INK}"/>')
    out.append(f'<rect class="scan" x="56" y="90" width="88" height="32" rx="16" fill="{S0}" opacity="0.3"/>')
    out.append('</g>')

    def pill(x, y, w=16, h=9):
        return f'<g class="blink"><rect x="{x - w / 2}" y="{y - h / 2}" width="{w}" height="{h}" rx="{h / 2}" fill="{LIGHT}"/></g>'

    def dot(x, y, r=8):
        return f'<g class="blink"><circle cx="{x}" cy="{y}" r="{r}" fill="{LIGHT}"/></g>'

    def lit(d, w=6):
        return line(d, LIGHT, w)

    drawn = {
        "happy": lit("M70 110 Q80 96 90 110") + lit("M110 110 Q120 96 130 110") + line("M90 140 Q100 148 110 140", INK, 4),
        "curious": pill(80, 104, 13, 8) + dot(120, 103, 9) + f'<ellipse cx="104" cy="143" rx="4" ry="5" fill="{INK}"/>',
        "thinking": pill(82, 100) + pill(120, 98)
                    + '<g class="dots">' + "".join(f'<circle cx="{x}" cy="116" r="2.5" fill="{S3}" opacity="{o}"/>'
                                                   for x, o in ((88, 1), (100, 0.7), (112, 0.4))) + '</g>'
                    + line("M94 142 L108 140", INK, 4),
        "surprised": dot(80, 106, 10) + dot(120, 106, 10) + f'<ellipse cx="100" cy="144" rx="6" ry="7" fill="{INK}"/>',
        "sleepy": lit("M72 108 L88 108", 5) + lit("M112 108 L128 108", 5) + f'<ellipse cx="100" cy="142" rx="3.5" ry="2.5" fill="{INK}"/>'
                  + line("M140 64 h10 l-10 10 h10", "#e9edf8", 3),
        "wink": lit("M70 110 Q80 96 90 110") + lit("M112 106 L128 106", 5) + line("M88 138 Q100 150 112 138", INK, 4),
        "laugh": lit("M70 110 Q80 96 90 110") + lit("M110 110 Q120 96 130 110")
                 + f'<path d="M86 136 Q100 156 114 136 Z" fill="{MOUTH}"/><path d="M94 144 Q100 151 106 144 Z" fill="{TONGUE}"/>',
        "puzzled": pill(80, 104) + dot(120, 102, 5) + lit("M112 92 L128 89", 3.5)
                   + line("M88 142 Q94 137 100 142 Q106 147 112 142", INK, 3.5),
    }
    out += faces(drawn)
    out += extras([(150, 40, 5), (162, 26, 7), (178, 12, 9)], (150, 30))
    return "".join(out)


# ---------------- Hex ----------------
def hexa():
    """The orb cut to Kriyon's own hexagon: six lit facets, like the logo;
    tall capsule eyes, angular brows."""
    top, tr, br, bot, bl, tl, mid = (100, 42), (155.4, 74), (155.4, 138), (100, 170), (44.6, 138), (44.6, 74), (100, 106)
    out = [halo(), '<g class="body"><g class="facets">']
    for i, (a, b, fill) in enumerate(((tl, top, S3), (top, tr, S2), (tr, br, S0), (br, bot, DEEP), (bot, bl, S1), (bl, tl, S2)), start=1):
        out.append(f'<g class="facet facet-{i}">' + P([a, b, mid], fill) + '</g>')
    out.append('</g></g>')

    def eye(x, y, big):
        return capsule(x, y, round(11 * big, 1), round(20 * big, 1))

    out += faces(ink_faces(eye, y=101, mouth_y=124))
    out += extras([(152, 40, 5), (164, 26, 7), (180, 12, 9)], (146, 26))
    return "".join(out)


def jsx(svg):
    def ref(m):
        attr, hexv = m.group(1), m.group(2).lower()
        if hexv in HUED:
            return f'{attr}="var(--kr-m-{HUED[hexv]})"'
        if hexv in FIXED:
            return f'{attr}={{C.{FIXED[hexv]}}}'
        raise SystemExit(f"{hexv} has no name in tokens.mascot")
    svg = re.sub(r'(fill|stroke)="(#[0-9a-fA-F]{3,6})"', ref, svg)
    svg = svg.replace('class="', 'className="').replace("stroke-width", "strokeWidth")
    return svg.replace("stroke-linecap", "strokeLinecap").replace("stroke-linejoin", "strokeLinejoin")


def main(out_path):
    arts = {"Gem": gem(), "Visor": visor(), "Hex": hexa()}
    parts = ["// Generated by scripts/mascots.py: edit that and run it, never this file.",
             'import { tokens } from "../theme/tokens.ts";', "", "const C = tokens.mascot;", ""]
    for name, svg in arts.items():
        parts.append(f"/** The {name} orb, drawn in a 200x200 box; its hue comes from --kr-m-* variables. */")
        parts.append(f"export function {name}Art() {{")
        parts.append(f"  return <>{jsx(svg)}</>;")
        parts.append("}")
        parts.append("")
    open(out_path, "w").write("\n".join(parts))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "src/structured/mascotArt.tsx")
