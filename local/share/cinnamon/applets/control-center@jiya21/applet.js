/*
 * Control Center — a macOS-style single-menu applet for Cinnamon.
 *
 * Replaces network@, sound@ and power@ on the panel with one popup holding
 * Wi-Fi, Bluetooth, brightness, volume, media and battery.
 *
 * Rather than reimplementing NetworkManager / Cvc / backlight handling, this
 * loads Cinnamon's own applet modules by absolute path and reuses their
 * widgets.  fileUtils.js:262 leaves absolute paths alone, and createExports
 * (fileUtils.js:180) exposes every top-level declaration, so the stock classes
 * come through intact.  Those widgets take an object they call "applet" and
 * touch only a handful of members on it — this applet implements that
 * contract directly, which is why no stock applet has to be instantiated.
 *
 * The cost of that reuse is a hard dependency on Cinnamon's class names, so
 * every section is built inside its own try/catch: a Cinnamon upgrade that
 * breaks one section degrades it to a "Settings…" link instead of taking the
 * whole applet — and with it Wi-Fi, volume and battery — off the panel.
 */

const Applet     = imports.ui.applet;
const Clutter    = imports.gi.Clutter;
const Cvc        = imports.gi.Cvc;
const Gio        = imports.gi.Gio;
const GLib       = imports.gi.GLib;
const Interfaces = imports.misc.interfaces;
const Main       = imports.ui.main;
const NM         = imports.gi.NM;
const PopupMenu  = imports.ui.popupMenu;
const Settings   = imports.ui.settings;
const St         = imports.gi.St;
const Tooltips   = imports.ui.tooltips;
const UPowerGlib = imports.gi.UPowerGlib;
const Util       = imports.misc.util;

/* Destructured consts do not match the export regex in fileUtils.js:180, so
 * these cannot come from PowerLib — take them from the typelib instead. */
const { DeviceKind: UPDeviceKind, DeviceState: UPDeviceState } = UPowerGlib;

const UUID = "control-center@jiya21";

const BLUEZ            = "org.bluez";
const BLUEZ_ADAPTER    = "org.bluez.Adapter1";
const BLUEZ_DEVICE     = "org.bluez.Device1";
const BLUEZ_BATTERY    = "org.bluez.Battery1";
const DBUS_PROPERTIES  = "org.freedesktop.DBus.Properties";
const DBUS_OBJECTMGR   = "org.freedesktop.DBus.ObjectManager";

const VERSION = "2";

function log_err(where, e) {
    let msg = "[" + UUID + "] " + where + ": " + e;
    global.logError(msg);
    /* Cinnamon's own log destination varies by session type; keep a copy
     * somewhere predictable so failures are always diagnosable. */
    try {
        let path = GLib.get_user_cache_dir() + "/control-center-applet.log";
        let stamp = new Date().toISOString();
        let prev = "";
        try {
            let [ok, data] = GLib.file_get_contents(path);
            if (ok) prev = imports.byteArray.toString(data);
        } catch (x) {}
        if (prev.length > 65536) prev = "";
        GLib.file_set_contents(path, prev + stamp + " " + msg +
            (e && e.stack ? "\n    " + String(e.stack).split("\n")[0] : "") + "\n");
    } catch (x) {}
}

function tryRequire(path) {
    try {
        return require(path);
    } catch (e) {
        log_err("could not load " + path, e);
        return null;
    }
}

const NetLib   = tryRequire('/usr/share/cinnamon/applets/network@cinnamon.org/applet.js');
const SoundLib = tryRequire('/usr/share/cinnamon/applets/sound@cinnamon.org/applet.js');
const PowerLib = tryRequire('/usr/share/cinnamon/applets/power@cinnamon.org/applet.js');

/* GJS unpacks a{sv} values inconsistently across versions; normalise. */
function unwrap(v) {
    return (v instanceof GLib.Variant) ? v.deep_unpack() : v;
}

function firstProgram(candidates) {
    for (let c of candidates) {
        let argv = c.split(" ");
        if (GLib.find_program_in_path(argv[0]))
            return c;
    }
    return null;
}

function hasKeyboardBacklight() {
    try {
        let dir = Gio.file_new_for_path("/sys/class/leds");
        let e = dir.enumerate_children("standard::name", Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = e.next_file(null)) !== null) {
            if (info.get_name().indexOf("kbd_backlight") !== -1) {
                e.close(null);
                return true;
            }
        }
        e.close(null);
    } catch (err) {
        log_err("probing for keyboard backlight", err);
    }
    return false;
}

/* ------------------------------------------------------------------------ *
 * Bluetooth — talks to org.bluez on the system bus.
 *
 * Deliberately no pairing UI: pairing needs a registered org.bluez.Agent1 to
 * answer passkey prompts, which blueman-applet already provides.  We list and
 * connect; blueman keeps doing the agent work.
 * ------------------------------------------------------------------------ */
class BluetoothManager {
    constructor(onChanged) {
        this._onChanged = onChanged;
        this._bus = Gio.DBus.system;
        this._subs = [];
        this._pending = new Set();

        this.available = false;
        this.powered = false;
        this.adapterPath = null;
        this.devices = [];

        this._subs.push(this._bus.signal_subscribe(
            BLUEZ, DBUS_OBJECTMGR, "InterfacesAdded", null, null,
            Gio.DBusSignalFlags.NONE, () => this.refresh()));
        this._subs.push(this._bus.signal_subscribe(
            BLUEZ, DBUS_OBJECTMGR, "InterfacesRemoved", null, null,
            Gio.DBusSignalFlags.NONE, () => this.refresh()));
        this._subs.push(this._bus.signal_subscribe(
            BLUEZ, DBUS_PROPERTIES, "PropertiesChanged", null, null,
            Gio.DBusSignalFlags.NONE, (conn, sender, path, iface, signal, params) => {
                let changed = params.deep_unpack()[0];
                if (changed === BLUEZ_ADAPTER || changed === BLUEZ_DEVICE ||
                    changed === BLUEZ_BATTERY)
                    this.refresh();
            }));

        this.refresh();
    }

    refresh() {
        this._bus.call(BLUEZ, "/", DBUS_OBJECTMGR, "GetManagedObjects", null, null,
                       Gio.DBusCallFlags.NONE, -1, null, (src, res) => {
            let objects;
            try {
                objects = this._bus.call_finish(res).deep_unpack()[0];
            } catch (e) {
                /* bluetoothd not running, or no adapter — hide the section
                 * entirely rather than showing a switch that does nothing. */
                this.available = false;
                this.devices = [];
                this._notify();
                return;
            }
            this._parse(objects);
        });
    }

    _parse(objects) {
        let adapterPath = null;
        let powered = false;
        let devices = [];

        for (let path in objects) {
            let ifaces = objects[path];

            if (ifaces[BLUEZ_ADAPTER] && !adapterPath) {
                adapterPath = path;
                powered = !!unwrap(ifaces[BLUEZ_ADAPTER]["Powered"]);
            }

            let dev = ifaces[BLUEZ_DEVICE];
            if (dev && unwrap(dev["Paired"])) {
                let battery = null;
                if (ifaces[BLUEZ_BATTERY])
                    battery = unwrap(ifaces[BLUEZ_BATTERY]["Percentage"]);
                devices.push({
                    path: path,
                    alias: unwrap(dev["Alias"]) || unwrap(dev["Name"]) || path,
                    connected: !!unwrap(dev["Connected"]),
                    icon: unwrap(dev["Icon"]) || null,
                    battery: battery
                });
            }
        }

        devices.sort((a, b) => {
            if (a.connected !== b.connected) return a.connected ? -1 : 1;
            return a.alias.localeCompare(b.alias);
        });

        this.available = (adapterPath !== null);
        this.adapterPath = adapterPath;
        this.powered = powered;
        this.devices = devices;
        this._notify();
    }

    _notify() {
        try {
            this._onChanged();
        } catch (e) {
            log_err("bluetooth callback", e);
        }
    }

    /* A soft rfkill block keeps Powered false no matter what we write, so on
     * the way up unblock first and only then set the property. */
    setPowered(state) {
        if (!this.adapterPath) return;

        if (state) {
            Util.spawnCommandLineAsync("rfkill unblock bluetooth");
        }

        this._bus.call(BLUEZ, this.adapterPath, DBUS_PROPERTIES, "Set",
            new GLib.Variant("(ssv)",
                [BLUEZ_ADAPTER, "Powered", new GLib.Variant("b", state)]),
            null, Gio.DBusCallFlags.NONE, -1, null, (src, res) => {
                try {
                    this._bus.call_finish(res);
                } catch (e) {
                    /* polkit refused, or bluez is unhappy — rfkill is the
                     * blunt fallback and drives Powered via the kernel. */
                    log_err("Set Powered failed, falling back to rfkill", e);
                    Util.spawnCommandLineAsync(
                        "rfkill " + (state ? "unblock" : "block") + " bluetooth");
                }
                this.refresh();
            });
    }

    /* Connect/disconnect take seconds on BR/EDR.  Callers mark the row pending
     * and wait for PropertiesChanged rather than flipping optimistically,
     * which would make the switch visibly bounce back. */
    setDeviceConnected(path, state) {
        this._pending.add(path);
        this._bus.call(BLUEZ, path, BLUEZ_DEVICE,
                       state ? "Connect" : "Disconnect", null, null,
                       Gio.DBusCallFlags.NONE, 30000, null, (src, res) => {
            this._pending.delete(path);
            try {
                this._bus.call_finish(res);
            } catch (e) {
                log_err((state ? "Connect" : "Disconnect") + " " + path, e);
            }
            this.refresh();
        });
    }

    isPending(path) {
        return this._pending.has(path);
    }

    destroy() {
        for (let id of this._subs) {
            try { this._bus.signal_unsubscribe(id); } catch (e) {}
        }
        this._subs = [];
    }
}

/* ------------------------------------------------------------------------ *
 * macOS Control Center widgets.
 *
 * The grid is built from raw St actors, never PopupBaseMenuItems.  That is
 * deliberate: PopupMenu syncs column widths across every menu item on each
 * layout pass (popupMenu.js:2628-2635), which would distort a grid.  Raw
 * actors with _delegate = null are skipped by that machinery entirely
 * (popupMenu.js:2054-2083).
 * ------------------------------------------------------------------------ */

const MENU_WIDTH = 330;          /* logical px, before ui_scale */
const CELL = 66;                 /* circle diameter, pill height, column width */

/* A round icon button.  State is applied by an explicit style class rather
 * than a :checked pseudo-class so it does not depend on how the active theme
 * resolves descendant pseudo-selectors. */
class CircleToggle {
    constructor(iconName, onToggle) {
        this.actor = new St.Button({ style_class: 'cc-circle', can_focus: true });
        this._icon = new St.Icon({ icon_name: iconName,
                                   icon_type: St.IconType.SYMBOLIC,
                                   icon_size: 17 });
        this.actor.set_child(this._icon);
        this._on = false;
        this.actor.connect('clicked', () => onToggle(!this._on));
    }

    setChecked(on) {
        this._on = !!on;
        if (on) this.actor.add_style_class_name('cc-circle-on');
        else    this.actor.remove_style_class_name('cc-circle-on');
    }

    setIcon(name) { this._icon.icon_name = name; }

