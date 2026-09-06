/*
 * Apple Menu — the  menu at the far left of a macOS menu bar, for Cinnamon.
 *
 * Replaces menu@cinnamon.org (the Mint application menu; Launchpad, Spotlight
 * and the dock cover app launching on this desktop).  Every entry maps to the
 * Mint tool that does the same job:
 *
 *   About This Mac    tools/about-this-mac.py (GTK window, macOS layout)
 *   System Settings…  cinnamon-settings
 *   App Store…        mintinstall
 *   Recent Items      GTK recent documents (Cinnamon's DocManager)
 *   Force Quit…       in-shell dialog listing running apps, Meta.Window.kill()
 *   Sleep             systemctl suspend
 *   Restart… / Shut Down… / Log Out…   cinnamon-session-quit
 *   Lock Screen       cinnamon-screensaver-command --lock
 *
 * The panel glyph is icons/apple-symbolic.svg, a full-resolution vector, drawn
 * through GTK's symbolic loader so it takes the panel's text colour.
 */

const Applet      = imports.ui.applet;
const Cinnamon    = imports.gi.Cinnamon;
const Clutter     = imports.gi.Clutter;
const DocInfo     = imports.misc.docInfo;
const Gio         = imports.gi.Gio;
const GLib        = imports.gi.GLib;
const GObject     = imports.gi.GObject;
const Gtk         = imports.gi.Gtk;
const Main        = imports.ui.main;
const ModalDialog = imports.ui.modalDialog;
const PopupMenu   = imports.ui.popupMenu;
const St          = imports.gi.St;
const Util        = imports.misc.util;

const UUID         = "apple-menu@jiya21";
const IFACE_SCHEMA = "org.cinnamon.desktop.interface";
const KEYS_SCHEMA  = "org.cinnamon.desktop.keybindings.media-keys";
const RECENT_MAX   = 10;

function log_err(where, e) {
    global.logError("[" + UUID + "] " + where + ": " + e);
}

function settingsIfPresent(schemaId) {
    let src = Gio.SettingsSchemaSource.get_default();
    if (!src || !src.lookup(schemaId, true)) return null;
    return new Gio.Settings({ schema_id: schemaId });
}

/* "<Control><Alt>l" -> "⌃⌥L", in macOS modifier order (⌃ ⌥ ⇧ ⌘). */
const MOD_GLYPH = { Control: "⌃", Primary: "⌃", Alt: "⌥", Shift: "⇧",
                    Super: "⌘", Mod4: "⌘" };
const MOD_ORDER = ["⌃", "⌥", "⇧", "⌘"];
const KEY_GLYPH = { Delete: "⌦", BackSpace: "⌫", Escape: "⎋", Return: "↩",
                    Tab: "⇥", space: "Space", Up: "↑", Down: "↓",
                    Left: "←", Right: "→", End: "End", Home: "Home" };

function keyHint(settings, key) {
    if (!settings) return "";
    let binding;
    try { binding = settings.get_strv(key)[0] || ""; } catch (e) { return ""; }
    if (!binding) return "";
    let mods = [];
    let rest = binding.replace(/<(\w+)>/g, (m, mod) => {
        if (MOD_GLYPH[mod]) mods.push(MOD_GLYPH[mod]);
        return "";
    });
    mods.sort((a, b) => MOD_ORDER.indexOf(a) - MOD_ORDER.indexOf(b));
    let k = KEY_GLYPH[rest] || (rest.length === 1 ? rest.toUpperCase() : rest);
    return mods.join("") + k;
}

/* One menu row: [icon] label ........ hint.  Built as a single actor spanning
 * every column so PopupBaseMenuItem's cross-row column sync cannot shift the
 * labels of rows that have an icon or a hint against those that do not. */
class AppleMenuItem extends PopupMenu.PopupBaseMenuItem {
    constructor(text, params) {
        super();
        params = params || {};
        this._box = new St.BoxLayout({ style_class: 'am-row' });
        if (params.icon) {
            this._box.add(params.icon, { y_align: St.Align.MIDDLE, y_fill: false });
        }
        this.label = new St.Label({ text: text, style_class: 'am-label',
                                    y_align: Clutter.ActorAlign.CENTER });
        this.label.clutter_text.ellipsize = 3; /* Pango.EllipsizeMode.END */
        this._box.add(this.label, { expand: true, x_fill: true, y_fill: false,
                                    y_align: St.Align.MIDDLE });
        if (params.hint) {
            this._hint = new St.Label({ text: params.hint, style_class: 'am-hint',
                                        y_align: Clutter.ActorAlign.CENTER });
            this._box.add(this._hint, { x_align: St.Align.END, y_align: St.Align.MIDDLE,
                                        y_fill: false });
        }
        this.addActor(this._box, { expand: true, span: -1 });
        this.actor.label_actor = this.label;
        if (params.onActivate) {
            this.connect('activate', () => {
                try { params.onActivate(); } catch (e) { log_err(text, e); }
            });
        }
    }
}

