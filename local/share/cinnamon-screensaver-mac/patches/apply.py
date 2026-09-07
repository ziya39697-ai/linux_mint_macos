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