    setSensitive(sensitive) {
        this.actor.reactive = sensitive;
        this.actor.can_focus = sensitive;
        if (sensitive) this.actor.remove_style_class_name('cc-circle-dim');
        else           this.actor.add_style_class_name('cc-circle-dim');
    }
}

/* Title over a dimmer subtitle — the macOS tile caption. */
class TileLabelPair {
    constructor(title, sub) {
        this.actor = new St.BoxLayout({ vertical: true });
        this._title = new St.Label({ text: title, style_class: 'cc-tile-title' });
        this._sub   = new St.Label({ text: sub || '', style_class: 'cc-tile-sub' });
        /* Apple wraps "Do Not / Disturb" rather than ellipsising it. */
        this._title.clutter_text.line_wrap = true;
        this._title.clutter_text.ellipsize = 3;   /* Pango.EllipsizeMode.END */
        this.actor.add(this._title);
        this.actor.add(this._sub);
    }
    setTitle(t) { this._title.text = t; }
    setSub(t) {
        this._sub.text = t || '';
        this._sub.visible = !!t;
    }
}

/* A glass pill: round toggle on the left, title/subtitle beside it, the
 * label area clickable to open a detail page.  Wi-Fi, Bluetooth, Warpinator. */
class ConnRow {
    constructor(title, iconName, onToggle, onOpenDetail) {
        this.actor = new St.BoxLayout({ style_class: 'cc-tile cc-pill' });

        this.toggle = new CircleToggle(iconName, onToggle);
        this.actor.add(this.toggle.actor, { y_align: St.Align.MIDDLE, y_fill: false });

        this.labels = new TileLabelPair(title, '');
        this._btn = new St.Button({ style_class: 'cc-pill-label', can_focus: true,
                                    x_fill: true });
        this._btn.set_child(this.labels.actor);
        this._btn.connect('clicked', onOpenDetail);
        this.actor.add(this._btn, { expand: true, x_fill: true,
                                    y_align: St.Align.MIDDLE, y_fill: false });
    }
    setChecked(on) { this.toggle.setChecked(on); }
    setIcon(n)     { this.toggle.setIcon(n); }
    setSub(t)      { this.labels.setSub(t); }
}

/* A round glass button (Night Light, Dark Mode, Screen Mirroring,
 * Screenshot).  No caption, like Apple's; the tooltip carries the name.
 * Toggles go white with a blue glyph when on. */
class CircleButton {
    constructor(title, iconName, onClick) {
        this.actor = new St.Button({ style_class: 'cc-tile cc-round', can_focus: true });
        this._icon = new St.Icon({ icon_type: St.IconType.SYMBOLIC, icon_size: 22 });
        this.setIcon(iconName);
        this.actor.set_child(this._icon);
        this._on = false;
        this.actor.connect('clicked', () => onClick(!this._on));
        try { this.tooltip = new Tooltips.Tooltip(this.actor, title); } catch (e) {}
    }
    setChecked(on) {
        this._on = !!on;
        if (on) this.actor.add_style_class_name('cc-round-on');
        else    this.actor.remove_style_class_name('cc-round-on');
    }
    /* An absolute path loads one of this applet's own SVGs (icons/), the
     * same GFileIcon route the panel glyph uses; anything else is a theme
     * icon name. */
    setIcon(n) {
        if (n && n[0] === '/')
            this._icon.gicon = new Gio.FileIcon({ file: Gio.file_new_for_path(n) });
        else
            this._icon.icon_name = n;
    }
    setSub(t)  { /* circles carry no caption */ }
}

/* Sonoma's Focus tile: one wide button, round icon on the left, title and
 * subtitle beside it.  Same state handling as ToggleTile. */
class WideToggleTile {
    constructor(title, iconName, onToggle) {
        this.actor = new St.Button({ style_class: 'cc-tile cc-pill cc-pill-button',
                                     can_focus: true, x_fill: true, y_fill: true });
        let box = new St.BoxLayout({ style_class: 'cc-wide-box' });

        this._circle = new St.Bin({ style_class: 'cc-circle' });
        this._icon = new St.Icon({ icon_name: iconName,
                                   icon_type: St.IconType.SYMBOLIC,
                                   icon_size: 17 });
        this._circle.set_child(this._icon);
        box.add(this._circle, { y_align: St.Align.MIDDLE, y_fill: false });

        this.labels = new TileLabelPair(title, '');
        box.add(this.labels.actor, { expand: true, x_fill: true,
                                     y_align: St.Align.MIDDLE, y_fill: false });

        this.actor.set_child(box);
        this._on = false;
        this.actor.connect('clicked', () => onToggle(!this._on));
    }

    setChecked(on) {
        this._on = !!on;
        if (on) this._circle.add_style_class_name('cc-circle-on');
        else    this._circle.remove_style_class_name('cc-circle-on');
    }
    setIcon(n) { this._icon.icon_name = n; }
    setSub(t)  { this.labels.setSub(t); }
}

/*
 * A thin macOS slider: small icon, track, large icon, optional trailing
 * round button (Sound's AirPlay spot).
 *
 * The stock VolumeSlider / BrightnessSlider keep everything they need after
 * construction on `_slider` and `icon`, not on `actor` (popupMenu.js:670-675,
 * :779-781, :825-828), and removeActor() is a clean unparent with no destroy
 * (popupMenu.js:246-249), so both children are lifted out and re-hosted.
 * The stock icon stays on the left: for volume it is the click-to-mute
 * target (sound@:110-119) and changes with the level.
 */
class FatSlider {
    constructor(item, rightIcon, trailing) {
        this.item = item;

        try { item.removeActor(item.icon); }    catch (e) {}
        try { item.removeActor(item._slider); } catch (e) {}

        this.actor = new St.BoxLayout({ style_class: 'cc-slider', x_expand: true });
        this.actor._delegate = null;

        this._leftBin = new St.Bin({ style_class: 'cc-slider-left', y_align: St.Align.MIDDLE });
        this._leftBin.set_child(item.icon);
        this.actor.add(this._leftBin, { y_align: St.Align.MIDDLE, y_fill: false });

        item._slider.add_style_class_name('cc-thin-groove');
        this.actor.add(item._slider, { expand: true, x_fill: true,
                                       y_align: St.Align.MIDDLE, y_fill: false });

        this._right = new St.Icon({ icon_name: rightIcon,
                                    icon_type: St.IconType.SYMBOLIC,
                                    icon_size: 18, style_class: 'cc-slider-right' });
        this.actor.add(this._right, { y_align: St.Align.MIDDLE, y_fill: false });

        if (trailing)
            this.actor.add(trailing, { y_align: St.Align.MIDDLE, y_fill: false });

        /* Re-anchor the tooltip.  Bound to the now-orphaned actor it would
         * never receive motion, so mousePosition stays null and show() would
         * silently no-op (tooltips.js:238-240). */
        try {
            let text = item.tooltipText || '';
            if (item.tooltip) item.tooltip.destroy();
            item.tooltip = new Tooltips.Tooltip(item._slider, text);
        } catch (e) {
            log_err("re-anchoring slider tooltip", e);
        }

        /* Mirror the orphan's visibility: BrightnessSlider hides itself until
         * its D-Bus proxy answers (power@:222, :274) and VolumeSlider hides on
         * a null stream (sound@:129). */
        this._visId = item.actor.connect('notify::visible',
            () => { this.actor.visible = item.actor.visible; });
        this.actor.visible = item.actor.visible;
    }

    destroy() {
        if (this._visId) {
            try { this.item.actor.disconnect(this._visId); } catch (e) {}
            this._visId = 0;
        }
        try { this.actor.destroy(); } catch (e) {}
    }
}

/* Full-width tile: caption above a fat slider. */
class SliderTile {
    constructor(title, fatSlider) {
        this.actor = new St.BoxLayout({ vertical: true, style_class: 'cc-tile cc-slider-tile' });
        this.actor.add(new St.Label({ text: title, style_class: 'cc-tile-title' }));
        this.actor.add(fatSlider.actor, { expand: true, x_fill: true });
        this.fat = fatSlider;
        /* follow the slider's own visibility up to the whole tile */
        fatSlider.actor.connect('notify::visible',
            () => { this.actor.visible = fatSlider.actor.visible; });
        this.actor.visible = fatSlider.actor.visible;
    }
}

/* The Now Playing square: art placeholder, title, transport buttons.  Driven
 * by whichever sound@ Player is active; idle it reads "Not Playing". */
class NowPlayingTile {
    constructor() {
        this.actor = new St.BoxLayout({ vertical: true, style_class: 'cc-tile cc-nowplaying' });
        this._art = new St.Bin({ style_class: 'cc-np-art' });
        this.actor.add(this._art, { x_align: St.Align.START, x_fill: false });
        this._title = new St.Label({ text: _("Not Playing"), style_class: 'cc-np-title' });
        this.actor.add(this._title, { x_fill: true });

        let row = new St.BoxLayout({ style_class: 'cc-np-controls' });
        const btn = (icon, cb) => {
            let b = new St.Button({ style_class: 'cc-np-btn', can_focus: true });
            b.set_child(new St.Icon({ icon_name: icon, icon_type: St.IconType.SYMBOLIC,
                                      icon_size: 18 }));
            b.connect('clicked', () => { try { cb(); } catch (e) { log_err("media control", e); } });
            row.add(b, { expand: true, x_fill: false, x_align: St.Align.MIDDLE });
            return b;
        };
        this._prev = btn("xsi-media-skip-backward-symbolic", () => this._call("PreviousRemote"));
        this._play = btn("xsi-media-playback-start-symbolic", () => this._call("PlayPauseRemote"));
        this._next = btn("xsi-media-skip-forward-symbolic",  () => this._call("NextRemote"));
        this._play.add_style_class_name('cc-np-play');
        this.actor.add(row, { x_fill: true });

        this._player = null;
        this._sync();
    }

    _call(method) {
        let p = this._player && this._player._mediaServerPlayer;
        if (p && typeof p[method] === "function") p[method]();
    }

    setPlayer(player) {
        this._player = player || null;
        this._sync();
    }

    /* called again by the applet whenever the player's status/metadata move */
    _sync() {
        let p = this._player;
        let playing = !!(p && p._playerStatus === "Playing");
        let active = !!(p && p._playerStatus && p._playerStatus !== "Stopped");
        let title = (active && p._title && p._title !== _("Unknown Title")) ? p._title
                  : (active ? _("Now Playing") : _("Not Playing"));
        this._title.text = title;
        this._play.child.icon_name = playing ? "xsi-media-playback-pause-symbolic"
                                             : "xsi-media-playback-start-symbolic";
        for (let b of [this._prev, this._play, this._next]) {
            b.reactive = !!p;
            if (p) b.remove_style_class_name('cc-np-dim');
            else   b.add_style_class_name('cc-np-dim');
        }
    }
}

/*
 * Two-page menu: the raw-actor grid, and detail pages for Wi-Fi/Bluetooth.
 *
 * The detail pages stay real PopupMenuSections on purpose — the reused
 * NMDeviceWireless.section is built from PopupBaseMenuItems and needs the
 * menu's column-width syncing to stay aligned.
 */
class PageStack {
    constructor(menu, widthPx) {
        this.menu = menu;
        this._w = widthPx * global.ui_scale;
        this._pages = {};
    }

