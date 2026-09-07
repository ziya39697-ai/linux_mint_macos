# Golden Gate lock screen (cinnamon-screensaver overlay)

`~/.local/share/dbus-1/services/org.cinnamon.ScreenSaver.service` makes the
session bus start `launcher` here instead of `/usr/bin/cinnamon-screensaver`.
`main.py` puts `overlay/` ahead of `/usr/share/cinnamon-screensaver` on
`sys.path` and runs the stock `cinnamon-screensaver-main.py`, so only the four
modules in `overlay/` differ from the package:

| module | change |
|---|---|
| `stage.py` | clock fixed top-centre (7.5 % down), album art under it, unlock dialog bottom-centre (6 % margin); no random floating; no on-screen keyboard |
| `clock.py` | date line above the time, translucent white, no bold wrapper, no "low-res" font shrink |
| `unlock.py` | 56 px avatar, `realname` class, "Enter Password" placeholder, arrow unlock button, empty message rows hidden |
| `monitorView.py` | wallpaper shade 0.7 → 0 (`MAC_SHADE`) |

Everything visual beyond that is CSS in `~/.config/gtk-3.0/lockscreen.css` and
fonts/formats in gsettings `org.cinnamon.desktop.screensaver`.

Safety: `main.py` imports every overlay module first; on any failure it prints
`overlay FAILED` and runs the unmodified screensaver.

After a cinnamon-screensaver upgrade: `./rebuild.sh` (copies the fresh modules
and re-applies `patches/apply.py`; each replacement must match exactly once).

Testing without locking yourself out:
`launcher --hold --debug --no-fallback &`, `cinnamon-screensaver-command --lock`,
look, then `cinnamon-screensaver-command --deactivate` (the D-Bus SetActive(false)
call dismisses even a locked stage) or `pkill -f '^cinnamon-screensaver$'`.
