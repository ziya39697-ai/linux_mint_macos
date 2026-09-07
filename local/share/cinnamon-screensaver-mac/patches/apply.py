#!/usr/bin/python3
"""Apply the Golden Gate lock-screen patches to fresh copies of the
cinnamon-screensaver modules in ../overlay.  Every replacement must match
exactly once, so an upstream change that moves the code fails loudly here
instead of silently producing a half-patched lock screen."""
import os, sys

OVERLAY = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "overlay")

def patch(name, pairs):
    p = os.path.join(OVERLAY, name)
    src = open(p).read()
    for old, new in pairs:
        n = src.count(old)
        if n != 1:
            sys.exit("%s: expected 1 match, found %d for:\n%s" % (name, n, old))
        src = src.replace(old, new)
    open(p, "w").write(src)
    print("patched", name)

# ---------------------------------------------------------------- stage.py
FLOAT_OLD_START = "        if isinstance(child, Floating):\n"
FLOAT_OLD_END   = "        if isinstance(child, AudioPanel):\n"
stage = open(os.path.join(OVERLAY, "stage.py")).read()
a = stage.index(FLOAT_OLD_START); b = stage.index(FLOAT_OLD_END)
float_block = stage[a:b]

patch("stage.py", [
    ("FLOATER_POSITIONING_TIMEOUT = 30\n",
     "FLOATER_POSITIONING_TIMEOUT = 30\n"
     "\n"
     "# macOS lock-screen geometry (fractions of the monitor height):\n"
     "# clock top edge, gap between clock and album art, unlock dialog bottom margin.\n"
     "MAC_CLOCK_TOP = 0.075\n"
     "MAC_ALBUMART_GAP = 20\n"
     "MAC_UNLOCK_BOTTOM = 0.06\n"),
    ("            allocation.width = nat_rect.width\n"
     "            allocation.height = nat_rect.height\n"
     "\n"
     "            allocation.x = monitor_rect.x + (monitor_rect.width / 2) - (allocation.width / 2)\n"
     "            allocation.y = monitor_rect.y + (monitor_rect.height / 2) - (allocation.height / 2)\n",
     "            allocation.width = nat_rect.width\n"
     "            allocation.height = nat_rect.height\n"
     "\n"
     "            # macOS: avatar / name / password sit near the bottom of the screen.\n"
     "            allocation.x = int(monitor_rect.x + (monitor_rect.width / 2) - (allocation.width / 2))\n"
     "            allocation.y = int(monitor_rect.y + monitor_rect.height - allocation.height\n"
     "                               - monitor_rect.height * MAC_UNLOCK_BOTTOM)\n"),
    (float_block,
     '        if isinstance(child, Floating):\n'
     '            """\n'
     '            macOS layout: the clock is fixed top-centre of the active monitor and the\n'
     '            album art (Now Playing) sits directly beneath it.  The stock 3x3 floating\n'
     '            grid and its random repositioning are not used.\n'
     '            """\n'
     '            current_monitor = status.screen.get_mouse_monitor()\n'
     '            monitor_rect = status.screen.get_monitor_geometry(current_monitor)\n'
     '\n'
     '            child.set_awake_position(current_monitor)\n'
     '            child.apply_next_position()\n'
     '\n'
     '            min_rect, nat_rect = child.get_preferred_size()\n'
     '            allocation.width = min(nat_rect.width, monitor_rect.width)\n'
     '            allocation.height = min(nat_rect.height, monitor_rect.height)\n'
     '            allocation.x = int(monitor_rect.x + (monitor_rect.width / 2) - (allocation.width / 2))\n'
     '\n'
     '            clock_top = monitor_rect.y + int(monitor_rect.height * MAC_CLOCK_TOP)\n'
     '            if isinstance(child, ClockWidget):\n'
     '                allocation.y = clock_top\n'
     '            else:\n'
     '                clock_h = 0\n'
     '                if self.clock_widget is not None:\n'
     '                    clock_h = self.clock_widget.get_preferred_size()[1].height\n'
     '                allocation.y = clock_top + clock_h + MAC_ALBUMART_GAP\n'
     '\n'
     '            return True\n'
     '\n'),
])

patch("stage.py", [
    # macOS has no on-screen-keyboard toggle on the lock screen.
    ("            if OnScreenKeyboard:\n                try:\n                    self.setup_osk()\n",
     "            if False:  # on-screen keyboard disabled (Golden Gate overlay)\n                try:\n                    self.setup_osk()\n"),
])

