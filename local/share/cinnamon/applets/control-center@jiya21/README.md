# Control Center

A macOS-style Control Center applet for Cinnamon: Wi-Fi, Bluetooth, brightness,
volume, media and battery in one popup. Replaces `network@cinnamon.org`,
`sound@cinnamon.org` and `power@cinnamon.org` on the panel.

## How it works

Instead of reimplementing NetworkManager, Cvc and backlight handling, it loads
Cinnamon's own applet modules by absolute path and reuses their widgets:

```js
const NetLib = require('/usr/share/cinnamon/applets/network@cinnamon.org/applet.js');
```

`require()` (`/usr/share/cinnamon/js/misc/fileUtils.js:243`) leaves absolute
paths unrewritten, and `createExports` exposes every top-level declaration.
Those widgets take an object they call `applet` and touch only a handful of
members on it, so this applet implements that contract directly — no stock
applet is ever instantiated (it couldn't be: `Applet._getPanelInfo` throws for
an instance id that isn't in `enabled-applets`).

Reused: `NMDeviceWireless`, `NMWirelessSectionTitleMenuItem`, `VolumeSlider`,
`StreamMenuSection`, `Player`, `BrightnessSlider`, `DeviceItem`.

Written here: a Wi-Fi-only device/connection tracker (a cut-down
`CinnamonNetworkApplet`), and all the Bluetooth handling (`org.bluez`).

## Maintenance

The tradeoff of that reuse is a dependency on Cinnamon's class names and a few
private members. **After a Cinnamon major upgrade, open the menu once and
check `~/.xsession-errors`:**

```bash
grep -nE "control-center@jiya21|JS ERROR" ~/.xsession-errors | tail -40
```

Each section is built in its own `try`/`catch`, so a break degrades one section
to a "Settings…" link rather than removing Wi-Fi, volume and battery from the
panel together. Stack traces from reused code name the *stock* applet file,
which distinguishes an upstream change from a bug here.

## Bluetooth

Uses `org.bluez` directly for state and connect/disconnect. It deliberately
does **not** implement pairing: that needs a registered `org.bluez.Agent1` to
answer passkey prompts, which `blueman-applet` provides. Leave blueman running
— only its tray icon is hidden.

## Blur

The menu is transparent so BlurCinnamon can frost it. That needs two things
together: BlurCinnamon's `enable-popup-effects` turned on, **and** the
`border-image: none` rule in `stylesheet.css` — WhiteSur-Dark-solid paints
`.popup-menu` with an opaque 9-slice image that BlurCinnamon does not override.
With blur off, the stylesheet's `background-color` is a translucent fallback.

## Panel battery glyph

The panel battery is drawn with Cairo (`lib/batteryGlyph.js`), not taken from
the icon theme, so it can match the macOS menu bar battery: a wide body with a
faint frame, a solid fill that tracks the exact percentage, a bolt while on AC,
red at or under 20%, yellow while the `power-saver` profile is active.

Preview every state without reloading Cinnamon:

    cjs tools/preview-battery.js /tmp/battery.png 8

## Dark Mode tile

Flips the WhiteSur pair `WhiteSur-Dark-solid` ↔ `WhiteSur-Light-solid` for
`org.cinnamon.desktop.interface gtk-theme` and `org.cinnamon.theme name`, sets
`org.x.apps.portal color-scheme` (`prefer-dark` / `default`) for portal and
libadwaita apps, and toggles `cc-light` on this applet's own menus.

`~/.config/gtk-3.0/gtk.css` is a symlink the tile owns: `gtk.css.dark`
(the hand-written dark-only restyle of cinnamon-settings plus the Finder skin
`finder.css`) while dark mode is on, `gtk.css.light` (just the Finder skin)
otherwise.  A real (non-symlink) `gtk.css` is never touched.  The light theme was unpacked from
`~/WhiteSur-gtk-theme/release/WhiteSur-Light-solid.tar.xz` into `~/.themes`.

## Two menus, two source actors

The Control Center and battery menus are plain `PopupMenu.PopupMenu`s anchored
on the glyph bin and the battery item respectively — not `AppletPopupMenu`,
which would anchor both on the whole applet actor and make the manager's
hover-switching fire from any pointer movement across the applet.

## Control Center layout (macOS Tahoe)

Traced from Apple's own Control Center screenshot: no opaque panel, glass
tiles floating over the backdrop.  Left column: Wi-Fi, Bluetooth and
Warpinator (Mint's AirDrop) pills; right: the Now Playing square (driven by
the active sound@ Player) over Night Light and Dark Mode round buttons; then
Screen Mirroring, Screenshot and the Do Not Disturb pill; then Display,
Keyboard and Sound sliders with icons outside a thin track.

Glass is a tint, not a blur: BlurCinnamon's popup effects are off (its static
blur samples the wallpaper, not the window underneath).  Note the Cinnamon 6
menu actor's classes are `menu menu-top`, not `popup-menu` — container rules
in stylesheet.css must say `.menu…` or they silently never match.