    addRawPage(name, content) {
        let sec = new PopupMenu.PopupMenuSection();
        sec.actor.add_style_class_name('cc-page');
        /* Deliberately no natural_width here.  Imposing one makes the grid
         * under-report its requirement, and St.Table then allocates its real
         * width anyway and overflows the page's content box instead of
         * shrinking.  Let it ask for what it needs; pinWidth() matches the
         * other pages to it afterwards. */
        sec.addActor(content);          /* popupMenu.js:2099 takes one arg only */
        this.menu.addMenuItem(sec);
        this._pages[name] = sec;
        return sec;
    }

    addMenuPage(name, titleText, onBack) {
        let sec = new PopupMenu.PopupMenuSection();
        sec.actor.add_style_class_name('cc-page');
        sec.actor.add_style_class_name('cc-page-detail');
        sec.actor.natural_width = this._w;

        let hdr = new St.BoxLayout({ style_class: 'cc-detail-header' });
        hdr._delegate = null;
        let back = new St.Button({ style_class: 'cc-back-button', can_focus: true });
        back.set_child(new St.Icon({ icon_name: 'xsi-go-previous-symbolic',
                                     icon_type: St.IconType.SYMBOLIC,
                                     icon_size: 16 }));
        back.connect('clicked', onBack);
        hdr.add(back, { y_align: St.Align.MIDDLE, y_fill: false });
        hdr.add(new St.Label({ text: titleText, style_class: 'cc-detail-title' }),
                { expand: true, y_align: St.Align.MIDDLE, y_fill: false });
        sec.addActor(hdr);

        this.menu.addMenuItem(sec);
        sec.actor.visible = false;
        this._pages[name] = sec;
        return sec;
    }

    show(name) {
        for (let k in this._pages)
            this._pages[k].actor.visible = (k === name);
    }

    /* The grid's own minimum width exceeds MENU_WIDTH once the tiles are laid
     * out, so pinning only natural_width leaves the detail pages narrower and
     * the menu visibly resizes when paging.  Pin every page to the grid's real
     * width instead, measured on first open. */
    pageActor(name) { return this._pages[name] ? this._pages[name].actor : null; }

    pinWidth(w) {
        for (let k in this._pages) {
            this._pages[k].actor.min_width = w;
            this._pages[k].actor.natural_width = w;
        }
    }

    reset() { this.show('grid'); }
}

/* ------------------------------------------------------------------------ *
 * Panel battery glyph, drawn the way macOS draws its menu bar battery.
 *
 * The icon theme's battery-level-N icons are squat (≈1.3:1) and quantised to
 * ten steps.  macOS's is ≈2:1, the frame and nub are painted at reduced
 * opacity in the label colour, and the solid fill inside tracks the exact
 * percentage.  On AC a lightning bolt is knocked out of the fill; at or under
 * LOW_PCT the fill turns systemRed; in Low Power Mode it turns systemYellow.
 * None of that is expressible as a themed icon, so it is a St.DrawingArea.
 *
 * Colour comes from the theme node's foreground at repaint time, exactly as
 * PopupMenu's dot does (popupMenu.js:264-278), so the glyph follows whatever
 * the panel theme sets for `color` and needs no colours of its own.
 * ------------------------------------------------------------------------ */
const BatteryDraw = require('./lib/batteryGlyph');

class MacBatteryIcon {
    constructor(logicalSize) {
        this.actor = new St.DrawingArea({ style_class: 'cc-battery-glyph' });
        this._pct = 0;
        this._onAC = false;
        this._lowPower = false;
        this.setSize(logicalSize);
        this.actor.connect('repaint', (a) => this._repaint(a));
    }

    /* St.Icon takes a logical size and scales it itself; a DrawingArea is
     * allocated in device pixels, so ui_scale is applied here. */
    setSize(logicalSize) {
        let h = Math.round(logicalSize * global.ui_scale);
        this.actor.set_size(Math.round(h * BatteryDraw.BATTERY_ASPECT), h);
        this.actor.queue_repaint();
    }

    setState(pct, onAC) {
        this._pct = Math.max(0, Math.min(100, pct || 0));
        this._onAC = !!onAC;
        this.actor.queue_repaint();
    }

    setLowPower(on) {
        if (this._lowPower === !!on) return;
        this._lowPower = !!on;
        this.actor.queue_repaint();
    }

    _repaint(area) {
        let cr = area.get_context();
        let [W, H] = area.get_surface_size();
        let fg = area.get_theme_node().get_foreground_color();
        BatteryDraw.drawBattery(cr, W, H,
                                [fg.red / 255, fg.green / 255, fg.blue / 255],
                                global.ui_scale, this._pct, this._onAC, this._lowPower);
        cr.$dispose();
    }
}

/* macOS battery menu header: bold "Battery" with the percentage on the right,
 * then "Power Source: …" and a time line underneath. */
class BatteryHeader extends PopupMenu.PopupBaseMenuItem {
    constructor() {
        super({ reactive: false });
        this.actor.add_style_class_name('cc-batt-header-item');

        let box = new St.BoxLayout({ vertical: true, style_class: 'cc-batt-header' });
        let row = new St.BoxLayout({ style_class: 'cc-batt-title-row' });
        this._title = new St.Label({ text: _("Battery"), style_class: 'cc-batt-title' });
        this._pct   = new St.Label({ text: '', style_class: 'cc-batt-pct' });
        row.add(this._title, { expand: true, x_fill: true });
        row.add(this._pct, { x_align: St.Align.END });
        this._source = new St.Label({ text: '', style_class: 'cc-batt-sub' });
        this._time   = new St.Label({ text: '', style_class: 'cc-batt-sub' });
        box.add(row);
        box.add(this._source);
        box.add(this._time);
        this.addActor(box, { expand: true });
    }

    update(pct, state, seconds) {
        this._pct.text = (pct === null || pct === undefined) ? '' : Math.round(pct) + "%";

        let onAC = state === UPDeviceState.CHARGING ||
                   state === UPDeviceState.FULLY_CHARGED ||
                   state === UPDeviceState.PENDING_CHARGE;
        this._source.text = _("Power Source: %s").format(
            onAC ? _("Power Adapter") : _("Battery"));

        let hhmm = "";
        if (seconds > 0) {
            let mins = Math.round(seconds / 60);
            hhmm = "%d:%02d".format(Math.floor(mins / 60), mins % 60);
        }
        let t = "";
        if (state === UPDeviceState.FULLY_CHARGED)    t = _("Fully Charged");
        else if (state === UPDeviceState.CHARGING)    t = hhmm ? _("Time to Full: %s").format(hhmm) : _("Charging");
        else if (state === UPDeviceState.DISCHARGING) t = hhmm ? _("Time Remaining: %s").format(hhmm) : _("Using Battery");
        this._time.text = t;
        this._time.visible = !!t;
    }
}

const IFACE_SCHEMA  = "org.cinnamon.desktop.interface";
const CTHEME_SCHEMA = "org.cinnamon.theme";
const PORTAL_SCHEMA = "org.x.apps.portal";
const THEME_DARK    = "WhiteSur-Dark-solid";
const THEME_LIGHT   = "WhiteSur-Light-solid";

/* new Gio.Settings() on an unknown schema aborts the whole process, so every
 * schema this applet does not own goes through here first. */
function settingsIfPresent(schemaId) {
    let src = Gio.SettingsSchemaSource.get_default();
    if (!src || !src.lookup(schemaId, true)) return null;
    return new Gio.Settings({ schema_id: schemaId });
}

function themeInstalled(name) {
    for (let base of [GLib.get_home_dir() + "/.themes",
                      GLib.get_user_data_dir() + "/themes",
                      "/usr/share/themes"]) {
        if (GLib.file_test(base + "/" + name + "/cinnamon/cinnamon.css",
                           GLib.FileTest.EXISTS))
            return true;
    }
    return false;
}

const NIGHT_SCHEMA = "org.cinnamon.settings-daemon.plugins.color";
const NIGHT_KEY    = "night-light-enabled";
const DND_SCHEMA   = "org.cinnamon.desktop.notifications";
const DND_KEY      = "display-notifications";   /* false == Do Not Disturb ON */

