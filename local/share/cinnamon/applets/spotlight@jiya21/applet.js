/*
 * Spotlight — a magnifier in the panel that opens Ulauncher on a single click.
 *
 * Ulauncher's own indicator ("show-indicator-icon") is a tray icon that needs a
 * click to open a menu and a second click on "Show Ulauncher".  This replaces
 * it with the macOS Spotlight behaviour: one click, straight to the search bar.
 */

const Applet = imports.ui.applet;
const GLib   = imports.gi.GLib;
const St     = imports.gi.St;
const Util   = imports.misc.util;

const UUID = "spotlight@jiya21";

class SpotlightApplet extends Applet.IconApplet {
    constructor(metadata, orientation, panel_height, instance_id) {
        super(orientation, panel_height, instance_id);

        this.setAllowedLayout(Applet.AllowedLayout.BOTH);
        this.set_applet_icon_symbolic_name("xsi-edit-find");
        this.set_applet_tooltip(_("Search"));

        /* ulauncher-toggle is the supported single-shot entry point; it raises
         * the already-running --hide-window instance rather than starting a
         * second one. */
        this._cmd = GLib.find_program_in_path("ulauncher-toggle")
            ? "ulauncher-toggle"
            : "ulauncher";
    }

    on_applet_clicked(event) {
        Util.spawnCommandLine(this._cmd);
    }
}

function main(metadata, orientation, panel_height, instance_id) {
    return new SpotlightApplet(metadata, orientation, panel_height, instance_id);
}
