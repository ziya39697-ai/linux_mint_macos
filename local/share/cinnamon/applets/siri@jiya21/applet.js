/*
 * Siri — the macOS 27 Golden Gate menu bar glyph, as a placeholder.
 * Clicking it does nothing yet; the icon is in icons/siri-symbolic.svg.
 */
const Applet = imports.ui.applet;
const Gio    = imports.gi.Gio;
const St     = imports.gi.St;

class SiriApplet extends Applet.Applet {
    constructor(metadata, orientation, panel_height, instance_id) {
        super(orientation, panel_height, instance_id);
        this.setAllowedLayout(Applet.AllowedLayout.BOTH);
        this.set_applet_tooltip(_("Siri"));

        let file = Gio.File.new_for_path(metadata.path + "/icons/siri-symbolic.svg");
        this._icon = new St.Icon({ gicon: new Gio.FileIcon({ file: file }),
                                   icon_type: St.IconType.SYMBOLIC,
                                   icon_size: this.getPanelIconSize(St.IconType.SYMBOLIC),
                                   style_class: 'system-status-icon' });
        this.actor.add(this._icon, { y_align: St.Align.MIDDLE, y_fill: false });
    }

    on_panel_icon_size_changed(size) { this._icon.icon_size = size; }

    on_applet_clicked(event) { /* placeholder: nothing wired yet */ }
}

function main(metadata, orientation, panel_height, instance_id) {
    return new SiriApplet(metadata, orientation, panel_height, instance_id);
}