class ControlCenterApplet extends Applet.TextIconApplet {
    constructor(metadata, orientation, panel_height, instance_id) {
        super(orientation, panel_height, instance_id);

        this.setAllowedLayout(Applet.AllowedLayout.BOTH);
        this.set_applet_tooltip(_("Control Center"));
        this.set_show_label_in_vertical_panels(false);
        this.set_applet_label("");

        /* The base Applet actor is itself track_hover and gets a full-width
         * `.applet-box:hover` highlight from the theme (cinnamon.css) — one
         * background rectangle spanning the battery item, the gap and the
         * glyph together.  Now that each item paints its own hover pill
         * (cc-panel-battery-btn / cc-panel-cc-btn), that outer highlight only
         * has to be neutralised, scoped to this applet alone via this extra
         * class so no other applet on the panel is affected. */
        this.actor.add_style_class_name('cc-panel-actor');

        this._uuid = metadata.uuid;
        this._metaPath = metadata.path;
        /* The battery slot stays empty until csd-power answers.  Its child is
         * our own Cairo glyph, never a St.Icon: set_applet_icon_* is not
         * called anywhere, so the base class's _applet_icon stays undefined
         * and on_panel_height_changed_internal leaves the box alone. */
        this._applet_icon_box.hide();
        this._batteryGlyph = new MacBatteryIcon(this.getPanelIconSize(St.IconType.SYMBOLIC));
        this._applet_icon_box.set_child(this._batteryGlyph.actor);

        this.settings = new Settings.AppletSettings(this, metadata.uuid, instance_id);
        this.settings.bind("labelinfo", "labelinfo", () => this._updateBatteryLabel());
        this.settings.bind("wifiListMode", "wifiListMode");
        this.settings.bind("wifiMaxHeight", "wifiMaxHeight", () => this._applyWifiHeight());
        this.settings.bind("btSettingsCmd", "btSettingsCmd");
        this.settings.bind("showMediaPlayer", "showMediaPlayer",
                           () => this._updatePlayerMenuItems());

        this.menuManager = new PopupMenu.PopupMenuManager(this);

        /* The macOS Control Center glyph, appended after [icon][label] so the
         * panel reads  [74%][battery] [glyph].  Loaded as a GFileIcon rather
         * than by name: same route as set_applet_icon_symbolic_path
         * (applet.js:749-762), which sidesteps icon-theme cache timing.
         * It sits in its own bin because that bin is the Control Center
         * menu's sourceActor (see _makeMenu). */
        /* Two layers per item: an invisible full-height hit area (reactive,
         * the menu's sourceActor) around the small visible pill.  A click
         * that lands on the applet's own padding is otherwise a press the
         * base class turns into on_applet_clicked() while the release lands
         * outside the sourceActor, which PopupMenuManager treats as "close" —
         * the open-then-instantly-close glitch at the corners. */
        this._ccPill = new St.Bin({ style_class: 'cc-panel-cc-btn',
                                    y_align: St.Align.MIDDLE });
        this._ccBtn = new St.Bin({ reactive: true, track_hover: true,
                                   style_class: 'cc-panel-hit cc-panel-hit-cc',
                                   y_align: St.Align.MIDDLE });
        this._ccBtn.set_child(this._ccPill);
        try {
            this._ccGlyph = new St.Icon({
                style_class: 'system-status-icon cc-panel-glyph',
                icon_type: St.IconType.SYMBOLIC,
                icon_size: this.getPanelIconSize(St.IconType.SYMBOLIC),
                gicon: new Gio.FileIcon({
                    file: Gio.file_new_for_path(
                        this._metaPath + "/icons/cc-controls-symbolic.svg") })
            });
            this._ccPill.set_child(this._ccGlyph);
        } catch (e) {
            log_err("control center glyph", e);
        }
        this.actor.add(this._ccBtn, { y_align: St.Align.MIDDLE, y_fill: true });

        /* macOS shows battery-icon and percentage-label as one menu-bar item,
         * distinct from the Control Center glyph beside it.  Reparenting both
         * into a single wrapper makes that literal: one reactive actor, one
         * click target, one hover highlight, rather than two separately-wired
         * actors that a single click could touch independently.
         *
         * The wrapper intercepts on 'button-press-event', not 'release': the
         * whole-applet actor calls on_applet_clicked() (=> opens the Control
         * Center menu) from its own 'button-press-event' handler
         * (applet.js base class), which fires and bubbles *before* any
         * 'button-release-event' this wrapper could hook.  Only stopping
         * propagation on the press itself keeps a click on the battery item
         * from also popping the Control Center menu open first. */
        this._batteryBtn = new St.BoxLayout({ style_class: 'cc-panel-battery-btn' });
        this._batteryHit = new St.Bin({ reactive: true, track_hover: true,
                                        style_class: 'cc-panel-hit cc-panel-hit-battery',
                                        y_align: St.Align.MIDDLE });
        this._batteryHit.set_child(this._batteryBtn);
        this.actor.remove_actor(this._applet_icon_box);
        this.actor.remove_actor(this._layoutBin);
        /* macOS order:  74% [battery]  — label first, glyph second. */
        this._batteryBtn.add(this._layoutBin,
                             { y_align: St.Align.MIDDLE, y_fill: false });
        this._batteryBtn.add(this._applet_icon_box,
                             { y_align: St.Align.MIDDLE, y_fill: false });
        this.actor.insert_child_at_index(this._batteryHit, 0);
        this.actor.child_set(this._batteryHit, { y_fill: true, y_align: St.Align.MIDDLE });

        /* macOS keeps battery and Control Center as separate menu bar items:
         * two menus, each anchored to its own small item.  Not
         * Applet.AppletPopupMenu — that hard-codes the whole applet actor as
         * sourceActor for both, and PopupMenuManager switches menus on
         * enter-event of the *other* menu's sourceActor (popupMenu.js:3474,
         * :3605-3620).  With one shared source, merely moving the pointer
         * across the applet's children while the Control Center was open
         * bubbled an enter-event to it and swapped in the battery menu. */
        this.menu = this._makeMenu(this._ccBtn, orientation,
                                   ["control-center-menu", "cc-main-menu"]);
        this.batteryMenu = this._makeMenu(this._batteryHit, orientation,
                                          ["control-center-menu", "cc-battery-menu"]);

        this._ccBtn.connect('button-press-event', () => {
            this._toggleExclusive(this.menu);
            return Clutter.EVENT_STOP;
        });
        this._batteryHit.connect('button-press-event', () => {
            this._toggleExclusive(this.batteryMenu);
            return Clutter.EVENT_STOP;
        });

        this._pages = new PageStack(this.menu, MENU_WIDTH);

        this._grid = new St.Table({ style_class: 'cc-grid', homogeneous: false });
        this._grid._delegate = null;      /* keep it out of the column sync */
        this._pages.addRawPage('grid', this._grid);

        this._wifiPage = this._pages.addMenuPage('wifi', _("Wi-Fi"),
                                                 () => this._pages.reset());
        this._btPage   = this._pages.addMenuPage('bt', _("Bluetooth"),
                                                 () => this._pages.reset());

        this._tile("wifi",       () => this._initWifi());
        this._tile("bluetooth",  () => this._initBluetooth());
        this._tile("share",      () => this._initShare());
        this._tile("nowplaying", () => { this._nowPlaying = new NowPlayingTile(); });
        this._tile("dnd",        () => this._initDnd());
        this._tile("darkmode",   () => this._initDarkMode());
        this._tile("nightlight", () => this._initNightLight());
        this._tile("shortcuts",  () => this._initShortcuts());
        this._tile("sliders",    () => this._initSliders());
        this._tile("media",      () => this._initMedia());
        this._tile("battery",    () => this._initBattery());

        this._assembleGrid();
        this._pages.show('grid');

        /* This runs while PopupMenuManager holds the global modal grab.  An
         * exception escaping here would skip Main.popModal() and leave the
         * whole desktop unclickable, so it can never be allowed to throw. */
        this.menu.connect('open-state-changed', (m, open) => {
            try {
                if (open) this._pinPageWidths();
                else      this._pages.reset();
            } catch (e) {
                log_err("menu open-state-changed", e);
            }
            /* macOS keeps a menu-bar item highlighted for as long as its menu
             * is open, on top of (not instead of) the hover state. */
            if (this._ccBtn) {
                if (open) this._ccBtn.add_style_class_name('cc-panel-btn-active');
                else      this._ccBtn.remove_style_class_name('cc-panel-btn-active');
            }
        });
        this.batteryMenu.connect('open-state-changed', (m, open) => {
            if (this._batteryHit) {
                if (open) this._batteryHit.add_style_class_name('cc-panel-btn-active');
                else      this._batteryHit.remove_style_class_name('cc-panel-btn-active');
            }
        });

        try {
            this.settings.bind("keyOpen", "keyOpen", () => this._setKeybinding());
            this._setKeybinding();
        } catch (e) {
            log_err("keybinding", e);
        }

        /* blueman stays running — it is the pairing agent — but its tray icon
         * is redundant now that Bluetooth lives here. */
        try {
            Main.systrayManager.registerTrayIconReplacement("blueman", this._uuid);
            Main.systrayManager.registerTrayIconReplacement("bluetooth", this._uuid);
        } catch (e) {
            log_err("systray replacement", e);
        }
    }

    /*
     * One PopupMenuManager, two menus, one shared sourceActor: if both are ever
     * open at once, the manager's _activeMenu and the menus' isOpen flags
     * desync.  Entering the shared source then sends _onMenuSourceEnter into
     * _changeMenu (popupMenu.js:3591-3620), which nulls _activeMenu, closes the
     * old menu without ungrabbing, and calls open() on a menu that is already
     * open — an early return (popupMenu.js:2329-2331) that emits no
     * open-state-changed.  The manager is then left grabbed with no active
     * menu: _closeMenu() is a no-op, _onEventCapture swallows every event, and
     * popModal is never reached.  That is a desktop-wide input freeze with no
     * recovery short of restarting Cinnamon, so the second menu must never be
     * allowed to open while the first one is.
     */
    /* What Applet.AppletPopupMenu does (applet.js:79-99) minus the :checked
     * pseudo-class on the applet box, which the stylesheet suppresses anyway
     * — but with a caller-chosen sourceActor. */
    _makeMenu(sourceActor, orientation, classes) {
        let m = new PopupMenu.PopupMenu(sourceActor, orientation);
        Main.uiGroup.add_actor(m.actor);
        m.actor.hide();
        for (let c of classes) m.actor.add_style_class_name(c);
        this.menuManager.addMenu(m);
        this.connect('orientation-changed', (a, o) => m.setOrientation(o));
        return m;
    }

    _toggleExclusive(menu) {
        let other = (menu === this.menu) ? this.batteryMenu : this.menu;
        /* close() is synchronous, so the manager sees the state change and
         * ungrabs cleanly before the other menu asks for a grab. */
        if (other.isOpen) other.close(true);
        menu.toggle();
    }

    _pinPageWidths() {
        if (this._widthPinned) return;
        /* The grid page's own preferred width already includes .cc-page
         * padding, which is what the detail pages have to match. */
        let gridPage = this._pages.pageActor('grid');
        if (!gridPage) return;
        let [minW, natW] = gridPage.get_preferred_width(-1);
        let w = Math.max(minW, natW);
        if (w <= 0) return;
        this._pages.pinWidth(w);
        this._widthPinned = true;
    }

    /* Each tile is built independently.  With network@, sound@ and power@ gone
     * from the panel, one uncaught exception would otherwise cost the user
     * Wi-Fi, volume, brightness and battery in a single stroke. */
    _tile(name, fn) {
        try {
            fn.call(this);
        } catch (e) {
            log_err("tile '" + name + "' failed to build", e);
            this["_" + name + "Failed"] = true;
        }
    }

    _failTile(label) {
        let tile = new St.BoxLayout({ vertical: true, style_class: 'cc-tile' });
        tile.add(new St.Label({ text: label, style_class: 'cc-tile-title' }));
        let btn = new St.Button({ style_class: 'cc-conn-label', can_focus: true });
        btn.set_child(new St.Label({ text: _("Open Settings…"),
                                     style_class: 'cc-tile-sub' }));
        btn.connect('clicked', () => {
            this.menu.close();
            Util.spawnCommandLine("cinnamon-settings");
        });
        tile.add(btn);
        return tile;
    }

    /*
     * StTableChild:allocate-hidden defaults to TRUE, so a hidden tile would
     * otherwise keep reserving its full cell.  Anything that can legitimately
     * be absent gets allocate_hidden:false.
     */
    _assembleGrid() {
        let g = this._grid;
        const cell = (actor, row, col, span, canHide) => {
            g.add(actor, { row: row, col: col, col_span: span || 1,
                           x_expand: true, y_expand: false,
                           x_fill: true, y_fill: true });
            if (canHide) g.child_set(actor, { allocate_hidden: false });
        };

        /* Left column: three pills.  Right column: the Now Playing square
         * over two round buttons.  Then two rounds and the Do Not Disturb
         * pill, then the sliders — Apple's Control Center, tile for tile. */
        let row = 0;
        for (let r of [this._wifiRow, this._btRow, this._shareRow]) {
            if (!r) continue;
            cell(r.actor, row++, 0, 2, true);
        }
        if (this._nowPlaying) {
            g.add(this._nowPlaying.actor, { row: 0, col: 2, col_span: 2, row_span: 2,
                                            x_expand: true, y_expand: false,
                                            x_fill: true, y_fill: true });
        }
        let col = 2;
        for (let b of [this._darkTile, this._nightTile]) {
            if (!b) continue;
            cell(b.actor, 2, col++, 1, false);
        }
        row = 3; col = 0;
        for (let b of [this._mirrorBtn, this._shotBtn]) {
            if (!b) continue;
            cell(b.actor, row, col++, 1, false);
        }
        if (this._dndTile) cell(this._dndTile.actor, row, 2, 2, false);
        row++;

        const wide = (actor, canHide) => {
            g.add(actor, { row: row, col: 0, col_span: 4,
                           x_expand: true, y_expand: false,
                           x_fill: true, y_fill: false });
            if (canHide) g.child_set(actor, { allocate_hidden: false });
            row++;
        };

        if (this._brightTile) wide(this._brightTile.actor, true);
        if (this._soundTile)  wide(this._soundTile.actor, true);
        if (this._slidersFailed) wide(this._failTile(_("Sliders unavailable")), false);
        if (this._mediaTile)  wide(this._mediaTile, true);

        /* Bottom row: the keyboard-backlight slider three columns wide, the
         * Screen Recording round button in the fourth. */
        if (this._kbdTile || this._recBtn) {
            if (this._kbdTile) {
                g.add(this._kbdTile.actor, { row: row, col: 0, col_span: this._recBtn ? 3 : 4,
                                             x_expand: true, y_expand: false,
                                             x_fill: true, y_fill: true });
                g.child_set(this._kbdTile.actor, { allocate_hidden: false });
            }
            if (this._recBtn)
                cell(this._recBtn.actor, row, 3, 1, false);
            row++;
        }
    }

