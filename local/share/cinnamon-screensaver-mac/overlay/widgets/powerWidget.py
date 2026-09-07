#!/usr/bin/python3

from gi.repository import Gtk, GObject, Gio
import math
import cairo

from util import trackers
import singletons
import constants as c
import status
from util.utils import DEBUG

UPOWER_STATE_CHARGING = 1
UPOWER_STATE_DISCHARGING = 2
UPOWER_STATE_FULLY_CHARGED = 4
UPOWER_STATE_PENDING_CHARGE = 5
UPOWER_STATE_PENDING_DISCHARGE = 6

MAC_BODY_ALPHA = 0.36
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

class PowerWidget(Gtk.Frame):
    """
    PowerWidget is a child of InfoPanel, and is only shown if we're on
    a system that can run on battery power.  It is usually only visible
    if the system is actually currently running on battery power.
    """
    __gsignals__ = {
        'power-state-changed': (GObject.SignalFlags.RUN_LAST, None, ()),
    }

    def __init__(self):
        super(PowerWidget, self).__init__()
        self.set_shadow_type(Gtk.ShadowType.NONE)
        self.get_style_context().add_class("powerwidget")

        self.path_widget_pairs = []

        self.box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL)
        self.add(self.box)

        self.box.show_all()

        self.power_client = singletons.UPowerClient

        self.battery_critical = False

        trackers.con_tracker_get().connect(self.power_client,
                                           "power-state-changed",
                                           self.on_power_state_changed)

        trackers.con_tracker_get().connect(self.power_client,
                                           "percentage-changed",
                                           self.on_percentage_changed)

    def refresh(self):
        self.on_power_state_changed(self.power_client)

    def on_power_state_changed(self, client):
        for widget in self.box.get_children():
            widget.destroy()

        self.path_widget_pairs = []
        self.battery_critical = False

        self.construct_icons()

        self.emit("power-state-changed")

    def on_percentage_changed(self, client, battery):
        battery_path = battery.get_object_path()

        for path, widget in self.path_widget_pairs:
            if path == battery_path:
                self.update_battery_tooltip(widget, battery)
                break

    def construct_icons(self):
        """
        The upower dbus interface actually tells us what icon name to use.
        """
        batteries = self.power_client.get_batteries()

        for path, battery in batteries:
            percentage = battery.get_property("percentage")
            gicon = self.get_gicon_for_current_level(battery)

            DEBUG("powerWidget: Updating battery info: %s - icon: %s - percentage: %s" %
                    (path, gicon.to_string(), percentage))

            image = MacBatteryGlyph(percentage, battery.get_property("state"))
            self.update_battery_tooltip(image, battery)

            self.box.pack_start(image, False, False, 4)
            self.path_widget_pairs.append((path, image))

        self._should_show = True
        self.box.show_all()

    def get_gicon_for_current_level(self, battery):
        percentage = battery.get_property("percentage")
        state = battery.get_property("state")

        names = None

        if state in (UPOWER_STATE_CHARGING, UPOWER_STATE_DISCHARGING,
                     UPOWER_STATE_PENDING_CHARGE, UPOWER_STATE_PENDING_DISCHARGE):
            if percentage < 10:
                names = ["xsi-battery-level-0"]
            elif percentage < 20:
                names = ["xsi-battery-level-10"]
            elif percentage < 30:
                names = ["xsi-battery-level-20"]
            elif percentage < 40:
                names = ["xsi-battery-level-30"]
            elif percentage < 50:
                names = ["xsi-battery-level-40"]
            elif percentage < 60:
                names = ["xsi-battery-level-50"]
            elif percentage < 70:
                names = ["xsi-battery-level-60"]
            elif percentage < 80:
                names = ["xsi-battery-level-70"]
            elif percentage < 90:
                names = ["xsi-battery-level-80"]
            elif percentage < 99:
                names = ["xsi-battery-level-90"]
            else:
                names = ["xsi-battery-level-100"]

            if state in (UPOWER_STATE_CHARGING, UPOWER_STATE_PENDING_CHARGE):
                names[0] += "-charging"

            names[0] += "-symbolic"

        elif state == UPOWER_STATE_FULLY_CHARGED:
            names = ["xsi-battery-level-100-charged-symbolic"]
        else:
            names = (battery.get_property("icon-name"),)

        return Gio.ThemedIcon.new_from_names(names)

    def update_battery_tooltip(self, widget, battery):
        text = ""

        try:
            pct = int(battery.get_property("percentage"))

            if pct > 0:
                text = _("%d%%" % pct)
                if pct < c.BATTERY_CRITICAL_PERCENT:
                    self.battery_critical = True
        except Exception as e:
            pass

        widget.set_tooltip_text(text)

    def should_show(self):
        return not self.power_client.full_and_on_ac_or_no_batteries()
