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

/* ------------------------------------------------------------------------ */

class ControlCenterApplet extends Applet.TextIconApplet {
    constructor(metadata, orientation, panel_height, instance_id) {
        super(orientation, panel_height, instance_id);

        this.setAllowedLayout(Applet.AllowedLayout.BOTH);
        this.set_applet_icon_symbolic_name("preferences-system");
        this.set_applet_tooltip(_("Control Center"));
        this.set_show_label_in_vertical_panels(false);
        this.set_applet_label("");

        this._uuid = metadata.uuid;
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

        /* BlurCinnamon can only blur what the theme does not paint over, and
         * WhiteSur-Dark-solid draws .popup-menu with an opaque border-image.
         * The stylesheet clears it for this class only. */
        this.menu.actor.add_style_class_name("control-center-menu");

        this._sections = {};

        this._buildSection("wifi",      (c) => this._initWifi(c));
        this._buildSection("bluetooth", (c) => this._initBluetooth(c));
        this._buildSection("sliders",   (c) => this._initSliders(c));
        this._buildSection("media",     (c) => this._initMedia(c));
        this._buildSection("battery",   (c) => this._initBattery(c));

        try {
            this.settings.bind("keyOpen", "keyOpen", () => this._setKeybinding());
            this._setKeybinding();
        } catch (e) {
            log_err("keybinding", e);
        }

        /* blueman keeps running (it is the pairing agent) but its tray icon is
         * redundant now that Bluetooth lives in here. */
        try {
            Main.systrayManager.registerTrayIconReplacement("blueman", this._uuid);
            Main.systrayManager.registerTrayIconReplacement("bluetooth", this._uuid);
        } catch (e) {
            log_err("systray replacement", e);
        }
    }

    /* Each section is independent: one broken section must not cost the user
     * their volume, Wi-Fi and battery indicators all at once. */
    _buildSection(name, fn) {
        let card = new PopupMenu.PopupMenuSection();
        card.actor.add_style_class_name("control-center-card");
        this.menu.addMenuItem(card);
        this._sections[name] = card;

        try {
            fn.call(this, card);
        } catch (e) {
            log_err("section '" + name + "' failed to build", e);
            card.removeAll();
            let item = new PopupMenu.PopupIconMenuItem(
                _("%s unavailable").format(name), "dialog-warning",
                St.IconType.SYMBOLIC);
            item.connect("activate", () => Util.spawnCommandLine("cinnamon-settings"));
            card.addMenuItem(item);
        }
    }

    _card(name) {
        return this._sections[name];
    }

    /* -------------------------------------------------------------- Wi-Fi */

    _initWifi(card) {
        if (!NetLib || typeof NetLib.NMDeviceWireless !== "function")
            throw new Error("network module did not provide NMDeviceWireless");

        this._nmClient = NM.Client.new(null);

        this._connections = [];
        this._activeConnections = [];
        this._wifiDevices = [];
        this._mainConnection = null;

        this._ctypes = {};
        this._ctypes[NM.SETTING_WIRELESS_SETTING_NAME] = NetLib.NMConnectionCategory.WIRELESS;

        this._wifiSwitch = new NetLib.NMWirelessSectionTitleMenuItem(
            this._nmClient, "wireless", _("Wi-Fi"));
        card.addMenuItem(this._wifiSwitch);

        this._wifiSection = new PopupMenu.PopupMenuSection();
        card.addMenuItem(this._wifiSection);

        /* A long SSID list would clip, not scroll: menu.box is a plain
         * BoxLayout.  Wrap it so it scrolls instead. */
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
            card.addMenuItem(item);
        }