    /* Warpinator is Mint's AirDrop; Screen Mirroring and Screenshot are the
     * two round shortcuts on Apple's bottom row. */
    _initShare() {
        let cmd = firstProgram(["warpinator"]);
        if (!cmd) return;
        const launch = () => { this.menu.close(); Util.spawnCommandLine(cmd); };
        this._shareRow = new ConnRow(_("Warpinator"), "xsi-share-symbolic", launch, launch);
        this._shareRow.setChecked(true);
        this._shareRow.setSub(_("Everyone"));
    }

    _initShortcuts() {
        let display = firstProgram(["cinnamon-settings display"]);
        if (display) {
            this._mirrorBtn = new CircleButton(_("Screen Mirroring"), "xsi-view-mirror-symbolic",
                () => { this.menu.close(); Util.spawnCommandLine(display); });
        }
        let shot = firstProgram(["gnome-screenshot -i", "flameshot gui"]);
        if (shot) {
            this._shotBtn = new CircleButton(_("Screenshot"), "xsi-screenshooter-symbolic",
                () => { this.menu.close(); Util.spawnCommandLine(shot); });
        }

        /* Cinnamon's built-in recorder (the Ctrl+Shift+Alt+R one).  The
         * button stays lit while recording; click again to stop. */
        if (Main.screenRecorder && typeof Main.screenRecorder.toggle_recording === "function") {
            this._recBtn = new CircleButton(_("Screen Recording"), "xsi-media-record-symbolic",
                () => {
                    this.menu.close();
                    try { Main.screenRecorder.toggle_recording(); }
                    catch (e) { log_err("screen recording", e); }
                });
            this._recBtn.actor.add_style_class_name('cc-round-record');
            const sync = () => this._recBtn.setChecked(!!Main.screenRecorder.recording);
            try {
                this._recId = Main.screenRecorder.connect("recording", () => sync());
            } catch (e) {}
            sync();
        }
    }

    /* -------------------------------------------------------------- Wi-Fi */

    _initWifi() {
        if (!NetLib || typeof NetLib.NMDeviceWireless !== "function")
            throw new Error("network module did not provide NMDeviceWireless");

        this._nmClient = NM.Client.new(null);

        this._connections = [];
        this._activeConnections = [];
        this._wifiDevices = [];
        this._mainConnection = null;

        this._ctypes = {};
        this._ctypes[NM.SETTING_WIRELESS_SETTING_NAME] = NetLib.NMConnectionCategory.WIRELESS;

        this._wifiRow = new ConnRow(_("Wi-Fi"),
            "xsi-network-wireless-signal-excellent-symbolic",
            (want) => this._setWifiEnabled(want),
            () => this._pages.show('wifi'));

        /* --- detail page --- */
        this._wifiSwitch = new NetLib.NMWirelessSectionTitleMenuItem(
            this._nmClient, "wireless", _("Wi-Fi"));
        this._wifiPage.addMenuItem(this._wifiSwitch);

        this._wifiSection = new PopupMenu.PopupMenuSection();
        this._wifiPage.addMenuItem(this._wifiSection);

        /* menu.box would clip a long SSID list rather than scroll it. */
        this._wifiScroll = new St.ScrollView({
            style_class: "control-center-wifi-scroll",
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC
        });
        let parent = this._wifiSection.actor.get_parent();
        if (parent) {
            parent.remove_actor(this._wifiSection.actor);
            this._wifiScroll.add_actor(this._wifiSection.actor);
            parent.add_actor(this._wifiScroll);
        }
        this._applyWifiHeight();

        let netCmd = firstProgram(["cinnamon-settings network"]);
        if (netCmd) {
            let item = new PopupMenu.PopupMenuItem(_("Wi-Fi Settings…"));
            item.connect("activate", () => {
                this.menu.close();
                Util.spawnCommandLine(netCmd);
            });
            this._wifiPage.addMenuItem(item);
        }

        /* Connections before devices: NMDevice._init silently drops any
         * connection not yet annotated with _uuid/_name (network@:329-338). */
        this._readConnections();
        this._readDevices();
        this._syncActiveConnections();
        this._syncWifiTitle();

        this._nmSignals = [
            this._nmClient.connect("device-added", (c, d) => this._deviceAdded(c, d)),
            this._nmClient.connect("device-removed", (c, d) => this._deviceRemoved(c, d)),
            this._nmClient.connect("connection-added", (c, x) => this._connectionAdded(c, x)),
            this._nmClient.connect("connection-removed", (c, x) => this._connectionRemoved(c, x)),
            this._nmClient.connect("notify::active-connections",
                                   () => this._syncActiveConnections()),
            this._nmClient.connect("notify::wireless-enabled",
                                   () => this._syncWifiTile()),
            this._nmClient.connect("notify::wireless-hardware-enabled",
                                   () => this._syncWifiTile())
        ];
    }

    /*
     * Drive NetworkManager directly, mirroring network@:279-291.
     *
     * Do NOT route this through this._wifiSwitch.activate(): that method only
     * toggles when this._switch.actor.mapped (popupMenu.js:933-939), and the
     * detail page is unmapped while the grid is showing — the click would
     * silently do nothing.
     */
    _setWifiEnabled(state) {
        if (!this._nmClient) return;
        this._nmClient.wireless_set_enabled(state);
        if (this._wifiDevices.length === 1) {
            try {
                if (state) this._wifiDevices[0].activate();
                else       this._wifiDevices[0].deactivate();
            } catch (e) {
                log_err("wifi device activate/deactivate", e);
            }
        }
    }

    _syncWifiTile() {
        if (!this._wifiRow || !this._nmClient) return;

        let sw = this._nmClient.wireless_enabled;
        let hw = this._nmClient.wireless_hardware_enabled;
        let on = sw && hw;

        this._wifiRow.setChecked(on);
        this._wifiRow.setIcon(on ? "xsi-network-wireless-signal-excellent-symbolic"
                                 : "xsi-network-wireless-offline-symbolic");
        /* A hardware killswitch is not something the user can undo from here. */
        this._wifiRow.toggle.setSensitive(hw);

        let sub = null;
        if (!hw)      sub = _("Hardware disabled");
        else if (!sw) sub = _("Off");
        else {
            try {
                let dev = this._wifiDevices[0];
                let ap = dev && dev.device ? dev.device.active_access_point : null;
                if (ap && ap.get_ssid())
                    sub = NetLib.ssidToLabel(ap.get_ssid());
                else if (dev && dev.statusLabel)
                    sub = dev.statusLabel;
            } catch (e) {}
            if (!sub) sub = _("Not connected");
        }
        this._wifiRow.setSub(sub);
    }

    /* One adapter: the section-title switch stands in for the device's own.
     * Several: each shows its own (network@:2030-2052). */
    _syncWifiTitle() {
        let devices = this._wifiDevices || [];

        if (devices.length === 0) {
            if (this._wifiSwitch) this._wifiSwitch.actor.hide();
            if (this._wifiScroll) this._wifiScroll.hide();
            if (this._wifiRow) this._wifiRow.actor.hide();
            this._syncWifiTile();
            return;
        }

        if (this._wifiRow) this._wifiRow.actor.show();
        this._wifiSwitch.actor.show();
        if (this._wifiScroll) this._wifiScroll.show();

        if (devices.length === 1) {
            devices[0].statusItem.actor.hide();
            this._wifiSwitch.updateForDevice(devices[0]);
        } else {
            for (let d of devices)
                d.statusItem.actor.visible = (d.device.state !== NM.DeviceState.UNMANAGED);
            this._wifiSwitch.updateForDevice(null);
        }
        this._syncWifiTile();
    }

    /* ---------------------------------------------------------- Bluetooth */

    _initBluetooth() {
        this._btRow = new ConnRow(_("Bluetooth"), "xsi-bluetooth-symbolic",
            (want) => this._bt.setPowered(want),
            () => this._pages.show('bt'));

        this._btSwitch = new PopupMenu.PopupSwitchMenuItem(_("Bluetooth"), false,
            { style_class: "popup-subtitle-menu-item" });
        this._btSwitch.connect("toggled", (item, state) => this._bt.setPowered(state));
        this._btPage.addMenuItem(this._btSwitch);

        this._btDeviceSection = new PopupMenu.PopupMenuSection();
        this._btPage.addMenuItem(this._btDeviceSection);

        let btCmd = this.btSettingsCmd && this.btSettingsCmd.length
            ? this.btSettingsCmd
            : firstProgram(["blueberry", "blueman-manager",
                            "gnome-control-center bluetooth"]);
        if (btCmd) {
            let item = new PopupMenu.PopupMenuItem(_("Bluetooth Settings…"));
            item.connect("activate", () => {
                this.menu.close();
                Util.spawnCommandLine(btCmd);
            });
            this._btPage.addMenuItem(item);
        }

        this._btRows = [];
        this._bt = new BluetoothManager(() => this._syncBluetooth());
    }

    _syncBluetooth() {
        if (!this._btRow) return;

        if (!this._bt.available) {
            this._btRow.actor.hide();
            return;
        }
        this._btRow.actor.show();

        this._btRow.setChecked(this._bt.powered);
        this._btRow.setIcon(this._bt.powered ? "xsi-bluetooth-symbolic"
                                             : "xsi-bluetooth-disabled-symbolic");
        if (this._btSwitch) this._btSwitch.setToggleState(this._bt.powered);

        for (let row of this._btRows) row.destroy();
        this._btRows = [];
        this._btDeviceSection.removeAll();

        if (!this._bt.powered) {
            this._btRow.setSub(_("Off"));
            return;
        }

        let connected = this._bt.devices.filter((d) => d.connected);
        this._btRow.setSub(connected.length
            ? connected.map((d) => d.alias).join(", ")
            : _("On"));

        if (this._bt.devices.length) {
            let cap = new PopupMenu.PopupMenuItem(_("My Devices"),
                { reactive: false, style_class: 'cc-batt-caption' });
            this._btDeviceSection.addMenuItem(cap);
            this._btRows.push(cap);
        }

        /* macOS rows: round device glyph (white/blue while connected), name,
         * status on the right; the whole row toggles the connection. */
        for (let dev of this._bt.devices) {
            let row = new PopupMenu.PopupBaseMenuItem();
            row.actor.add_style_class_name('cc-net-row');

            let circle = new St.Bin({ style_class: 'cc-circle cc-list-circle' });
            circle.set_child(new St.Icon({ icon_name: this._btIconFor(dev.icon),
                                           icon_type: St.IconType.SYMBOLIC, icon_size: 15 }));
            if (dev.connected) circle.add_style_class_name('cc-circle-on');

            let status = "";
            if (this._bt.isPending(dev.path))      status = _("Connecting…");
            else if (dev.connected) {
                status = _("Connected");
                if (dev.battery !== null && dev.battery !== undefined)
                    status += " · " + Math.round(dev.battery) + "%";
            }
            /* one actor per row — see _skinWifiItem for why */
            let box = new St.BoxLayout({ style_class: 'cc-net-box' });
            box.add(circle, { y_align: St.Align.MIDDLE, y_fill: false });
            box.add(new St.Label({ text: dev.alias }),
                    { expand: true, x_fill: true, y_align: St.Align.MIDDLE, y_fill: false });
            box.add(new St.Label({ text: status, style_class: 'cc-net-status' }),
                    { y_align: St.Align.MIDDLE, y_fill: false });
            row.addActor(box, { expand: true, span: -1 });

            if (this._bt.isPending(dev.path)) row.setSensitive(false);
            row.connect("activate", () => {
                row.setSensitive(false);
                this._bt.setDeviceConnected(dev.path, !dev.connected);
            });
            this._btDeviceSection.addMenuItem(row);
            this._btRows.push(row);
        }
    }

