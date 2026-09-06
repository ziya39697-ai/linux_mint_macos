# Apple Menu (`apple-menu@jiya21`)

The  menu from the far left of a macOS menu bar, for Cinnamon 6. It replaces
`menu@cinnamon.org` on this desktop (Launchpad, Spotlight and the dock cover app
launching), so the panel reads exactly like macOS: logo left, status items right.

## Entries and what they run

| Entry | Mint equivalent |
|---|---|
| About This Mac | `tools/about-this-mac.py` — GTK 3 window laid out like macOS: product image, model, processor, graphics, memory, display, startup disk, serial (when readable), OS, desktop, kernel. "More Info…" opens `cinnamon-settings info`. |
| System Settings… | `cinnamon-settings` |
| App Store… | `mintinstall` |
| Recent Items ▸ | GTK recent documents via Cinnamon's `DocManager` (10 newest), "Clear Menu" purges them |
| Force Quit… | In-shell dialog listing running apps (via `Cinnamon.WindowTracker`); confirms, then `Meta.Window.kill()` on every window of the app |
| Sleep | `systemctl suspend` |
| Restart… / Shut Down… | `cinnamon-session-quit --reboot` / `--power-off` (Mint's own confirmation) |
| Lock Screen | `cinnamon-screensaver-command --lock` |
| Log Out *Name*… | `cinnamon-session-quit --logout` |

Shortcut hints on the right come from `org.cinnamon.desktop.keybindings.media-keys`
(`screensaver`, `logout`, `shutdown`) rendered as macOS glyphs (⌃ ⌥ ⇧ ⌘).

## Icon

`icons/apple-symbolic.svg` is the full-resolution vector Apple logo (Wikimedia Commons
path, 814×1000) centred on a square 1000×1000 canvas so the symbolic loader scales it
uniformly. It is loaded as a `Gio.FileIcon`, so GTK recolours it with the panel's
foreground colour; the panel draws it at the zone's symbolic icon size (16 px here).

## Files

- `applet.js` — applet, `AppleMenuItem` (single-actor rows: icon · label · hint), `ForceQuitDialog`
- `stylesheet.css` — Tahoe-style menu (`.menu.apple-menu` — Cinnamon 6 menus carry the class `menu`, not `popup-menu`), light variant `am-light` (follows the GTK theme name like the Control Center), Force Quit dialog
- `tools/about-this-mac.py` — About window; `~/.local/share/applications/about-this-mac.desktop` (NoDisplay, `StartupWMClass=about-this-mac`) gives it a name and icon in Force Quit and the dock
- `assets/macbook-air-2015-13in.png` — Apple's product shot with the white background knocked out

## Notes

- The Mint menu's Super-key overlay went with it; nothing opens on a bare Super press now.
- Cinnamon submenus unfold in place rather than flying out, so Recent Items expands inline.