# ---------------------------------------------------------------- clock.py
patch("clock.py", [
    # The screensaver calls 1440x900 "low-res" and shrinks every font by a third;
    # the gsettings sizes are already chosen for this screen, so keep them as-is.
    ("        if self.low_res:\n"
     "            time_size = time_font.get_size() * .66\n",
     "        if False:  # low_res font scaling disabled (Golden Gate overlay)\n"
     "            time_size = time_font.get_size() * .66\n"),
    ("        if self.low_res:\n"
     "            msg_size = font_message.get_size() * .66\n",
     "        if False:  # low_res font scaling disabled (Golden Gate overlay)\n"
     "            msg_size = font_message.get_size() * .66\n"),
    ("super(ClockWidget, self).__init__(initial_monitor, Gtk.Align.START, Gtk.Align.CENTER)",
     "super(ClockWidget, self).__init__(initial_monitor, Gtk.Align.CENTER, Gtk.Align.START)"),
    ("        self.label.set_alignment(0.5, 0.5)\n",
     "        self.label.set_alignment(0.5, 0.5)\n"
     "        self.label.set_justify(Gtk.Justification.CENTER)\n"),
    ("        self.msg_label.set_alignment(0.5, 0.5)\n",
     "        self.msg_label.set_alignment(0.5, 0.5)\n"
     "        self.msg_label.set_justify(Gtk.Justification.CENTER)\n"),
    ("        time_format = ('<b><span font_desc=\\\"%s\\\" foreground=\\\"#FFFFFF\\\">%s</span></b>\\n' +             \\\n"
     "                       '<b><span font_desc=\\\"%s\\\" foreground=\\\"#FFFFFF\\\">%s</span></b>')                \\\n"
     "            % (time_font.to_string(), time_format, date_font.to_string(), date_format)\n",
     "        # macOS: date above a large translucent-white time; weight comes from the font.\n"
     "        time_format = ('<span font_desc=\\\"%s\\\" foreground=\\\"#FFFFFF\\\" alpha=\\\"58982\\\">%s</span>\\n' +\n"
     "                       '<span font_desc=\\\"%s\\\" foreground=\\\"#FFFFFF\\\" alpha=\\\"57671\\\" letter_spacing=\\\"-2500\\\">%s</span>') \\\n"
     "            % (date_font.to_string(), date_format, time_font.to_string(), time_format)\n"),
])