    /* ------------------------------------------- Do Not Disturb / Night Light */

    _initDnd() {
        this._dndSettings = new Gio.Settings({ schema_id: DND_SCHEMA });
        /* Apple's pill: white circle with an indigo moon while it is on. */
        this._dndTile = new WideToggleTile(_("Do Not Disturb"),
            "xsi-weather-clear-night-symbolic",
            /* Inverted: DND on means notifications off. */
            (wantDnd) => this._dndSettings.set_boolean(DND_KEY, !wantDnd));
        this._dndTile._circle.add_style_class_name('cc-circle-focus');
        this._dndId = this._dndSettings.connect("changed::" + DND_KEY,
                                                () => this._syncDnd());
        this._syncDnd();
    }

    _syncDnd() {
        let dnd = !this._dndSettings.get_boolean(DND_KEY);
        this._dndTile.setChecked(dnd);
        this._dndTile.setIcon("xsi-weather-clear-night-symbolic");
        this._dndTile.setSub(dnd ? _("On") : _("Off"));
    }

    /* ------------------------------------------------------- Dark Mode */

    /* macOS keeps Dark Mode under Control Center > Display.  Here it flips
     * the WhiteSur pair for GTK and Cinnamon, tells portal/libadwaita apps
     * via org.x.apps.portal, swaps the user's dark-only gtk.css, and
     * restyles this applet's own menus (cc-light). */
    _initDarkMode() {
        this._ifaceSettings = new Gio.Settings({ schema_id: IFACE_SCHEMA });
        this._darkTile = new CircleButton(_("Dark Mode"),
            this._metaPath + "/icons/cc-darkmode-symbolic.svg",
            (want) => this._setDarkMode(want));
        this._darkId = this._ifaceSettings.connect("changed::gtk-theme",
                                                   () => this._syncDarkMode());
        this._syncDarkMode();
    }

    _isDarkMode() {
        return this._ifaceSettings.get_string("gtk-theme").indexOf("-Dark") !== -1;
    }

    _syncDarkMode() {
        let dark = this._isDarkMode();
        this._darkTile.setChecked(dark);
        this._darkTile.setSub(dark ? _("On") : _("Off"));
        for (let m of [this.menu, this.batteryMenu]) {
            if (!m) continue;
            if (dark) m.actor.remove_style_class_name('cc-light');
            else      m.actor.add_style_class_name('cc-light');
        }
    }

    _setDarkMode(want) {
        let theme = want ? THEME_DARK : THEME_LIGHT;
        if (!themeInstalled(theme)) {
            log_err("dark mode", new Error(theme + " is not installed"));
            return;
        }
        this._ifaceSettings.set_string("gtk-theme", theme);
        let ctheme = settingsIfPresent(CTHEME_SCHEMA);
        if (ctheme) ctheme.set_string("name", theme);
        let portal = settingsIfPresent(PORTAL_SCHEMA);
        if (portal) portal.set_string("color-scheme", want ? "prefer-dark" : "default");
        this._swapGtkCss(want);
    }

    /* ~/.config/gtk-3.0/gtk.css is a hand-written dark-only restyle.  It is
     * kept as gtk.css.dark and gtk.css is a symlink to it only in dark mode.
     * A real (non-symlink) gtk.css is never touched. */
    _swapGtkCss(dark) {
        try {
            let dir = GLib.get_user_config_dir() + "/gtk-3.0";
            if (!GLib.file_test(dir + "/gtk.css.dark", GLib.FileTest.EXISTS)) return;
            let link = Gio.file_new_for_path(dir + "/gtk.css");
            let exists = GLib.file_test(dir + "/gtk.css", GLib.FileTest.EXISTS) ||
                         GLib.file_test(dir + "/gtk.css", GLib.FileTest.IS_SYMLINK);
            if (exists && !GLib.file_test(dir + "/gtk.css", GLib.FileTest.IS_SYMLINK))
                return;
            if (dark && !exists)       link.make_symbolic_link("gtk.css.dark", null);
            else if (!dark && exists)  link.delete(null);
        } catch (e) {
            log_err("swapping gtk.css", e);
        }
    }

    _initNightLight() {
        this._nightSettings = new Gio.Settings({ schema_id: NIGHT_SCHEMA });
        this._nightTile = new CircleButton(_("Night Light"),
            this._metaPath + "/icons/cc-nightshift-symbolic.svg",
            (want) => this._nightSettings.set_boolean(NIGHT_KEY, want));
        this._nightId = this._nightSettings.connect("changed::" + NIGHT_KEY,
                                                    () => this._syncNightLight());
        this._syncNightLight();
    }

    _syncNightLight() {
        let on = this._nightSettings.get_boolean(NIGHT_KEY);
        this._nightTile.setChecked(on);
        this._nightTile.setSub(on ? _("On") : _("Off"));
    }

    /* ------------------------------------------ Brightness and volume */

    _initSliders() {
        /* xsi- names come from hicolor, which WhiteSur inherits.  The plain
         * display-brightness-symbolic / keyboard-brightness-symbolic that the
         * stock power applet asks for live only in WhiteSur-light and Adwaita
         * respectively, neither of which is in this theme's inheritance chain,
         * so they would render blank here. */
        if (PowerLib && typeof PowerLib.BrightnessSlider === "function") {
            this._brightness = new PowerLib.BrightnessSlider(
                this, _("Brightness"), "xsi-display-brightness",
                "org.cinnamon.SettingsDaemon.Power.Screen", 0);
            this._brightTile = new SliderTile(_("Display"),
                new FatSlider(this._brightness, "xsi-display-brightness-symbolic"));

            /* csd-power answers GetPercentage with 0 and no error even on a
             * machine with no keyboard backlight, so BrightnessSlider shows
             * itself regardless (power@:274).  Gate on the LED actually
             * existing instead, or the grid grows a dead slider. */
            if (hasKeyboardBacklight()) {
                this._keyboardBacklight = new PowerLib.BrightnessSlider(
                    this, _("Keyboard backlight"), "xsi-keyboard-brightness",
                    "org.cinnamon.SettingsDaemon.Power.Keyboard", 0);
                this._kbdTile = new SliderTile(_("Keyboard"),
                    new FatSlider(this._keyboardBacklight, "xsi-keyboard-brightness-symbolic"));
            }
        }

        if (!SoundLib || typeof SoundLib.VolumeSlider !== "function")
            throw new Error("sound module did not provide VolumeSlider");

        this._control = new Cvc.MixerControl({ name: "Cinnamon Control Center" });
        this._volumeNorm = this._control.get_vol_max_norm();
        this._volumeMax = this._volumeNorm;
        this._output = null;
        this._streams = [];

        try {
            this._soundSettings = new Gio.Settings({ schema_id: "org.cinnamon.desktop.sound" });
            this._overampId = this._soundSettings.connect(
                "changed::allow-amplified-volume", () => this._onOveramplificationChange());
            this._onOveramplificationChange();
        } catch (e) {
            log_err("sound settings", e);
        }

        this._outputSlider = new SoundLib.VolumeSlider(this, null, _("Volume"), null);
        /* Apple's AirPlay spot: a small round button opening sound settings. */
        let out = null;
        let soundCmd = firstProgram(["cinnamon-settings sound"]);
        if (soundCmd) {
            out = new St.Button({ style_class: 'cc-mini-round', can_focus: true });
            out.set_child(new St.Icon({ icon_name: "xsi-audio-speakers-symbolic",
                                        icon_type: St.IconType.SYMBOLIC, icon_size: 14 }));
            out.connect('clicked', () => { this.menu.close(); Util.spawnCommandLine(soundCmd); });
            try { new Tooltips.Tooltip(out, _("Sound Settings")); } catch (e) {}
        }
        this._soundTile = new SliderTile(_("Sound"),
            new FatSlider(this._outputSlider, "xsi-audio-volume-high-symbolic", out));

        /* Per-application streams sit under the main slider inside the tile. */
        this._appStreamSection = new PopupMenu.PopupMenuSection();
        this._soundTile.actor.add(this._appStreamSection.actor, { x_fill: true });
        this._streamSections = {};

        this._control.connect("state-changed", () => this._onControlStateChanged());
        this._control.connect("active-output-update", () => this._readOutput());
        this._control.connect("stream-added", (c, id) => this._onStreamAdded(id));
        this._control.connect("stream-removed", (c, id) => this._onStreamRemoved(id));
        this._control.open();

        this.actor.connect("scroll-event", (actor, event) => this._onScroll(actor, event));
    }

    /* ---------------------------------------------------------- Media */

    _initMedia() {
        if (!SoundLib || typeof SoundLib.Player !== "function")
            throw new Error("sound module did not provide Player");

        this._players = {};
        this._playerItems = [];
        this._activePlayer = null;

        this._mediaTile = new St.BoxLayout({ vertical: true, style_class: 'cc-tile' });
        this._playerSection = new PopupMenu.PopupMenuSection();
        this._mediaTile.add(this._playerSection.actor, { x_fill: true });
        this._mediaTile.visible = false;

        Interfaces.getDBusAsync((proxy, error) => {
            if (error) {
                log_err("dbus for MPRIS", error);
                return;
            }
            this._dbus = proxy;
            let re = /^org\.mpris\.MediaPlayer2\./;

            this._dbus.ListNamesRemote((names) => {
                for (let n in names[0]) {
                    let name = names[0][n];
                    if (re.test(name))
                        this._dbus.GetNameOwnerRemote(name,
                            (owner) => this._addPlayer(name, owner[0]));
                }
            });

            this._ownerChangedId = this._dbus.connectSignal("NameOwnerChanged",
                (p, sender, [name, oldOwner, newOwner]) => {
                    if (!re.test(name)) return;
                    if (newOwner && !oldOwner)      this._addPlayer(name, newOwner);
                    else if (oldOwner && !newOwner) this._removePlayer(name, oldOwner);
                    else                            this._changePlayerOwner(name, oldOwner, newOwner);
                });
        });
    }

    _updatePlayerMenuItems() {
        if (!this._mediaTile) return;
        let any = Object.keys(this._players || {}).length > 0;
        this._mediaTile.visible = any && this.showMediaPlayer;
        this._syncNowPlaying();
    }

    _syncNowPlaying() {
        if (!this._nowPlaying) return;
        let p = (this._activePlayer && this._players) ? this._players[this._activePlayer] : null;
        this._nowPlaying.setPlayer(p || null);
    }

