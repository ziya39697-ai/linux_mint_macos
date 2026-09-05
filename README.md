# Desktop backup — Linux Mint Cinnamon (macOS-style)

A portable snapshot of this machine's customized Cinnamon desktop: settings, panel,
applets, Plank dock, the custom Launchpad app, themes, icons, launchers, and the
package list needed to rebuild it.

Captured from **Linux Mint 22.3 "Zena" / Cinnamon 6.6.9 / X11**, user `jiya21`.

```
./backup.sh              refresh this bundle from the live system, then git-commit
./backup.sh --no-commit  refresh only

./restore.sh                          DRY RUN — prints every action, changes nothing
./restore.sh --apply                  rebuild the desktop
./restore.sh --apply --skip-packages  files + settings only, no apt
```

`backup.sh` only ever reads the live system. `restore.sh` defaults to a dry run;
nothing is written until you pass `--apply`.

## What this desktop actually is

A macOS-shaped Cinnamon: a single 20px top panel, window buttons on the **left**,
WhiteSur GTK theme + icons, Bibata cursors, Plank as the dock with a hand-written
`macOS` dock theme, and a custom full-screen Launchpad in place of an app menu.
There is no window-list applet — Plank does that job.

## Contents

| Path | What |
|---|---|
| `dconf/` | 7 `dconf` dumps: Cinnamon, Plank, Nemo, GNOME desktop, X-Apps, GTK, Mint |
| `config/cinnamon/spices/` | Applet settings — the panel menu icon, calendar format `%A, %B %e, %H:%M` |
| `config/plank/` | The 6 dock items and their order |
| `config/launchpad/layout.json` | Launchpad page/grid layout (30 apps + 2 folders) |
| `config/autostart/` | Plank + Launchpad daemon autostart entries |
| `config/bashrc.delta` | **Only** the lines appended to the stock `/etc/skel/.bashrc` |
| `local/bin/launchpad` | The custom ~1900-line Python/GTK3 Launchpad, mode 755 |
| `local/share/plank/themes/macOS/` | The hand-authored frosted-glass dock theme |
| `assets/` | Wallpaper and panel menu icon |
| `themes/` | `WhiteSur-Dark-solid` GTK/Cinnamon theme (4.1 MB) |
| `icons/` | `WhiteSur`, `-dark`, `-light` (103 MB) + the `default` cursor stubs |
| `packages/intentional.txt` | The 21 packages actually chosen, per Mint's own record |
| `packages/sources.list.d/` | The third-party apt repos those need |
| `manifest.json` | Host/version metadata + sha256 of every file outside `icons/` |

## Two things worth knowing

**Restore order matters.** The WhiteSur theme's `index.theme` declares
`IconTheme=WhiteSur-Dark` and `CursorTheme=WhiteSur-cursors`, but the live setup
overrides these to `WhiteSur` and `Bibata-Modern-Classic`. `restore.sh` loads the
Cinnamon dconf dump **last** so those values win.

**Plank must be stopped before its settings load.** Plank re-persists its own dock
order whenever the key changes while it is running, so loading `dock-items` into a
live Plank silently overwrites the restored order with the current one. `restore.sh`
kills Plank before the Plank dconf load and starts it again at the end.

**`dconf` ignores `$HOME`.** It writes through the session's dconf-service, which uses
that service's home. Restoring with an overridden `$HOME` would rewrite the
logged-in user's real settings, so `restore.sh` detects the mismatch, skips the dconf
step, and tells you to load the dumps from a real login instead.

**Paths are rewritten on restore.** The bundle was captured under `/home/jiya21`, and
that path is baked into dconf values, `.dockitem` files, and `.desktop` files.
`restore.sh` stages every text file and rewrites the old home to `$HOME`, so restoring
under a different username works.

## Assets no longer live in ~/Downloads

The wallpaper and the panel's Apple-logo menu icon originally pointed into
`~/Downloads`, where one cleanup would have silently broken them (the menu icon would
have quietly fallen back to the Mint logo). Both now live in
`~/.local/share/desktop-assets/` and the settings point there. The originals were
copied, not moved — they are still in `~/Downloads`.

## Rebuilding the icon theme instead of using the bundled copy

The 103 MB of icons here is the built output of
[WhiteSur-icon-theme](https://github.com/vinceliuice/WhiteSur-icon-theme), cloned at
`~/WhiteSur-icon-theme`. The bundled copy is authoritative and works offline; to
rebuild from source instead:

```sh
git clone https://github.com/vinceliuice/WhiteSur-icon-theme.git
cd WhiteSur-icon-theme && ./install.sh        # installs to ~/.local/share/icons
```

The `WhiteSur-Dark-solid` **GTK theme** has no clone on disk — this bundle is the only
copy of it. If it is lost, it must be re-fetched from
[WhiteSur-gtk-theme](https://github.com/vinceliuice/WhiteSur-gtk-theme) and rebuilt
with the matching variant flags.

## Third-party repos

`packages/sources.list.d/` holds the repo files for Chrome, Cursor, Claude Desktop and
Docker. Their signing keys are **not** bundled — the installers fetch them:

- Chrome / Cursor / Claude Desktop: install the vendor `.deb` once, which re-adds both
  the repo and its key
- Docker: follow the official `get.docker.com` convenience script or the documented
  keyring steps

`official-package-repositories.list` is Mint's own and is skipped on restore.

## Deliberately not backed up

Credentials and identity, on purpose: `~/.git-credentials`, `~/.gnupg`, `~/.pki`,
login keyrings, browser profiles. `~/.gitconfig` **is** included (name/email only, no
tokens). Also excluded: `__pycache__`, caches, and the 118 MB icon-theme source repo.

Not customized on this machine, so absent by design: custom fonts (none — `~/.fonts`
and `~/.local/share/fonts` do not exist), third-party Cinnamon spices (none installed),
desktop launchers (`~/Desktop` is empty), user systemd units, and cron jobs.

## After a restore

`restore.sh` restarts Plank itself. Restart Cinnamon with **Ctrl+Alt+Esc** to pick up
the panel layout and the menu icon. Then, by hand:

- install nvm (the `.bashrc` delta sources it but does not install it)
- re-add git credentials
- conky is **not** autostarted here — run `conky &` if you want the CPU-temp readout
