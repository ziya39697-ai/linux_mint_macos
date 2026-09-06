#!/usr/bin/env python3
"""About This Mac — the macOS system summary window, for Linux Mint (GTK 3).

Reads what macOS shows (model, processor, memory, graphics, display, startup
disk, serial number, OS version) from /sys, /proc and the usual CLI tools; no
root needed.  The serial number is root-only on Linux, so that row is simply
left out when it cannot be read.  Launched from the Apple menu applet.
"""
import math
import os
import re
import subprocess
import sys

import gi
gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
from gi.repository import Gdk, GdkPixbuf, GLib, Gtk  # noqa: E402

# WM_CLASS / app name: matches about-this-mac.desktop (StartupWMClass) so the
# window tracker, Force Quit and the dock show "About This Mac" with an icon.
GLib.set_prgname("about-this-mac")

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(os.path.dirname(HERE), "assets")

# Apple model identifier -> (marketing name, sub-line, product image)
MODELS = {
    "MacBookAir7,2":  ("MacBook Air", "13-inch, Early 2015", "macbook-air-2015-13in.png"),
    "MacBookAir7,1":  ("MacBook Air", "11-inch, Early 2015", None),
    "MacBookAir6,2":  ("MacBook Air", "13-inch, Early 2014", None),
    "MacBookAir6,1":  ("MacBook Air", "11-inch, Early 2014", None),
    "MacBookAir8,1":  ("MacBook Air", "Retina, 13-inch, 2018", None),
    "MacBookAir8,2":  ("MacBook Air", "Retina, 13-inch, 2019", None),
    "MacBookAir9,1":  ("MacBook Air", "Retina, 13-inch, 2020", None),
    "MacBookPro11,1": ("MacBook Pro", "Retina, 13-inch, Late 2013", None),
    "MacBookPro12,1": ("MacBook Pro", "Retina, 13-inch, Early 2015", None),
    "MacBookPro13,1": ("MacBook Pro", "13-inch, 2016", None),
    "MacBookPro14,1": ("MacBook Pro", "13-inch, 2017", None),
}
FAMILIES = (("MacBookAir", "MacBook Air"), ("MacBookPro", "MacBook Pro"),
            ("MacBook", "MacBook"), ("Macmini", "Mac mini"), ("iMac", "iMac"),
            ("MacPro", "Mac Pro"))
CORE_WORDS = {1: "Single-Core", 2: "Dual-Core", 4: "Quad-Core", 6: "6-Core",
              8: "8-Core", 10: "10-Core", 12: "12-Core", 16: "16-Core"}


def read(path):
    try:
        with open(path) as fh:
            return fh.read().strip()
    except OSError:
        return ""


def sh(*cmd):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=5).stdout
    except (OSError, subprocess.SubprocessError):
        return ""


def model():
    ident = read("/sys/class/dmi/id/product_name")
    if ident in MODELS:
        return MODELS[ident]
    for prefix, name in FAMILIES:
        if ident.startswith(prefix):
            return (name, ident, None)
    vendor = read("/sys/class/dmi/id/sys_vendor")
    return (ident or vendor or "Computer", vendor if ident else "", None)


def processor():
    info = read("/proc/cpuinfo")
    m = re.search(r"^model name\s*:\s*(.+)$", info, re.M)
    name = m.group(1) if m else "Unknown"
    ghz = re.search(r"@\s*([\d.]+)\s*GHz", name)
    cores = len(set(re.findall(r"^core id\s*:\s*(\d+)$", info, re.M))) or \
        len(re.findall(r"^processor\s*:", info, re.M))
    brand = re.sub(r"\(R\)|\(TM\)|CPU|@.*$|\s+\d+th Gen", "", name)
    brand = re.sub(r"(Core\s+[im]\d)[- ]\w+", r"\1", brand)
    brand = re.sub(r"\s+", " ", brand).strip()
    parts = []
    if ghz:
        parts.append("%g GHz" % float(ghz.group(1)))
    parts.append(CORE_WORDS.get(cores, "%d-Core" % cores))
    parts.append(brand)
    return " ".join(parts)


def memory():
    m = re.search(r"^MemTotal:\s*(\d+) kB", read("/proc/meminfo"), re.M)
    if not m:
        return "Unknown"
    gb = int(m.group(1)) / (1024 * 1024)
    return "%d GB" % round(gb)


def graphics():
    for line in sh("lspci").splitlines():
        if "VGA" in line or "3D controller" in line or "Display controller" in line:
            desc = line.split(": ", 1)[-1]
            desc = re.sub(r"\s*\(rev [^)]*\)", "", desc)
            desc = re.sub(r"\bCorporation\b|\bInc\.?\b|\[.*?\]", "", desc)
            return re.sub(r"\s+", " ", desc).strip()
    return "Unknown"


def display():
    for line in sh("xrandr").splitlines():
        m = re.search(r" connected (?:primary )?(\d+)x(\d+)\+\d+\+\d+.*?(\d+)mm x (\d+)mm", line)
        if m:
            w, h, mmw, mmh = map(int, m.groups())
            inches = math.hypot(mmw, mmh) / 25.4
            return "%.1f-inch (%d × %d)" % (inches, w, h)
    return "Unknown"


def startup_disk():
    out = sh("df", "-B1", "--output=source,size,avail", "/").splitlines()
    if len(out) < 2:
        return "Unknown"
    dev, size, avail = out[1].split()
    label = sh("lsblk", "-no", "LABEL", dev).strip()
    gb = 1000 ** 3
    name = label or "Linux Mint"
    return "%s — %d GB available of %d GB" % (name, int(avail) / gb, int(size) / gb)