/* macOS "Force Quit Applications": one row per running app; Force Quit asks
 * for confirmation, then kills every window of that app (SIGKILL through
 * Muffin, the same thing the "not responding" dialog does). */
var ForceQuitDialog = GObject.registerClass(
class ForceQuitDialog extends ModalDialog.ModalDialog {
    _init() {
        super._init({ styleClass: 'am-fq-dialog' });
        this._tracker  = Cinnamon.WindowTracker.get_default();
        this._selected = null;
        this._rows     = [];

        let title = new St.Label({ text: _("Force Quit Applications"),
                                   style_class: 'am-fq-title' });
        let sub = new St.Label({
            text: _("If an app doesn't respond for a while, select its name and click Force Quit."),
            style_class: 'am-fq-sub' });
        sub.clutter_text.line_wrap = true;
        this.contentLayout.add(title, { x_fill: true });
        this.contentLayout.add(sub,   { x_fill: true });

        this._list = new St.BoxLayout({ vertical: true, style_class: 'am-fq-list' });
        let scroll = new St.ScrollView({ style_class: 'am-fq-scroll', x_fill: true, y_fill: true });
        scroll.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC);
        scroll.add_actor(this._list);
        this.contentLayout.add(scroll, { expand: true, x_fill: true, y_fill: true });

        for (let entry of this._apps()) this._addRow(entry);
        if (this._rows.length === 0) {
            this._list.add(new St.Label({ text: _("No applications are running."),
                                          style_class: 'am-fq-empty' }));
        } else {
            this._select(this._rows[0]);
        }

        this.setButtons([
            { label: _("Cancel"), action: () => this.close(), key: Clutter.KEY_Escape },
            { label: _("Force Quit"), action: () => this._confirm(),
              key: Clutter.KEY_Return, default: true, destructive_action: true }
        ]);
    }

    _apps() {
        let byId = new Map();
        for (let actor of global.get_window_actors()) {
            let w = actor.meta_window;
            if (!w || w.is_skip_taskbar()) continue;
            let app = this._tracker.get_window_app(w);
            if (!app) continue;
            let id = app.get_id();
            if (!byId.has(id)) byId.set(id, { app: app, windows: [] });
            byId.get(id).windows.push(w);
        }
        return [...byId.values()].sort((a, b) =>
            a.app.get_name().localeCompare(b.app.get_name()));
    }

    _addRow(entry) {
        let box = new St.BoxLayout({ style_class: 'am-fq-row-box' });
        let icon;
        try { icon = entry.app.create_icon_texture(20); } catch (e) { icon = null; }
        if (icon) box.add(icon, { y_align: St.Align.MIDDLE, y_fill: false });
        box.add(new St.Label({ text: entry.app.get_name(), y_align: Clutter.ActorAlign.CENTER }),
                { expand: true, x_fill: true, y_fill: false, y_align: St.Align.MIDDLE });
        let row = new St.Button({ style_class: 'am-fq-row', child: box, x_fill: true,
                                  can_focus: true });
        row._entry = entry;
        row.connect('clicked', () => this._select(row));
        this._list.add(row, { x_fill: true });
        this._rows.push(row);
    }

    _select(row) {
        for (let r of this._rows) r.remove_style_class_name('am-fq-row-sel');
        row.add_style_class_name('am-fq-row-sel');
        this._selected = row._entry;
    }

    _confirm() {
        let entry = this._selected;
        if (!entry) return;
        let name = entry.app.get_name();
        this.close();
        let dlg = new ModalDialog.ConfirmDialog(
            _("Do you want to force %s to quit?\n\nYou will lose any unsaved changes.").format(name),
            () => {
                for (let w of entry.windows) {
                    try { w.kill(); } catch (e) { log_err("kill " + name, e); }
                }
            });
        dlg.open();
    }
});

class AppleMenuApplet extends Applet.Applet {
    constructor(metadata, orientation, panel_height, instance_id) {
        super(orientation, panel_height, instance_id);

        this.setAllowedLayout(Applet.AllowedLayout.BOTH);
        this._path = metadata.path;
        this.actor.add_style_class_name('am-panel');

        let file = Gio.File.new_for_path(metadata.path + "/icons/apple-symbolic.svg");
        this._icon = new St.Icon({ gicon: new Gio.FileIcon({ file: file }),
                                   icon_type: St.IconType.SYMBOLIC,
                                   icon_size: this.getPanelIconSize(St.IconType.SYMBOLIC),
                                   style_class: 'am-panel-icon' });
        this.actor.add(this._icon, { y_align: St.Align.MIDDLE, y_fill: false });

        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menu = new Applet.AppletPopupMenu(this, orientation);
        this.menu.actor.add_style_class_name('apple-menu');
        this.menuManager.addMenu(this.menu);

        this._keys  = settingsIfPresent(KEYS_SCHEMA);
        this._iface = settingsIfPresent(IFACE_SCHEMA);
        this._docs  = null;

        this._build();

        this.menu.connect('open-state-changed', (m, open) => {
            try {
                if (open) {
                    this._recentSub.menu.close(false);
                    this._fillRecent();
                }
            } catch (e) { log_err("open-state-changed", e); }
        });

        /* Same light/dark rule as the Control Center: the GTK theme name. */
        if (this._iface) {
            this._themeId = this._iface.connect('changed::gtk-theme', () => this._syncTheme());
        }
        this._syncTheme();
    }