        /* Order matters: NMDevice._init silently drops connections that have
         * not been annotated with _uuid/_name yet (network:329-338), so
         * connections must be read before devices. */
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
                                   () => this._syncActiveConnections())
        ];
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

    /* With one adapter the section-title switch stands in for the device's own
     * switch; with several, each device shows its own (network:2030-2052). */
    _syncWifiTitle() {
        let devices = this._wifiDevices;

        if (devices.length === 0) {
            this._wifiSwitch.actor.hide();
            if (this._wifiScroll) this._wifiScroll.hide();
            return;
        }

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
    }

    /* Wi-Fi-only cut of network:2138 — no VPN, wireguard, wwan or wired. */
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

    /* ---------------------------------------------------------- Bluetooth */

    _initBluetooth(card) {
        this._btSwitch = new PopupMenu.PopupSwitchMenuItem(_("Bluetooth"), false,
            { style_class: "popup-subtitle-menu-item" });
        this._btSwitch.connect("toggled", (item, state) => {
            this._bt.setPowered(state);
        });
        card.addMenuItem(this._btSwitch);

        this._btDeviceSection = new PopupMenu.PopupMenuSection();
        card.addMenuItem(this._btDeviceSection);

        let btCmd = this.btSettingsCmd && this.btSettingsCmd.length
            ? this.btSettingsCmd
            : firstProgram(["blueberry", "blueman-manager",
                            "gnome-control-center bluetooth"]);
        if (btCmd) {
            this._btSettingsItem = new PopupMenu.PopupIconMenuItem(
                _("Bluetooth Settings…"), "bluetooth", St.IconType.SYMBOLIC);
            this._btSettingsItem.connect("activate", () => {
                this.menu.close();
                Util.spawnCommandLine(btCmd);
            });
            card.addMenuItem(this._btSettingsItem);
        }

        this._btRows = [];
        this._bt = new BluetoothManager(() => this._syncBluetooth());
    }

    _syncBluetooth() {
        if (!this._btSwitch) return;

        let card = this._card("bluetooth");

        if (!this._bt.available) {
            if (card) card.actor.hide();
            return;
        }
        if (card) card.actor.show();

        this._btSwitch.setToggleState(this._bt.powered);

        for (let row of this._btRows)
            row.destroy();
        this._btRows = [];
        this._btDeviceSection.removeAll();

        if (!this._bt.powered)
            return;

        for (let dev of this._bt.devices) {
            let label = dev.alias;
            if (dev.battery !== null && dev.battery !== undefined)
                label += " — " + Math.round(dev.battery) + "%";

            let row = new PopupMenu.PopupSwitchIconMenuItem(
                label, dev.connected, this._btIconFor(dev.icon),
                St.IconType.SYMBOLIC);
            row.setStatus(dev.connected ? _("Connected") : null);

            if (this._bt.isPending(dev.path))
                row.setSensitive(false);

            row.connect("toggled", (item, state) => {
                item.setSensitive(false);
                this._bt.setDeviceConnected(dev.path, state);
            });

            this._btDeviceSection.addMenuItem(row);
            this._btRows.push(row);
        }
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

    /* ------------------------------------------ Brightness and volume */

    _initSliders(card) {
        /* Brightness first: BrightnessSlider only ever touches
         * this._applet.menu (power:277), so we are a valid applet for it. */
        if (PowerLib && typeof PowerLib.BrightnessSlider === "function") {
            this._brightness = new PowerLib.BrightnessSlider(
                this, _("Brightness"), "display-brightness",
                "org.cinnamon.SettingsDaemon.Power.Screen", 0);
            card.addMenuItem(this._brightness);

            this._keyboardBacklight = new PowerLib.BrightnessSlider(
                this, _("Keyboard backlight"), "keyboard-brightness",
                "org.cinnamon.SettingsDaemon.Power.Keyboard", 0);
            card.addMenuItem(this._keyboardBacklight);
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
        card.addMenuItem(this._outputSlider);

        this._appStreamSection = new PopupMenu.PopupMenuSection();
        card.addMenuItem(this._appStreamSection);
        this._streamSections = {};

        this._control.connect("state-changed", () => this._onControlStateChanged());
        this._control.connect("active-output-update", () => this._readOutput());
        this._control.connect("stream-added", (c, id) => this._onStreamAdded(id));
        this._control.connect("stream-removed", (c, id) => this._onStreamRemoved(id));
        this._control.open();

        /* Scrolling the panel icon adjusts volume, as the sound applet does. */
        this.actor.connect("scroll-event", (actor, event) => this._onScroll(actor, event));
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

    /* Required by the reused VolumeSlider (sound:171,176). */
    _notifyVolumeChange(stream) {
        Main.soundManager.play("volume");
    }

    /* ---------------------------------------------------------- Media */

    _initMedia(card) {
        if (!SoundLib || typeof SoundLib.Player !== "function")
            throw new Error("sound module did not provide Player");

        this._players = {};
        this._playerItems = [];
        this._activePlayer = null;
        this._playerSection = new PopupMenu.PopupMenuSection();
        card.addMenuItem(this._playerSection);

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
                    if (newOwner && !oldOwner)
                        this._addPlayer(name, newOwner);
                    else if (oldOwner && !newOwner)
                        this._removePlayer(name, oldOwner);
                    else
                        this._changePlayerOwner(name, oldOwner, newOwner);
                });
        });
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

    /* --- the small contract the reused Player expects of its applet --- */

    _updatePlayerMenuItems() {
        let any = Object.keys(this._players).length > 0;
        let show = any && this.showMediaPlayer;
        let card = this._card("media");
        if (card) card.actor.visible = show;
    }

    passDesktopEntry(entry) {
        /* Only used by the sound applet to hide a player's tray icon. */
    }

    setAppletTextIcon(player, icon) {
        /* The panel icon is deliberately static: at 20px a state-varying icon
         * is noisy, and it keeps us off the stock icon state machines. */
    }

    get extendedPlayerControl() {
        return false;
    }

    /* --------------------------------------------------------- Battery */

    _initBattery(card) {
        this._deviceItems = [];
        this._batterySection = new PopupMenu.PopupMenuSection();
        card.addMenuItem(this._batterySection);

        let powerCmd = firstProgram(["cinnamon-settings power"]);
        if (powerCmd) {
            let item = new PopupMenu.PopupIconMenuItem(
                _("Power Settings…"), "preferences-system-power",
                St.IconType.SYMBOLIC);
            item.connect("activate", () => {
                this.menu.close();
                Util.spawnCommandLine(powerCmd);
            });
            card.addMenuItem(item);
        }

        this.aliases = global.settings.get_strv("device-aliases");

        Interfaces.getDBusProxyAsync("org.cinnamon.SettingsDaemon.Power",
                                     (proxy, error) => {
            if (error) {
                log_err("power proxy", error);
                return;
            }
            this._powerProxy = proxy;
            this._powerProxy.connect("g-properties-changed",
                                     () => this._devicesChanged());
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
                }
            }

            let card = this._card("battery");
            if (card) card.actor.visible = this._deviceItems.length > 0;

            this._updateBatteryLabel();
        });
    }

    /* power@cinnamon.org keeps this on its applet class rather than exporting
     * it, so it is reimplemented here.  The string IDs are kept identical so
     * they still resolve in the "cinnamon" textdomain. */
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

    /* ---------------------------------------------------------- Applet */

    _setKeybinding() {
        Main.keybindingManager.addHotKey("control-center-open-" + this.instance_id,
                                         this.keyOpen, () => this.menu.toggle());
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

        /* Without this, reloading the applet leaks a PulseAudio client each
         * time (visible in `pactl list clients`). */
        if (this._control) {
            try { this._control.close(); } catch (e) {}
            this._control = null;
        }

        if (this._soundSettings && this._overampId) {
            try { this._soundSettings.disconnect(this._overampId); } catch (e) {}
        }

        if (this._dbus && this._ownerChangedId) {
            try { this._dbus.disconnectSignal(this._ownerChangedId); } catch (e) {}
        }

        this.settings.finalize();
    }
}

function main(metadata, orientation, panel_height, instance_id) {
    return new ControlCenterApplet(metadata, orientation, panel_height, instance_id);
}
