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

const MENU_WIDTH = 340;          /* logical px, before ui_scale */

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
        this.actor.add(this._title);
        this.actor.add(this._sub);
    }
    setTitle(t) { this._title.text = t; }
    setSub(t) {
        this._sub.text = t || '';
        this._sub.visible = !!t;
    }
}

/* One row of the connectivity tile: round toggle on the left, clickable
 * label on the right that opens the detail page. */
class ConnRow {
    constructor(title, iconName, onToggle, onOpenDetail) {
        this.actor = new St.BoxLayout({ style_class: 'cc-conn-row' });

        this.toggle = new CircleToggle(iconName, onToggle);
        this.actor.add(this.toggle.actor, { y_align: St.Align.MIDDLE, y_fill: false });

        this.labels = new TileLabelPair(title, '');
        this._btn = new St.Button({ style_class: 'cc-conn-label', can_focus: true });
        this._btn.set_child(this.labels.actor);
        this._btn.connect('clicked', onOpenDetail);
        this.actor.add(this._btn, { expand: true, x_fill: true,
                                    y_align: St.Align.MIDDLE, y_fill: false });
    }
    setChecked(on) { this.toggle.setChecked(on); }
    setIcon(n)     { this.toggle.setIcon(n); }
    setSub(t)      { this.labels.setSub(t); }
}

/* A square grid tile that is one big toggle button (DND, Night Light). */
class ToggleTile {
    constructor(title, iconName, onToggle) {
        this.actor = new St.Button({ style_class: 'cc-tile cc-tile-square',
                                     can_focus: true });
        let box = new St.BoxLayout({ vertical: true, style_class: 'cc-square-box' });

        this._circle = new St.Bin({ style_class: 'cc-circle' });
        this._icon = new St.Icon({ icon_name: iconName,
                                   icon_type: St.IconType.SYMBOLIC,
                                   icon_size: 17 });
        this._circle.set_child(this._icon);
        box.add(this._circle, { x_align: St.Align.MIDDLE, x_fill: false });

        this._title = new St.Label({ text: title, style_class: 'cc-tile-title' });
        this._sub   = new St.Label({ text: '', style_class: 'cc-tile-sub' });
        box.add(this._title, { x_align: St.Align.MIDDLE, x_fill: false });
        box.add(this._sub,   { x_align: St.Align.MIDDLE, x_fill: false });

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
    setSub(t)  { this._sub.text = t || ''; }
}

/*
 * A fat macOS pill slider with the icon sitting inside the groove.
 *
 * The stock VolumeSlider / BrightnessSlider cannot do this themselves: their
 * PopupBaseMenuItem container lays children out strictly side by side with no
 * z-stacking (popupMenu.js:348-410).  But everything those classes need after
 * construction hangs off `_slider` and `icon`, not off `actor`
 * (popupMenu.js:670-675, :779-781, :825-828), and removeActor() is a clean
 * unparent with no destroy (popupMenu.js:246-249).  So the two children are
 * lifted out and re-hosted in a BinLayout, the same overlay trick the sound
 * applet uses for cover art (sound@:557-591).
 *
 * The pill shape is free: sliderBorderRadius = min(width, sliderHeight)/2
 * (popupMenu.js:703), so a 26px -slider-height rounds to a 13px radius.
 */
class FatSlider {
    constructor(item) {
        this.item = item;

        try { item.removeActor(item.icon); }    catch (e) {}
        try { item.removeActor(item._slider); } catch (e) {}

        this.actor = new St.Widget({
            style_class: 'cc-fatslider',
            layout_manager: new Clutter.BinLayout(),
            x_expand: true
        });
        this.actor._delegate = null;

        /* groove first => bottom of the z-stack */
        item._slider.add_style_class_name('cc-fat-groove');
        item._slider.x_expand = true;
        item._slider.y_expand = true;
        this.actor.add_child(item._slider);

        /* St.Bin does the START/MIDDLE placement itself, so this does not rely
         * on BinLayout honouring per-child alignment. */
        this._iconBin = new St.Bin({ style_class: 'cc-fatslider-iconbin',
                                     x_align: St.Align.START,
                                     y_align: St.Align.MIDDLE });
        /* The bin must not eat events, but the icon itself stays reactive for
         * the volume slider — that is its click-to-mute target (sound@:110-119). */
        this._iconBin.reactive = false;
        this._iconBin.set_child(item.icon);
        this.actor.add_child(this._iconBin);

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
         * a null stream (sound@:129).  Without this a machine with no keyboard
         * backlight would still show the tile. */
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
        this.actor = new St.BoxLayout({ vertical: true, style_class: 'cc-tile' });
        this.actor.add(new St.Label({ text: title, style_class: 'cc-tile-title' }));
        this.actor.add(fatSlider.actor, { expand: true, x_fill: true });
        this.fat = fatSlider;
        /* follow the slider's own visibility up to the whole tile */
        fatSlider.actor.connect('notify::visible',
            () => { this.actor.visible = fatSlider.actor.visible; });
        this.actor.visible = fatSlider.actor.visible;
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
        content.natural_width = this._w;
        sec.addActor(content);          /* popupMenu.js:2099 takes one arg only */
        this.menu.addMenuItem(sec);
        this._pages[name] = sec;
        return sec;
    }

