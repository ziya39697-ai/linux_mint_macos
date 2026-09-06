#!/usr/bin/env python3
"""Tag WhiteSur's xsi-* symbolic place/device glyphs so GTK can colour them.

GTK recolours symbolic SVGs with a stylesheet that paints every shape in the
text colour, except shapes carrying class="success|warning|error", which take
the colours of the widget's `-gtk-icon-palette`.  Nemo's sidebar draws its
icons through GtkCellRendererPixbuf, which ignores -gtk-icon-style, so the only
way to give it macOS 27 Golden Gate's coloured sidebar glyphs is this: tag the
shapes "success" and set the palette on the sidebar (config/gtk-3.0/finder.css
sets success to blue there and to currentColor everywhere else, so nothing
outside Nemo's sidebar changes colour).

Idempotent.  Re-run after rebuilding the WhiteSur icon theme from source:
    python3 tools/tag-xsi-symbolic.py ~/.local/share/icons/WhiteSur
"""
import glob
import os
import sys
import xml.etree.ElementTree as ET

SHAPES = {"path", "rect", "circle", "ellipse", "polygon", "polyline"}
NS = {"": "http://www.w3.org/2000/svg", "xlink": "http://www.w3.org/1999/xlink",
      "sodipodi": "http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd",
      "inkscape": "http://www.inkscape.org/namespaces/inkscape",
      "rdf": "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
      "cc": "http://creativecommons.org/ns#", "dc": "http://purl.org/dc/elements/1.1/"}
for prefix, uri in NS.items():
    ET.register_namespace(prefix, uri)


def tag_file(path):
    tree = ET.parse(path)
    changed = 0
    for el in tree.getroot().iter():
        if el.tag.split("}")[-1] in SHAPES:
            cls = el.get("class", "").split()
            if "success" not in cls:
                cls.append("success")
                el.set("class", " ".join(cls))
                changed += 1
    if changed:
        tree.write(path, xml_declaration=True, encoding="utf-8")
    return changed


def main():
    theme = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/.local/share/icons/WhiteSur")
    files = shapes = 0
    for ctx in ("places", "devices"):
        for path in sorted(glob.glob(os.path.join(theme, ctx, "symbolic", "xsi-*-symbolic.svg"))):
            n = tag_file(path)
            files += 1
            shapes += n
    print("%d icons checked, %d shapes tagged" % (files, shapes))


if __name__ == "__main__":
    main()