# ---------------------------------------------------------------- unlock.py
patch("unlock.py", [
    ("        self.face_image = FramedImage(status.screen.get_low_res_mode())\n",
     "        self.face_image = FramedImage(status.screen.get_low_res_mode())\n"
     "        self.face_image.max_size = 56   # macOS-sized round avatar\n"),
    ("        self.realname_label = Gtk.Label(None)\n",
     "        self.realname_label = Gtk.Label(None)\n"
     "        self.realname_label.get_style_context().add_class(\"realname\")\n"),
    ("        self.password_entry = PasswordEntry()\n",
     "        self.password_entry = PasswordEntry()\n"
     "        self.password_entry.placeholder_text = _(\"Enter Password\")\n"
     "        self.password_entry.set_placeholder_text(self.password_entry.placeholder_text)\n"
     "        self.password_entry.set_width_chars(16)\n"),
    ("        self.entry_box.pack_start(self.password_entry, False, False, 15)\n",
     "        self.entry_box.pack_start(self.password_entry, False, False, 4)\n"),
    ("            prompt = _(\"Please enter your password...\")\n",
     "            prompt = _(\"Enter Password\")\n"),
    # tighter vertical rhythm: avatar / name / field like macOS
    ("        self.box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10)\n",
     "        self.box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)\n"),
    ("        self.box.pack_start(self.face_image, False, False, 10)\n",
     "        self.box.pack_start(self.face_image, False, False, 0)\n"),
    ("        self.box.pack_start(self.realname_label, False, False, 10)\n",
     "        self.box.pack_start(self.realname_label, False, False, 0)\n"),
    # the unlock button is macOS's round arrow
    ("TransparentButton(\"screensaver-unlock-symbolic\", Gtk.IconSize.LARGE_TOOLBAR)",
     "TransparentButton(\"go-next-symbolic\", Gtk.IconSize.BUTTON)"),
    # macOS: no buttons beside the field; the unlock arrow lives inside it
    ("        self.entry_box.pack_end(button_box, False, False, 0)\n",
     "        # Golden Gate: the two round buttons are not shown; the entry's own\n"
     "        # trailing icon is the unlock arrow (see below).\n"),
    ("        status.focusWidgets = [self.password_entry, self.auth_unlock_button]\n",
     "        status.focusWidgets = [self.password_entry]\n"),
    ("            status.focusWidgets.append(self.auth_switch_button)\n",
     "            pass  # switch-user button not shown\n"),
    ("        self.password_entry.set_width_chars(16)\n",
     "        self.password_entry.set_width_chars(16)\n"
     "        # Replace the reveal-password icon with the unlock arrow.\n"
     "        trackers.con_tracker_get().disconnect(self.password_entry, \"icon-press\", self.password_entry.on_icon_pressed)\n"
     "        self.password_entry.set_icon_from_icon_name(Gtk.EntryIconPosition.SECONDARY, \"go-next-symbolic\")\n"
     "        self.password_entry.set_icon_tooltip_text(Gtk.EntryIconPosition.SECONDARY, _(\"Unlock\"))\n"
     "        self.password_entry.set_icon_activatable(Gtk.EntryIconPosition.SECONDARY, True)\n"
     "        trackers.con_tracker_get().connect(self.password_entry, \"icon-press\", self.on_entry_icon_pressed)\n"),
    ("    def on_unlock_clicked(self, button=None):\n",
     "    def on_entry_icon_pressed(self, entry, icon_pos, event):\n"
     "        if icon_pos == Gtk.EntryIconPosition.SECONDARY:\n"
     "            self.on_unlock_clicked()\n"
     "        elif icon_pos == Gtk.EntryIconPosition.PRIMARY:\n"
     "            entry.on_icon_pressed(entry, icon_pos, event)\n"
     "\n"
     "    def on_unlock_clicked(self, button=None):\n"),
    # message rows take no space until they have something to say
    ("        self.box.show_all()\n"
     "        self.password_entry.hide()\n"
     "        self.auth_unlock_button.hide()\n",
     "        self.box.show_all()\n"
     "        self.password_entry.hide()\n"
     "        self.auth_unlock_button.hide()\n"
     "        for lbl in (self.capslock_label, self.auth_message_label, self.authinfo_label):\n"
     "            lbl.set_visible(lbl.get_text() != \"\")\n"
     "            lbl.connect(\"notify::label\", lambda l, p: l.set_visible(l.get_text() != \"\"))\n"),
])