    get extendedPlayerControl() { return false; }

    /* --------------------------------------------------------- Battery */

    _initBattery() {
        this._deviceItems = [];

        this._batteryHeader = new BatteryHeader();
        this.batteryMenu.addMenuItem(this._batteryHeader);

        /* Any battery-backed device other than the primary one: mouse,
         * keyboard, headphones. */
        this._batterySection = new PopupMenu.PopupMenuSection();
        this.batteryMenu.addMenuItem(this._batterySection);

        this._profileSection = new PopupMenu.PopupMenuSection();
        this.batteryMenu.addMenuItem(this._profileSection);
        this._initPowerProfiles();

        let powerCmd = firstProgram(["cinnamon-settings power"]);
        if (powerCmd) {
            this.batteryMenu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            /* Plain text, no icon — macOS menu rows carry none. */
            let item = new PopupMenu.PopupMenuItem(_("Battery Settings…"));
            item.connect("activate", () => {
                this.batteryMenu.close();
                Util.spawnCommandLine(powerCmd);
            });
            this.batteryMenu.addMenuItem(item);
        }

        this.aliases = global.settings.get_strv("device-aliases");

        Interfaces.getDBusProxyAsync("org.cinnamon.SettingsDaemon.Power",
                                     (proxy, error) => {
            if (error) {
                log_err("power proxy", error);
                return;
            }
            this._powerProxy = proxy;
            this._powerProxy.connect("g-properties-changed", () => this._devicesChanged());
            this._devicesChanged();
        }, null);
    }

    _devicesChanged() {
        if (!this._powerProxy || !PowerLib) return;

        this._powerProxy.GetDevicesRemote((result, error) => {
            for (let i of this._deviceItems) i.destroy();
            this._deviceItems = [];
            this._batterySection.removeAll();

            this._primaryPercentage = null;
            this._primaryTime = null;
            this._primaryState = null;

            if (error) {
                this._syncPanelBattery();
                return;
            }

            let devices = result[0] || [];
            for (let device of devices) {
                let [device_id, vendor, model, device_kind, icon,
                     percentage, state, battery_level, seconds] = device;

                if (device_kind === UPDeviceKind.LINE_POWER) continue;
                if (state === UPDeviceState.UNKNOWN) continue;

                /* The primary battery is the menu header, not a row. */
                if (device_kind === UPDeviceKind.BATTERY &&
                    this._primaryPercentage === null) {
                    this._primaryPercentage = percentage;
                    this._primaryTime = seconds;
                    this._primaryState = state;
                    continue;
                }

                let status = this._getDeviceStatus(state, seconds);

                let item;
                try {
                    item = new PowerLib.DeviceItem(device, status, this.aliases);
                } catch (e) {
                    log_err("battery row", e);
                    continue;
                }
                this._batterySection.addMenuItem(item);
                this._deviceItems.push(item);
            }

            this._updateBatteryLabel();
            this._syncPanelBattery();
        });
    }

    /* power-profiles-daemon is running here with power-saver / balanced /
     * performance.  Mirrors the proxy power@:393-402 builds. */
    _initPowerProfiles() {
        const IFACE =
            '<node><interface name="net.hadess.PowerProfiles">' +
            '<property name="ActiveProfile" type="s" access="readwrite"/>' +
            '<property name="Profiles" type="aa{sv}" access="read"/>' +
            '</interface></node>';
        try {
            let Proxy = Gio.DBusProxy.makeProxyWrapper(IFACE);
            this._profilesProxy = new Proxy(Gio.DBus.system,
                "net.hadess.PowerProfiles", "/net/hadess/PowerProfiles",
                (proxy, error) => {
                    if (error) {
                        log_err("power profiles proxy", error);
                        return;
                    }
                    this._buildProfileItems();
                    this._profilesProxy.connect("g-properties-changed",
                                                () => this._syncProfiles());
                });
        } catch (e) {
            log_err("power profiles", e);
        }
    }

    _buildProfileItems() {
        let profiles;
        try {
            profiles = this._profilesProxy.Profiles;
        } catch (e) {
            log_err("reading Profiles", e);
            return;
        }
        if (!profiles || !profiles.length) return;

        const NAMES = (PowerLib && PowerLib.POWER_PROFILES) ? PowerLib.POWER_PROFILES : {};

        this._profileSection.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        /* macOS labels this group "Energy Mode"; rows are plain text with a
         * check mark, so no icons here either. */
        this._profileSection.addMenuItem(new PopupMenu.PopupMenuItem(
            _("Energy Mode"), { reactive: false, style_class: 'cc-batt-caption' }));
        this._profileItems = {};

        for (let entry of profiles) {
            let name = unwrap(entry["Profile"]);
            if (!name) continue;
            let item = new PopupMenu.PopupMenuItem(NAMES[name] || name);
            item.connect("activate", () => {
                try {
                    this._profilesProxy.ActiveProfile = name;
                } catch (e) {
                    log_err("setting profile " + name, e);
                }
            });
            this._profileSection.addMenuItem(item);
            this._profileItems[name] = item;
        }
        this._syncProfiles();
    }

    _syncProfiles() {
        if (!this._profileItems) return;
        let active;
        try {
            active = this._profilesProxy.ActiveProfile;
        } catch (e) {
            return;
        }
        for (let name in this._profileItems)
            this._profileItems[name].setShowDot(name === active);
        /* macOS paints the fill yellow in Low Power Mode. */
        if (this._batteryGlyph)
            this._batteryGlyph.setLowPower(active === "power-saver");
    }

    _isOnAC(state) {
        return state === UPDeviceState.CHARGING ||
               state === UPDeviceState.FULLY_CHARGED ||
               state === UPDeviceState.PENDING_CHARGE;
    }

    /* Push the primary battery's state into the panel glyph and the menu
     * header.  No battery at all (a desktop): hide the slot entirely. */
    _syncPanelBattery() {
        let pct = this._primaryPercentage;
        if (pct === null || pct === undefined) {
            this._applet_icon_box.hide();
            return;
        }
        this._applet_icon_box.show();
        this._batteryGlyph.setState(pct, this._isOnAC(this._primaryState));
        if (this._batteryHeader)
            this._batteryHeader.update(pct, this._primaryState, this._primaryTime);
    }

    /* ---------------------------------------------------------- Applet */

    /* Neither the glyph nor the DrawingArea is a base-class _applet_icon, so
     * the base class will not resize them; do it here. */
    on_panel_height_changed() {
        let size = this.getPanelIconSize(St.IconType.SYMBOLIC);
        if (this._ccGlyph) this._ccGlyph.icon_size = size;
        if (this._batteryGlyph) this._batteryGlyph.setSize(size);
    }

    /* Both items own their clicks (hit areas above).  A press that still
     * reaches here landed on the applet's edge padding; opening a menu from
     * it would just be closed again by the release, so do nothing. */
    on_applet_clicked(event) {
    }

    on_applet_removed_from_panel() {
        try {
            Main.keybindingManager.removeHotKey("control-center-open-" + this.instance_id);
        } catch (e) {}

        if (this._bt) {
            this._bt.destroy();
            this._bt = null;
        }

        if (this._nmClient && this._nmSignals) {
            for (let id of this._nmSignals) {
                try { this._nmClient.disconnect(id); } catch (e) {}
            }
            this._nmSignals = null;
        }
        for (let wrapper of (this._wifiDevices || [])) {
            try { wrapper.destroy(); } catch (e) {}
        }
        this._wifiDevices = [];

        for (let t of [this._brightTile, this._kbdTile, this._soundTile]) {
            if (t && t.fat) { try { t.fat.destroy(); } catch (e) {} }
        }

        /* Otherwise every reload leaks a PulseAudio client. */
        if (this._control) {
            try { this._control.close(); } catch (e) {}
            this._control = null;
        }

        if (this._soundSettings && this._overampId) {
            try { this._soundSettings.disconnect(this._overampId); } catch (e) {}
        }
        if (this._dndSettings && this._dndId) {
            try { this._dndSettings.disconnect(this._dndId); } catch (e) {}
        }
        if (this._nightSettings && this._nightId) {
            try { this._nightSettings.disconnect(this._nightId); } catch (e) {}
        }
        if (this._ifaceSettings && this._darkId) {
            try { this._ifaceSettings.disconnect(this._darkId); } catch (e) {}
        }
        if (this._recId && Main.screenRecorder) {
            try { Main.screenRecorder.disconnect(this._recId); } catch (e) {}
        }

        if (this._dbus && this._ownerChangedId) {
            try { this._dbus.disconnectSignal(this._ownerChangedId); } catch (e) {}
        }

        this.settings.finalize();
    }

    _applyWifiHeight() {
        if (!this._wifiScroll) return;
        this._wifiScroll.style = "max-height: " + this.wifiMaxHeight + "px;";
    }
    _readConnections() {
        let connections = this._nmClient.get_connections() || [];
        for (let connection of connections) {
            if (connection._uuid)
                continue;
            connection._updatedId =
                connection.connect("changed", (c) => this._updateConnection(c));
            this._updateConnection(connection);
            this._connections.push(connection);
        }
    }
    _updateConnection(connection) {
        let cs = connection.get_setting_by_name(NM.SETTING_CONNECTION_SETTING_NAME);
        if (!cs) return;

        connection._type = cs.type;
        connection._section = this._ctypes[connection._type] ||
                              NetLib.NMConnectionCategory.INVALID;
        connection._name = cs.id;
        connection._uuid = cs.uuid;
        connection._timestamp = cs.timestamp;

        if (connection._section !== NetLib.NMConnectionCategory.WIRELESS)
            return;

        for (let dev of this._wifiDevices)
            dev.checkConnection(connection);
    }
    _connectionAdded(client, connection) {
        if (connection._uuid) return;
        connection._updatedId =
            connection.connect("changed", (c) => this._updateConnection(c));
        this._updateConnection(connection);
        this._connections.push(connection);
    }
    _connectionRemoved(client, connection) {
        let pos = this._connections.indexOf(connection);
        if (pos !== -1)
            this._connections.splice(pos, 1);

        if (connection._section === NetLib.NMConnectionCategory.WIRELESS) {
            for (let dev of this._wifiDevices)
                dev.removeConnection(connection);
        }

        if (connection._updatedId) {
            connection.disconnect(connection._updatedId);
            connection._updatedId = 0;
        }
        connection._uuid = null;
    }
    _readDevices() {
        let devices = this._nmClient.get_devices() || [];
        for (let d of devices)
            this._deviceAdded(this._nmClient, d);
    }
    _deviceAdded(client, device) {
        if (device._delegate)
            return;
        if (device.get_device_type() !== NM.DeviceType.WIFI)
            return;

        let wrapper = new NetLib.NMDeviceWireless(this._nmClient, device, this._connections);
        wrapper._ccStateChangedId =
            wrapper.connect("state-changed", () => this._syncWifiTitle());
        this._skinWifiSection(wrapper.section);

        this._wifiSection.addMenuItem(wrapper.statusItem);
        this._wifiSection.addMenuItem(wrapper.section);
        this._wifiDevices.push(wrapper);

        this._syncWifiTitle();
    }
    /*
     * macOS rows: a round glyph on the left (white/blue for the connected
     * network, glass otherwise), the SSID, the signal icon on the right.
     *
     * The stock NMDeviceWireless keeps all the NetworkManager logic — AP
     * grouping, saved connections, 802.1x hand-off to cinnamon-settings
     * (network@:1717-1737) — so its NMNetworkMenuItems are re-skinned in
     * place rather than replaced.  Every row enters through
     * section.addMenuItem (network@:1741, and the "More" submenu), which is
     * wrapped here; the stock marks the active network with setShowDot()
     * (network@:1184 and friends), which is redirected to the circle and
     * made exclusive, so two networks can never both look selected.
     */
    _skinWifiSection(section) {
        if (!section || section._ccSkinned) return;
        section._ccSkinned = true;
        let orig = section.addMenuItem.bind(section);
        section.addMenuItem = (item, position) => {
            orig(item, position);
            this._skinWifiItem(item, section);
        };
        for (let it of section._getMenuItems()) this._skinWifiItem(it, section);
    }

