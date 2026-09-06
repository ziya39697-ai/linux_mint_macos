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