def serial():
    try:
        with open("/sys/class/dmi/id/product_serial") as fh:
            s = fh.read().strip()
            return s or None
    except OSError:
        return None


def os_version():
    info = dict(re.findall(r"^(\w+)=\"?([^\"\n]*)\"?$", read("/etc/linuxmint/info"), re.M))
    release = info.get("RELEASE", "")
    codename = info.get("CODENAME", "").capitalize()
    if not release:
        rel = dict(re.findall(r"^(\w+)=\"?([^\"\n]*)\"?$", read("/etc/os-release"), re.M))
        return rel.get("PRETTY_NAME", "Linux")
    return "Linux Mint %s %s" % (release, codename)


def desktop_version():
    v = sh("cinnamon", "--version").strip()
    return v or "Cinnamon"


def build_window(app):
    name, sub, image = model()
    rows = [
        ("Processor", processor()),
        ("Graphics", graphics()),
        ("Memory", memory()),
        ("Display", display()),
        ("Startup disk", startup_disk()),
    ]
    sn = serial()
    if sn:
        rows.append(("Serial number", sn))
    rows += [
        ("OS", os_version()),
        ("Desktop", desktop_version()),
        ("Kernel", sh("uname", "-r").strip()),
    ]

    win = Gtk.ApplicationWindow(application=app, title="About This Mac")
    win.set_resizable(False)
    win.set_position(Gtk.WindowPosition.CENTER)
    win.set_default_size(300, -1)
    header = Gtk.HeaderBar(show_close_button=True)
    header.set_custom_title(Gtk.Box())  # macOS: no title text, only the traffic lights
    header.get_style_context().add_class("am-header")
    win.set_titlebar(header)
    win.set_title("About This Mac")  # the WM/alt-tab name; the header bar itself stays blank

    box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2)
    box.set_margin_top(4)
    box.set_margin_bottom(22)
    box.set_margin_start(28)
    box.set_margin_end(28)
    win.add(box)

    if image and os.path.exists(os.path.join(ASSETS, image)):
        scale = win.get_scale_factor()
        pb = GdkPixbuf.Pixbuf.new_from_file(os.path.join(ASSETS, image))
        target_w = 220 * scale
        pb = pb.scale_simple(target_w, int(pb.get_height() * target_w / pb.get_width()),
                             GdkPixbuf.InterpType.HYPER)
        surface = Gdk.cairo_surface_create_from_pixbuf(pb, scale, win.get_window())
        img = Gtk.Image.new_from_surface(surface)
        img.set_margin_bottom(14)
        box.pack_start(img, False, False, 0)
    else:
        img = Gtk.Image.new_from_icon_name("computer", Gtk.IconSize.DIALOG)
        img.set_pixel_size(128)
        img.set_margin_bottom(14)
        box.pack_start(img, False, False, 0)

    title = Gtk.Label(label=name)
    title.get_style_context().add_class("am-name")
    box.pack_start(title, False, False, 0)
    subl = Gtk.Label(label=sub)
    subl.get_style_context().add_class("am-sub")
    subl.set_margin_bottom(16)
    box.pack_start(subl, False, False, 0)

    grid = Gtk.Grid(column_spacing=10, row_spacing=4, halign=Gtk.Align.CENTER)
    for i, (k, v) in enumerate(rows):
        kl = Gtk.Label(label=k, xalign=1.0)
        kl.get_style_context().add_class("am-key")
        vl = Gtk.Label(label=v, xalign=0.0)
        vl.get_style_context().add_class("am-val")
        vl.set_selectable(True)
        vl.set_can_focus(False)  # otherwise the first value opens selected
        vl.set_max_width_chars(30)
        vl.set_line_wrap(True)
        grid.attach(kl, 0, i, 1, 1)
        grid.attach(vl, 1, i, 1, 1)
    box.pack_start(grid, False, False, 0)

    btn = Gtk.Button(label="More Info…", halign=Gtk.Align.CENTER)
    btn.get_style_context().add_class("am-btn")
    btn.set_margin_top(20)
    btn.connect("clicked", lambda *_: subprocess.Popen(["cinnamon-settings", "info"]))
    box.pack_start(btn, False, False, 0)

    css = Gtk.CssProvider()
    css.load_from_data(b"""
        .am-name { font-size: 20pt; font-weight: 700; }
        .am-sub  { opacity: 0.6; }
        .am-key  { font-weight: 700; }
        .am-val  { opacity: 0.85; }
        .am-btn  { padding: 3px 18px; border-radius: 7px; }
    """)
    Gtk.StyleContext.add_provider_for_screen(
        Gdk.Screen.get_default(), css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)

    def on_key(_w, ev):
        ctrl = ev.state & Gdk.ModifierType.CONTROL_MASK
        if ev.keyval == Gdk.KEY_Escape or (ctrl and ev.keyval in (Gdk.KEY_w, Gdk.KEY_q)):
            win.close()
            return True
        return False
    win.connect("key-press-event", on_key)
    win.show_all()
    btn.grab_focus()
    return win


class AboutApp(Gtk.Application):
    def __init__(self):
        super().__init__(application_id="io.github.jiya21.AboutThisMac")
        self.win = None

    def do_activate(self):
        if self.win is None:
            self.win = build_window(self)
        self.win.present()


if __name__ == "__main__":
    sys.exit(AboutApp().run(sys.argv))