    _skinWifiItem(item, section) {
        if (!item || item._ccSkinned) return;
        if (item.menu && typeof item.menu.addMenuItem === "function") {
            /* the "More" overflow submenu */
            item._ccSkinned = true;
            this._skinWifiSection(item.menu);
            return;
        }
        if (!item._labelStrength || !item._icons) return;   /* not a network row */
        item._ccSkinned = true;

        item.actor.add_style_class_name('cc-net-row');

        /* PopupMenu syncs column widths across every item in the menu
         * (popupMenu.js:2628-2635), so a row built from several addActor()
         * columns lines its label up with the title/settings rows instead of
         * its own circle.  Rebuild the row as ONE actor spanning all columns. */
        for (let child of [item._label, item._labelStrength, item._icons]) {
            try { item.removeActor(child); } catch (e) {}
        }
        let circle = new St.Bin({ style_class: 'cc-circle cc-list-circle' });
        circle.set_child(new St.Icon({ icon_name: 'xsi-network-wireless-signal-excellent-symbolic',
                                       icon_type: St.IconType.SYMBOLIC, icon_size: 15 }));
        let box = new St.BoxLayout({ style_class: 'cc-net-box' });
        box.add(circle, { y_align: St.Align.MIDDLE, y_fill: false });
        box.add(item._label, { expand: true, x_fill: true, y_align: St.Align.MIDDLE, y_fill: false });
        box.add(item._icons, { y_align: St.Align.MIDDLE, y_fill: false });
        item.addActor(box, { expand: true, span: -1 });
        item._ccCircle = circle;

        const clearOthers = () => {
            for (let o of section._getMenuItems())
                if (o !== item && o._ccCircle) o._ccCircle.remove_style_class_name('cc-circle-on');
        };
        item.setShowDot = (show) => {
            if (show) { clearOthers(); circle.add_style_class_name('cc-circle-on'); }
            else      circle.remove_style_class_name('cc-circle-on');
        };
        /* the stock may have marked it before it was added to the section */
        if (item._dot) {
            try { item._dot.destroy(); } catch (e) {}
            item._dot = null;
            item.setShowDot(true);
        }
    }

    _deviceRemoved(client, device) {
        if (!device._delegate)
            return;
        let wrapper = device._delegate;
        if (this._wifiDevices.indexOf(wrapper) === -1)
            return;

        if (wrapper._ccStateChangedId) {
            wrapper.disconnect(wrapper._ccStateChangedId);
            wrapper._ccStateChangedId = 0;
        }
        wrapper.destroy();
        this._wifiDevices.splice(this._wifiDevices.indexOf(wrapper), 1);
        this._syncWifiTitle();
    }
    _syncActiveConnections() {
        let newActive = this._nmClient.get_active_connections() || [];

        for (let a of this._activeConnections) {
            if (newActive.indexOf(a) !== -1)
                continue;
            if (a._primaryDevice) {
                try { a._primaryDevice.setActiveConnection(null); } catch (e) {}
                a._primaryDevice = null;
            }
        }

        this._activeConnections = newActive;
        this._mainConnection = null;

        let activated = null, activating = null, defaultIp4 = null;

        for (let a of this._activeConnections) {
            if (!a._type) {
                a._type = a.connection ? a.connection._type : null;
                a._section = this._ctypes[a._type];
            }
            if (!a._section)
                continue;

            if (a.state === NM.ActiveConnectionState.ACTIVATED && !defaultIp4)
                activated = a;
            if (a.state === NM.ActiveConnectionState.ACTIVATING)
                activating = a;
            if (a["default"])
                defaultIp4 = a;

            if (!a._primaryDevice) {
                let devices = a.get_devices() || [];
                for (let d of devices) {
                    if (d._delegate && this._wifiDevices.indexOf(d._delegate) !== -1) {
                        a._primaryDevice = d._delegate;
                        break;
                    }
                }
            }

            if (a._primaryDevice) {
                try { a._primaryDevice.setActiveConnection(a); } catch (e) {}
            }
        }

        this._mainConnection = activated || activating || defaultIp4 || null;
        this._syncWifiTitle();
    }
    _btIconFor(bluezIcon) {
        const map = {
            "phone": "phone",
            "computer": "computer",
            "audio-card": "audio-speakers",
            "audio-headset": "audio-headset",
            "audio-headphones": "audio-headphones",
            "input-mouse": "input-mouse",
            "input-keyboard": "input-keyboard",
            "input-gaming": "input-gaming",
            "camera-photo": "camera-photo",
            "printer": "printer"
        };
        return map[bluezIcon] || "bluetooth";
    }
    _onOveramplificationChange() {
        let amplified = false;
        try {
            amplified = this._soundSettings.get_boolean("allow-amplified-volume");
        } catch (e) {}
        this._volumeMax = amplified ? this._volumeNorm * 1.5 : this._volumeNorm;
        if (this._outputSlider && this._output)
            this._outputSlider.connectWithStream(this._output);
    }
    _onControlStateChanged() {
        if (this._control.get_state() === Cvc.MixerControlState.READY) {
            this._readOutput();
            for (let stream of this._control.get_streams() || [])
                this._onStreamAdded(stream.id);
        }
    }
    _readOutput() {
        this._output = this._control.get_default_sink();
        if (this._outputSlider)
            this._outputSlider.connectWithStream(this._output);
    }
    _onStreamAdded(id) {
        let stream = this._control.lookup_stream_id(id);
        if (!stream || !(stream instanceof Cvc.MixerSinkInput))
            return;
        if (this._streamSections[id])
            return;

        let section = new SoundLib.StreamMenuSection(this, stream);
        this._appStreamSection.addMenuItem(section);
        this._streamSections[id] = section;
    }
    _onStreamRemoved(id) {
        let section = this._streamSections[id];
        if (section) {
            section.destroy();
            delete this._streamSections[id];
        }
    }
    _onScroll(actor, event) {
        if (!this._outputSlider) return Clutter.EVENT_PROPAGATE;
        return this._outputSlider._onScrollEvent(actor, event);
    }
    _notifyVolumeChange(stream) {
        Main.soundManager.play("volume");
    }
    _addPlayer(busName, owner) {
        if (this._players[owner]) {
            this._players[owner].busNames.push(busName);
            return;
        }
        let player;
        try {
            player = new SoundLib.Player(this, busName, owner);
        } catch (e) {
            log_err("creating player " + busName, e);
            return;
        }
        player.busNames = [busName];
        /* sound@'s Player has no change signal; wrap the two setters that
         * every status/metadata update funnels through (sound@:820, :756). */
        for (let fn of ["_setStatus", "_setMetadata"]) {
            if (typeof player[fn] !== "function") continue;
            let orig = player[fn];
            player[fn] = (...args) => {
                let r = orig.apply(player, args);
                try { this._syncNowPlaying(); } catch (e) {}
                return r;
            };
        }
        this._players[owner] = player;
        this._playerSection.addMenuItem(player);
        this._activePlayer = owner;
        this._updatePlayerMenuItems();
    }
    _removePlayer(busName, owner) {
        let player = this._players[owner];
        if (!player) return;

        let idx = player.busNames.indexOf(busName);
        if (idx > -1) player.busNames.splice(idx, 1);
        if (player.busNames.length) return;

        player.destroy();
        delete this._players[owner];

        if (this._activePlayer === owner) {
            let keys = Object.keys(this._players);
            this._activePlayer = keys.length ? keys[0] : null;
        }
        this._updatePlayerMenuItems();
    }
    _changePlayerOwner(busName, oldOwner, newOwner) {
        this._removePlayer(busName, oldOwner);
        this._addPlayer(busName, newOwner);
    }
    passDesktopEntry(entry) {
        /* Only used by the sound applet to hide a player's tray icon. */
    }
    setAppletTextIcon(player, icon) {
        /* The panel icon is deliberately static: at 20px a state-varying icon
         * is noisy, and it keeps us off the stock icon state machines. */
    }
    _getDeviceStatus(state, seconds) {
        let time = Math.round(seconds / 60);
        let minutes = time % 60;
        let hours = Math.floor(time / 60);

        if (state === UPDeviceState.FULLY_CHARGED)
            return _("Fully charged");

        let charging = (state === UPDeviceState.CHARGING);
        if (!charging && state !== UPDeviceState.DISCHARGING)
            return "";

        if (time === 0)
            return charging ? _("Charging") : _("Using battery power");

        if (time < 60) {
            return charging
                ? ngettext("Charging - %d minute until fully charged",
                           "Charging - %d minutes until fully charged",
                           minutes).format(minutes)
                : ngettext("Using battery power - %d minute remaining",
                           "Using battery power - %d minutes remaining",
                           minutes).format(minutes);
        }

        if (minutes === 0) {
            return charging
                ? ngettext("Charging - %d hour until fully charged",
                           "Charging - %d hours until fully charged",
                           hours).format(hours)
                : ngettext("Using battery power - %d hour remaining",
                           "Using battery power - %d hours remaining",
                           hours).format(hours);
        }

        let template = charging
            ? _("Charging - %d %s %d %s until fully charged")
            : _("Using battery power - %d %s %d %s remaining");
        return template.format(hours, ngettext("hour", "hours", hours),
                               minutes, ngettext("minute", "minutes", minutes));
    }
    _updateBatteryLabel() {
        if (this._primaryPercentage === null ||
            this._primaryPercentage === undefined ||
            this.labelinfo === "nothing") {
            this.set_applet_label("");
            return;
        }

        let pct = Math.round(this._primaryPercentage) + "%";
        let time = "";
        if (this._primaryTime > 0) {
            let mins = Math.round(this._primaryTime / 60);
            let hours = Math.floor(mins / 60);
            mins = mins % 60;
            time = hours > 0 ? "%d:%02d".format(hours, mins) : "%dm".format(mins);
        }

        switch (this.labelinfo) {
            case "time":            this.set_applet_label(time); break;
            case "percentage_time": this.set_applet_label(time ? pct + " " + time : pct); break;
            default:                this.set_applet_label(pct);
        }
    }
    _setKeybinding() {
        Main.keybindingManager.addHotKey("control-center-open-" + this.instance_id,
                                         this.keyOpen,
                                         () => this._toggleExclusive(this.menu));
    }
}

function main(metadata, orientation, panel_height, instance_id) {
    return new ControlCenterApplet(metadata, orientation, panel_height, instance_id);
}