    _spawn(cmd) {
        return () => { this.menu.close(false); Util.spawnCommandLine(cmd); };
    }

    _add(text, params) {
        let item = new AppleMenuItem(text, params);
        this.menu.addMenuItem(item);
        return item;
    }

    _sep() {
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
    }

    _build() {
        let userName = GLib.get_real_name();
        if (!userName || userName === "Unknown") userName = GLib.get_user_name();

        this._add(_("About This Mac"), { onActivate: () => this._about() });
        this._sep();
        this._add(_("System Settings…"), { onActivate: this._spawn("cinnamon-settings") });
        this._add(_("App Store…"),       { onActivate: this._spawn("mintinstall") });
        this._sep();

        this._recentSub = new PopupMenu.PopupSubMenuMenuItem(_("Recent Items"));
        this._recentSub.actor.add_style_class_name('am-submenu-item');
        this.menu.addMenuItem(this._recentSub);
        this._sep();

        this._add(_("Force Quit…"), { onActivate: () => this._forceQuit() });
        this._sep();
        this._add(_("Sleep"),      { onActivate: this._spawn("systemctl suspend") });
        this._add(_("Restart…"),   { onActivate: this._spawn("cinnamon-session-quit --reboot") });
        this._add(_("Shut Down…"), { onActivate: this._spawn("cinnamon-session-quit --power-off"),
                                     hint: keyHint(this._keys, "shutdown") });
        this._sep();
        this._add(_("Lock Screen"), { onActivate: this._spawn("cinnamon-screensaver-command --lock"),
                                      hint: keyHint(this._keys, "screensaver") });
        this._add(_("Log Out %s…").format(userName),
                  { onActivate: this._spawn("cinnamon-session-quit --logout"),
                    hint: keyHint(this._keys, "logout") });
    }

    _fillRecent() {
        let sub = this._recentSub.menu;
        sub.removeAll();
        if (!this._docs) {
            try { this._docs = DocInfo.getDocManager(); }
            catch (e) { log_err("DocManager", e); }
        }
        let docs = this._docs ? this._docs._infosByTimestamp.slice(0, RECENT_MAX) : [];
        if (docs.length === 0) {
            let none = new PopupMenu.PopupBaseMenuItem({ reactive: false });
            none.addActor(new St.Label({ text: _("No Recent Items"), style_class: 'am-dim' }),
                          { expand: true, span: -1 });
            sub.addMenuItem(none);
        }
        for (let doc of docs) {
            let icon = doc.createIcon(16);
            icon.add_style_class_name('am-doc-icon');
            sub.addMenuItem(new AppleMenuItem(doc.name, {
                icon: icon,
                onActivate: () => {
                    this.menu.close(false);
                    Gio.AppInfo.launch_default_for_uri(doc.uri, null);
                }
            }));
        }
        if (docs.length > 0) {
            sub.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            sub.addMenuItem(new AppleMenuItem(_("Clear Menu"), {
                onActivate: () => {
                    this.menu.close(false);
                    Gtk.RecentManager.get_default().purge_items();
                }
            }));
        }
    }

    _about() {
        this.menu.close(false);
        Util.spawnCommandLine("python3 " + GLib.shell_quote(this._path + "/tools/about-this-mac.py"));
    }

    _forceQuit() {
        this.menu.close(false);
        try { new ForceQuitDialog().open(); }
        catch (e) { log_err("ForceQuitDialog", e); }
    }

    _syncTheme() {
        let dark = true;
        try {
            if (this._iface) dark = this._iface.get_string("gtk-theme").indexOf("-Dark") !== -1;
        } catch (e) {}
        if (dark) this.menu.actor.remove_style_class_name('am-light');
        else      this.menu.actor.add_style_class_name('am-light');
    }

    on_panel_icon_size_changed(size) {
        this._icon.icon_size = size;
    }

    on_applet_clicked(event) {
        this.menu.toggle();
    }

    on_applet_removed_from_panel() {
        if (this._iface && this._themeId) {
            try { this._iface.disconnect(this._themeId); } catch (e) {}
            this._themeId = 0;
        }
    }
}

function main(metadata, orientation, panel_height, instance_id) {
    return new AppleMenuApplet(metadata, orientation, panel_height, instance_id);
}