# ---------------------------------------------------------------- widgets/powerWidget.py
# Golden Gate battery: percentage inside a translucent body with a solid fill,
# digits knocked out of the fill (same drawing as the panel applet's batteryGlyph.js).
patch("widgets/powerWidget.py", [
    ("from gi.repository import Gtk, GObject, Gio\n",
     "from gi.repository import Gtk, GObject, Gio\n"
     "import math\n"
     "import cairo\n"),
    ("            image = Gtk.Image.new_from_gicon(gicon, Gtk.IconSize.LARGE_TOOLBAR)\n",
     "            image = MacBatteryGlyph(percentage, battery.get_property(\"state\"))\n"),
    ("class PowerWidget(Gtk.Frame):",
     '''MAC_BODY_ALPHA = 0.36
MAC_LOW_PCT = 20
MAC_RED = (1.00, 0.27, 0.23)
MAC_BOLT = [(0.12, -0.5), (-0.5, 0.08), (-0.08, 0.08), (-0.12, 0.5), (0.5, -0.08), (0.08, -0.08)]

def _rounded_rect(cr, x, y, w, h, r):
    r = min(r, w / 2, h / 2)
    cr.new_sub_path()
    cr.arc(x + w - r, y + r, r, -math.pi / 2, 0)
    cr.arc(x + w - r, y + h - r, r, 0, math.pi / 2)
    cr.arc(x + r, y + h - r, r, math.pi / 2, math.pi)
    cr.arc(x + r, y + r, r, math.pi, 3 * math.pi / 2)
    cr.close_path()

def _bolt(cr, cx, cy, bw, bh):
    cr.new_sub_path()
    for i, (px, py) in enumerate(MAC_BOLT):
        (cr.move_to if i == 0 else cr.line_to)(cx + px * bw, cy + py * bh)
    cr.close_path()

class MacBatteryGlyph(Gtk.DrawingArea):
    """macOS 27 (Golden Gate) menu-bar battery: number inside the body."""
    HEIGHT = 16

    def __init__(self, percentage, state):
        super(MacBatteryGlyph, self).__init__()
        self.pct = max(0, min(100, int(percentage or 0)))
        self.on_ac = state in (UPOWER_STATE_CHARGING, UPOWER_STATE_PENDING_CHARGE, UPOWER_STATE_FULLY_CHARGED)
        self.set_size_request(int(self.HEIGHT * 1.8), self.HEIGHT)
        self.set_valign(Gtk.Align.CENTER)
        self.connect("draw", self.on_draw)

    def on_draw(self, widget, cr):
        W = self.get_allocated_width(); H = self.get_allocated_height()
        c = self.get_style_context().get_color(self.get_state_flags())
        r, g, b = c.red, c.green, c.blue
        scale = 1.0
        body_h = H * 0.74; body_y = (H - body_h) / 2
        nub_w = 1.6; nub_h = body_h * 0.40
        body_x = 0.5; body_w = W - nub_w - 1.5 - body_x
        radius = body_h * 0.30

        cr.set_source_rgba(r, g, b, MAC_BODY_ALPHA)
        _rounded_rect(cr, body_x, body_y, body_w, body_h, radius); cr.fill()
        nx = body_x + body_w + 0.8; ny = body_y + (body_h - nub_h) / 2; nr = nub_w * 0.6
        cr.new_sub_path(); cr.move_to(nx, ny); cr.line_to(nx + nub_w - nr, ny)
        cr.arc(nx + nub_w - nr, ny + nr, nr, -math.pi / 2, 0); cr.line_to(nx + nub_w, ny + nub_h - nr)
        cr.arc(nx + nub_w - nr, ny + nub_h - nr, nr, 0, math.pi / 2); cr.line_to(nx, ny + nub_h)
        cr.close_path(); cr.fill()

        fill_w = body_w * self.pct / 100.0
        if self.pct > 0: fill_w = max(fill_w, 2.0)
        if not self.on_ac and self.pct <= MAC_LOW_PCT: cr.set_source_rgba(*MAC_RED, 1)
        else: cr.set_source_rgba(r, g, b, 1)
        cr.save(); _rounded_rect(cr, body_x, body_y, body_w, body_h, radius); cr.clip()
        if fill_w > 0: cr.rectangle(body_x, body_y, fill_w, body_h); cr.fill()
        cr.restore()

        text = str(self.pct)
        fo = cairo.FontOptions(); fo.set_antialias(cairo.ANTIALIAS_GRAY); cr.set_font_options(fo)
        cr.select_font_face("Inter", cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
        cr.set_font_size(body_h * 0.80)
        xb, yb, tw, th, xa, ya = cr.text_extents(text)
        bh = body_h * 0.66; bw = bh * 0.56
        gap = 0.8 if self.on_ac else 0
        total = xa + gap + (bw if self.on_ac else 0)
        x0 = body_x + (body_w - total) / 2; cy = body_y + body_h / 2

        def glyphs():
            cr.move_to(x0 - xb, cy - (yb + th / 2)); cr.show_text(text)
            if self.on_ac:
                _bolt(cr, x0 + xa + gap + bw / 2, cy, bw, bh); cr.fill()

        cr.save(); cr.rectangle(body_x, body_y, fill_w, body_h); cr.clip()
        cr.set_operator(cairo.OPERATOR_CLEAR); glyphs(); cr.restore()
        cr.save(); cr.rectangle(body_x + fill_w, body_y, body_w - fill_w, body_h); cr.clip()
        cr.set_source_rgba(r, g, b, 1); glyphs(); cr.restore()
        return False

class PowerWidget(Gtk.Frame):'''),
])

# ---------------------------------------------------------------- monitorView.py
patch("monitorView.py", [
    ("        cr.set_source_rgba(0.0, 0.0, 0.0, 0.7)\n        cr.paint()\n",
     "        # macOS shows the wallpaper undimmed on the lock screen.\n"
     "        if MAC_SHADE > 0:\n"
     "            cr.set_source_rgba(0.0, 0.0, 0.0, MAC_SHADE)\n"
     "            cr.paint()\n"),
    ("class WallpaperStack(",
     "MAC_SHADE = 0.0\n\nclass WallpaperStack("),
])