    addMenuPage(name, titleText, onBack) {
        let sec = new PopupMenu.PopupMenuSection();
        sec.actor.add_style_class_name('cc-page');
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
    pinWidth(w) {
        for (let k in this._pages) {
            this._pages[k].actor.min_width = w;
            this._pages[k].actor.natural_width = w;
        }
    }

    reset() { this.show('grid'); }
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

        this._uuid = metadata.uuid;
        this._metaPath = metadata.path;
        this.panel_icon_name = null;
        /* The battery slot stays empty until csd-power answers. */
        this._applet_icon_box.hide();

        this.settings = new Settings.AppletSettings(this, metadata.uuid, instance_id);
        this.settings.bind("labelinfo", "labelinfo", () => this._updateBatteryLabel());
        this.settings.bind("wifiListMode", "wifiListMode");
        this.settings.bind("wifiMaxHeight", "wifiMaxHeight", () => this._applyWifiHeight());
        this.settings.bind("btSettingsCmd", "btSettingsCmd");
        this.settings.bind("showMediaPlayer", "showMediaPlayer",
                           () => this._updatePlayerMenuItems());

        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menu = new Applet.AppletPopupMenu(this, orientation);
        this.menuManager.addMenu(this.menu);
        this.menu.actor.add_style_class_name("control-center-menu");

        /* The macOS Control Center glyph, appended after [icon][label] so the
         * panel reads  [battery][74%] [glyph]  (applet.js:144, :694, :827).
         * Loaded as a GFileIcon rather than by name: same route as
         * set_applet_icon_symbolic_path (applet.js:749-762), which sidesteps
         * icon-theme cache timing entirely. */
        try {
            this._ccGlyph = new St.Icon({
                style_class: 'system-status-icon cc-panel-glyph',
                icon_type: St.IconType.SYMBOLIC,
                icon_size: this.getPanelIconSize(St.IconType.SYMBOLIC),
                gicon: new Gio.FileIcon({
                    file: Gio.file_new_for_path(
                        this._metaPath + "/icons/cc-controls-symbolic.svg") })
            });
            this.actor.add(this._ccGlyph, { y_align: St.Align.MIDDLE, y_fill: false });
        } catch (e) {
            log_err("control center glyph", e);
        }

        /* macOS keeps battery and Control Center as separate menu bar items.
         * One applet, two menus, two click targets: the battery icon/label
         * opens the battery menu, the glyph opens the Control Center. */
        this.batteryMenu = new Applet.AppletPopupMenu(this, orientation);
        this.menuManager.addMenu(this.batteryMenu);
        this.batteryMenu.actor.add_style_class_name("control-center-menu");
        this.batteryMenu.actor.add_style_class_name("cc-battery-menu");

        this._applet_icon_box.reactive = true;
        this._applet_icon_box.connect('button-press-event',
            () => { this.batteryMenu.toggle(); return Clutter.EVENT_STOP; });
        this._layoutBin.reactive = true;
        this._layoutBin.connect('button-press-event',
            () => { this.batteryMenu.toggle(); return Clutter.EVENT_STOP; });

        this._pages = new PageStack(this.menu, MENU_WIDTH);

        this._grid = new St.Table({ style_class: 'cc-grid', homogeneous: false });
        this._grid._delegate = null;      /* keep it out of the column sync */
        this._pages.addRawPage('grid', this._grid);

        this._wifiPage = this._pages.addMenuPage('wifi', _("Wi-Fi"),
                                                 () => this._pages.reset());
        this._btPage   = this._pages.addMenuPage('bt', _("Bluetooth"),
                                                 () => this._pages.reset());

        /* Wi-Fi and Bluetooth share one tall connectivity tile. */
        this._connTile = new St.BoxLayout({ vertical: true, style_class: 'cc-tile' });

        this._tile("wifi",       () => this._initWifi());
        this._tile("bluetooth",  () => this._initBluetooth());
        this._tile("dnd",        () => this._initDnd());
        this._tile("nightlight", () => this._initNightLight());
        this._tile("sliders",    () => this._initSliders());
        this._tile("media",      () => this._initMedia());
        this._tile("battery",    () => this._initBattery());

        this._assembleGrid();
        this._pages.show('grid');

        this.menu.connect('open-state-changed', (m, open) => {
            if (open) this._pinPageWidths();
            else      this._pages.reset();
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

    _pinPageWidths() {
        if (this._widthPinned || !this._grid) return;
        let [minW, natW] = this._grid.get_preferred_width(-1);
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

        g.add(this._connTile, { row: 0, col: 0, row_span: 2,
                                x_expand: true, y_expand: false,
                                x_fill: true, y_fill: true });

        if (this._dndTile)
            g.add(this._dndTile.actor, { row: 0, col: 1,
                                         x_expand: false, y_expand: false,
                                         x_fill: true, y_fill: true });
        if (this._nightTile)
            g.add(this._nightTile.actor, { row: 0, col: 2,
                                           x_expand: false, y_expand: false,
                                           x_fill: true, y_fill: true });

        let row = 2;
        const wide = (actor, canHide) => {
            g.add(actor, { row: row, col: 0, col_span: 3,
                           x_expand: true, y_expand: false,
                           x_fill: true, y_fill: false });
            if (canHide) g.child_set(actor, { allocate_hidden: false });
            row++;
        };

        if (this._brightTile) wide(this._brightTile.actor, true);
        if (this._kbdTile)    wide(this._kbdTile.actor, true);
        if (this._soundTile)  wide(this._soundTile.actor, true);
        if (this._slidersFailed) wide(this._failTile(_("Sliders unavailable")), false);
        if (this._mediaTile)  wide(this._mediaTile, true);
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
        this._connTile.add(this._wifiRow.actor, { x_fill: true });

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
            let item = new PopupMenu.PopupIconMenuItem(
                _("Network Settings…"), "preferences-system-network",
                St.IconType.SYMBOLIC);
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
        this._connTile.add(this._btRow.actor, { x_fill: true });

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
            let item = new PopupMenu.PopupIconMenuItem(
                _("Bluetooth Settings…"), "xsi-bluetooth-symbolic",
                St.IconType.SYMBOLIC);
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

        for (let dev of this._bt.devices) {
            let label = dev.alias;
            if (dev.battery !== null && dev.battery !== undefined)
                label += " — " + Math.round(dev.battery) + "%";

            let row = new PopupMenu.PopupSwitchIconMenuItem(
                label, dev.connected, this._btIconFor(dev.icon),
                St.IconType.SYMBOLIC);
            row.setStatus(dev.connected ? _("Connected") : null);
            if (this._bt.isPending(dev.path)) row.setSensitive(false);
            row.connect("toggled", (item, state) => {
                item.setSensitive(false);
                this._bt.setDeviceConnected(dev.path, state);
            });
            this._btDeviceSection.addMenuItem(row);
            this._btRows.push(row);
        }
    }

    /* ------------------------------------------- Do Not Disturb / Night Light */

    _initDnd() {
        this._dndSettings = new Gio.Settings({ schema_id: DND_SCHEMA });
        this._dndTile = new ToggleTile(_("Do Not Disturb"),
            "xsi-notifications-disabled-symbolic",
            /* Inverted: DND on means notifications off. */
            (wantDnd) => this._dndSettings.set_boolean(DND_KEY, !wantDnd));
        this._dndId = this._dndSettings.connect("changed::" + DND_KEY,
                                                () => this._syncDnd());
        this._syncDnd();
    }

    _syncDnd() {
        let dnd = !this._dndSettings.get_boolean(DND_KEY);
        this._dndTile.setChecked(dnd);
        this._dndTile.setIcon(dnd ? "xsi-notifications-disabled-symbolic"
                                  : "xsi-notifications-symbolic");
        this._dndTile.setSub(dnd ? _("On") : _("Off"));
    }

    _initNightLight() {
        this._nightSettings = new Gio.Settings({ schema_id: NIGHT_SCHEMA });
        this._nightTile = new ToggleTile(_("Night Light"),
            "xsi-night-light-symbolic",
            (want) => this._nightSettings.set_boolean(NIGHT_KEY, want));
        this._nightId = this._nightSettings.connect("changed::" + NIGHT_KEY,
                                                    () => this._syncNightLight());
        this._syncNightLight();
    }

    _syncNightLight() {
        let on = this._nightSettings.get_boolean(NIGHT_KEY);
        this._nightTile.setChecked(on);
        this._nightTile.setIcon(on ? "xsi-night-light-symbolic"
                                   : "xsi-night-light-disabled-symbolic");
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
                                              new FatSlider(this._brightness));

            /* csd-power answers GetPercentage with 0 and no error even on a
             * machine with no keyboard backlight, so BrightnessSlider shows
             * itself regardless (power@:274).  Gate on the LED actually
             * existing instead, or the grid grows a dead slider. */
            if (hasKeyboardBacklight()) {
                this._keyboardBacklight = new PowerLib.BrightnessSlider(
                    this, _("Keyboard backlight"), "xsi-keyboard-brightness",
                    "org.cinnamon.SettingsDaemon.Power.Keyboard", 0);
                this._kbdTile = new SliderTile(_("Keyboard"),
                                               new FatSlider(this._keyboardBacklight));
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
        this._soundTile = new SliderTile(_("Sound"), new FatSlider(this._outputSlider));

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
    }

    get extendedPlayerControl() { return false; }

    /* --------------------------------------------------------- Battery */

    _initBattery() {
        this._deviceItems = [];
        this._primaryIcon = null;

        this._batterySection = new PopupMenu.PopupMenuSection();
        this.batteryMenu.addMenuItem(this._batterySection);

        this._profileSection = new PopupMenu.PopupMenuSection();
        this.batteryMenu.addMenuItem(this._profileSection);
        this._initPowerProfiles();

        let powerCmd = firstProgram(["cinnamon-settings power"]);
        if (powerCmd) {
            this.batteryMenu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            let item = new PopupMenu.PopupIconMenuItem(
                _("Battery Settings…"), "xsi-battery-level-100-symbolic",
                St.IconType.SYMBOLIC);
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
            this._primaryIcon = null;

            if (error) return;

            let devices = result[0] || [];
            for (let device of devices) {
                let [device_id, vendor, model, device_kind, icon,
                     percentage, state, battery_level, seconds] = device;

                if (device_kind === UPDeviceKind.LINE_POWER) continue;
                if (state === UPDeviceState.UNKNOWN) continue;

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

                if (device_kind === UPDeviceKind.BATTERY &&
                    this._primaryPercentage === null) {
                    this._primaryPercentage = percentage;
                    this._primaryTime = seconds;
                    this._primaryIcon = icon;
                }
            }

            this._updateBatteryLabel();
            this._setPanelBatteryIcon(this._primaryIcon);
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

        const ICONS = {
            "power-saver": "xsi-power-profile-power-saver-symbolic",
            "balanced":    "xsi-power-profile-balanced-symbolic",
            "performance": "xsi-power-profile-performance-symbolic"
        };
        const NAMES = (PowerLib && PowerLib.POWER_PROFILES) ? PowerLib.POWER_PROFILES : {};

        this._profileSection.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._profileItems = {};

        for (let entry of profiles) {
            let name = unwrap(entry["Profile"]);
            if (!name) continue;
            let item = new PopupMenu.PopupIconMenuItem(
                NAMES[name] || name,
                ICONS[name] || "xsi-power-profile-balanced-symbolic",
                St.IconType.SYMBOLIC);
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
    }

    /*
     * Transcribed from power@:604-618.  The order is load-bearing:
     * set_applet_icon_symbolic_name() forces St.IconType.SYMBOLIC and the
     * correct panel icon size via _setStyle(), and only then is the gicon
     * overwritten with the themed-icon string UPower supplied (currently
     * "xsi-battery-level-70-symbolic ...").  Assigning .gicon alone does not
     * re-run _setStyle().
     */
    _setPanelBatteryIcon(icon) {
        if (!icon) {
            this._applet_icon_box.hide();
            this.panel_icon_name = null;
            return;
        }
        this._applet_icon_box.show();
        if (this.panel_icon_name !== icon) {
            this.panel_icon_name = icon;
            this.set_applet_icon_symbolic_name('xsi-battery-level-100');
            this._applet_icon.gicon = Gio.icon_new_for_string(icon);
        }
    }

    /* ---------------------------------------------------------- Applet */

    /* _setStyle() resizes _applet_icon but knows nothing about our glyph, and
     * it can clobber the battery gicon, so both are re-applied here. */
    on_panel_height_changed() {
        if (this._ccGlyph)
            this._ccGlyph.icon_size = this.getPanelIconSize(St.IconType.SYMBOLIC);
        if (this.panel_icon_name && this._applet_icon)
            this._applet_icon.gicon = Gio.icon_new_for_string(this.panel_icon_name);
    }

    on_applet_clicked(event) {
        this.menu.toggle();
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

        this._wifiSection.addMenuItem(wrapper.statusItem);
        this._wifiSection.addMenuItem(wrapper.section);
        this._wifiDevices.push(wrapper);

        this._syncWifiTitle();
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
                                         this.keyOpen, () => this.menu.toggle());
    }
}

function main(metadata, orientation, panel_height, instance_id) {
    return new ControlCenterApplet(metadata, orientation, panel_height, instance_id);
}
