#!/usr/bin/env bash
# Rebuild the Cinnamon desktop captured in this bundle.
#
#   ./restore.sh              DRY RUN - prints every action, changes nothing
#   ./restore.sh --apply      actually do it
#   ./restore.sh --apply --skip-packages    files + settings only, no apt
#
# Idempotent: running it twice leaves the same result. The bundle was captured
# under one home directory; every absolute path baked into the settings is
# rewritten to the home this runs under, so restoring as a different user works.
#
set -euo pipefail

BUNDLE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APPLY=0
SKIP_PACKAGES=0
for arg in "$@"; do
  case "$arg" in
    --apply)          APPLY=1 ;;
    --skip-packages)  SKIP_PACKAGES=1 ;;
    -h|--help)        sed -n '2,10p' "$0" | sed 's/^# \?//'; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

head_() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
say()   { printf '  %s\n' "$*"; }
run()   { if (( APPLY )); then eval "$@"; else printf '  \033[2m$ %s\033[0m\n' "$*"; fi; }

if (( ! APPLY )); then
  printf '\033[1;33mDRY RUN\033[0m - nothing will be changed. Re-run with --apply to commit.\n'
fi

# ---------------------------------------------------------------- preflight
head_ "preflight"
SRC_HOME="$(python3 -c "
import json,sys
m=json.load(open('$BUNDLE/manifest.json'))
print('/home/'+m['user'] if m.get('user') else '')
")"
[[ -z "$SRC_HOME" ]] && { echo "cannot determine source home from manifest" >&2; exit 1; }
say "bundle captured: $(python3 -c "import json;print(json.load(open('$BUNDLE/manifest.json'))['generated'])")"
say "source home:    $SRC_HOME"
say "target home:    $HOME"
if [[ "$SRC_HOME" != "$HOME" ]]; then
  say "-> paths will be rewritten $SRC_HOME -> $HOME"
fi

want_cinnamon="$(python3 -c "import json;print(json.load(open('$BUNDLE/manifest.json')).get('cinnamon') or '')")"
have_cinnamon="$(cinnamon --version 2>/dev/null || echo '')"
if [[ -n "$have_cinnamon" && "$want_cinnamon" != "$have_cinnamon" ]]; then
  say "WARNING: captured on '$want_cinnamon', running '$have_cinnamon' - settings keys may differ"
elif [[ -z "$have_cinnamon" ]]; then
  say "WARNING: Cinnamon not detected; restoring files anyway"
fi

# Stage text files with the home path rewritten, so the live copy step is a
# plain cp and nothing is edited in place under $HOME.
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp -a "$BUNDLE/config" "$BUNDLE/local" "$STAGE/"
cp -a "$BUNDLE/dconf" "$STAGE/"
if [[ "$SRC_HOME" != "$HOME" ]]; then
  grep -rlI -- "$SRC_HOME" "$STAGE" 2>/dev/null \
    | xargs -r sed -i "s|$SRC_HOME|$HOME|g"
  say "rewrote $(grep -rlI -- "$HOME" "$STAGE" 2>/dev/null | wc -l) staged files"
fi

# ---------------------------------------------------------------- packages
head_ "packages"
if (( SKIP_PACKAGES )); then
  say "skipped (--skip-packages)"
else
  missing=()
  while read -r pkg; do
    [[ -z "$pkg" ]] && continue
    dpkg -s "$pkg" >/dev/null 2>&1 || missing+=("$pkg")
  done < "$BUNDLE/packages/intentional.txt"

  if (( ${#missing[@]} == 0 )); then
    say "all $(wc -l < "$BUNDLE/packages/intentional.txt") recorded packages already installed"
  else
    say "missing: ${missing[*]}"
    # Third-party repos must exist before apt can see chrome/cursor/claude/docker.
    say "third-party repos to add first (need their signing keys - see README):"
    for f in "$BUNDLE"/packages/sources.list.d/*; do
      [[ "$(basename "$f")" == official-package-repositories.list ]] && continue
      say "  $(basename "$f")"
      run "sudo cp '$f' /etc/apt/sources.list.d/"
    done
    run "sudo apt-get update"
    run "sudo apt-get install -y ${missing[*]}"
  fi
fi

# ---------------------------------------------------------------- themes, icons, cursors
head_ "themes, icons, cursors"
run "mkdir -p '$HOME/.themes' '$HOME/.local/share/icons' '$HOME/.icons'"
run "rsync -a '$BUNDLE/themes/' '$HOME/.themes/'"
say "themes:  $(ls "$BUNDLE/themes" | tr '\n' ' ')"
run "rsync -a --exclude '.dot-icons' '$BUNDLE/icons/' '$HOME/.local/share/icons/'"
say "icons:   $(ls "$BUNDLE/icons" | grep -v dot-icons | tr '\n' ' ') (~$(du -sh "$BUNDLE/icons" | cut -f1))"
if [[ -d "$BUNDLE/icons/.dot-icons" ]]; then
  run "rsync -a '$BUNDLE/icons/.dot-icons/' '$HOME/.icons/'"
  say "cursor stub -> ~/.icons/default"
fi

# ---------------------------------------------------------------- assets
# Land the wallpaper somewhere stable, never in ~/Downloads.
head_ "assets"
ASSETS="$HOME/.local/share/desktop-assets"
run "mkdir -p '$ASSETS'"
for a in "$BUNDLE"/assets/*; do
  [[ -e "$a" ]] || continue
  run "cp -a '$a' '$ASSETS/'"
  say "$(basename "$a") -> $ASSETS/"
done

# ---------------------------------------------------------------- files
head_ "config + local files"
copy() {  # copy <staged-src> <dest> [mode]
  local src="$1" dest="$2" mode="${3:-}"
  [[ -e "$src" ]] || return 0
  run "mkdir -p '$(dirname "$dest")'"
  run "cp -a '$src' '$dest'"
  [[ -n "$mode" ]] && run "chmod $mode '$dest'"
  say "$(basename "$dest")"
}

run "mkdir -p '$HOME/.config/cinnamon'"
run "rsync -a '$STAGE/config/cinnamon/spices/' '$HOME/.config/cinnamon/spices/'"
say "cinnamon/spices (applet settings)"

copy "$STAGE/config/cinnamon-monitors.xml" "$HOME/.config/cinnamon-monitors.xml"
run "mkdir -p '$HOME/.config/plank/dock1'"
run "rsync -a '$STAGE/config/plank/dock1/launchers/' '$HOME/.config/plank/dock1/launchers/'"
say "plank launchers ($(ls "$STAGE/config/plank/dock1/launchers" | wc -l) dockitems)"

copy "$STAGE/config/launchpad/layout.json" "$HOME/.config/launchpad/layout.json"
run "mkdir -p '$HOME/.config/autostart'"
for f in "$STAGE"/config/autostart/*.desktop; do
  [[ -e "$f" ]] || continue
  copy "$f" "$HOME/.config/autostart/$(basename "$f")"
done
copy "$STAGE/config/gtk-3.0/bookmarks" "$HOME/.config/gtk-3.0/bookmarks"
for f in gtk.css.dark gtk.css.light finder.css lockscreen.css; do
  copy "$STAGE/config/gtk-3.0/$f" "$HOME/.config/gtk-3.0/$f"
done
if [[ -f "$STAGE/config/gtk-3.0/gtk.css.link" ]] && [[ ! -e "$HOME/.config/gtk-3.0/gtk.css" || -L "$HOME/.config/gtk-3.0/gtk.css" ]]; then
  run "ln -sfn '$(cat "$STAGE/config/gtk-3.0/gtk.css.link")' '$HOME/.config/gtk-3.0/gtk.css'"
  say "gtk-3.0/gtk.css -> $(cat "$STAGE/config/gtk-3.0/gtk.css.link")"
fi
copy "$STAGE/config/mimeapps.list"     "$HOME/.config/mimeapps.list"

# Lock screen (Golden Gate): patched-module overlay + D-Bus activation override + avatar.
if [[ -d "$STAGE/local/share/cinnamon-screensaver-mac" ]]; then
  run "mkdir -p '$HOME/.local/share/cinnamon-screensaver-mac'"
  run "rsync -a '$STAGE/local/share/cinnamon-screensaver-mac/' '$HOME/.local/share/cinnamon-screensaver-mac/'"
  run "chmod 755 '$HOME/.local/share/cinnamon-screensaver-mac/launcher' '$HOME/.local/share/cinnamon-screensaver-mac/main.py' '$HOME/.local/share/cinnamon-screensaver-mac/rebuild.sh'"
  # The overlay was cut from the cinnamon-screensaver installed when the bundle was
  # made; rebuild it from the one installed here so the patches apply to matching code.
  run "'$HOME/.local/share/cinnamon-screensaver-mac/rebuild.sh'"
  say "cinnamon-screensaver-mac (lock screen overlay, rebuilt against the installed screensaver)"
fi
copy "$STAGE/config/dbus-1/services/org.cinnamon.ScreenSaver.service" "$HOME/.local/share/dbus-1/services/org.cinnamon.ScreenSaver.service"
copy "$STAGE/config/face.png" "$HOME/.face"
if [[ -f "$STAGE/config/dbus-1/services/org.cinnamon.ScreenSaver.service" ]]; then
  # Make the running session bus pick up the override and retire any stock instance.
  run "dbus-send --session --print-reply --dest=org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus.ReloadConfig >/dev/null 2>&1 || true"
  run "cinnamon-screensaver-command --exit >/dev/null 2>&1 || true"
fi
copy "$STAGE/config/conkyrc"           "$HOME/.conkyrc"
copy "$STAGE/config/gitconfig"         "$HOME/.gitconfig"

copy "$STAGE/local/bin/launchpad" "$HOME/.local/bin/launchpad" 755
for f in "$STAGE"/local/share/applications/*.desktop; do
  [[ -e "$f" ]] || continue
  copy "$f" "$HOME/.local/share/applications/$(basename "$f")"
done
run "mkdir -p '$HOME/.local/share/plank/themes'"
run "rsync -a '$STAGE/local/share/plank/themes/' '$HOME/.local/share/plank/themes/'"
say "plank themes ($(ls "$STAGE/local/share/plank/themes" | tr '\n' ' '))"

# .bashrc: append the recorded delta only if it is not already there.
if [[ -s "$STAGE/config/bashrc.delta" ]]; then
  marker="$(head -1 "$STAGE/config/bashrc.delta")"
  if grep -qF -- "$marker" "$HOME/.bashrc" 2>/dev/null; then
    say "bashrc.delta already present - skipped"
  else
    run "printf '\n' >> '$HOME/.bashrc'"
    run "cat '$STAGE/config/bashrc.delta' >> '$HOME/.bashrc'"
    say "bashrc.delta appended ($(wc -l < "$STAGE/config/bashrc.delta") lines)"
  fi
fi

# ---------------------------------------------------------------- add-on apps
# Cinnamon extensions, then Ulauncher / Newelle / Toshy configs. Each is a
# no-op when the bundle does not carry it.
head_ "extensions + add-on apps"
if [[ -d "$STAGE/local/share/cinnamon/extensions" ]]; then
  run "mkdir -p '$HOME/.local/share/cinnamon/extensions'"
  run "rsync -a '$STAGE/local/share/cinnamon/extensions/' '$HOME/.local/share/cinnamon/extensions/'"
  say "cinnamon extensions ($(ls "$STAGE/local/share/cinnamon/extensions" | tr '\n' ' '))"
fi

if [[ -d "$STAGE/local/share/cinnamon/applets" ]]; then
  run "mkdir -p '$HOME/.local/share/cinnamon/applets'"
  run "rsync -a '$STAGE/local/share/cinnamon/applets/' '$HOME/.local/share/cinnamon/applets/'"
  say "cinnamon applets ($(ls "$STAGE/local/share/cinnamon/applets" | tr '\n' ' '))"
fi

if [[ -d "$STAGE/apps/ulauncher" ]]; then
  run "mkdir -p '$HOME/.config/ulauncher'"
  run "rsync -a '$STAGE/apps/ulauncher/' '$HOME/.config/ulauncher/'"
  say "ulauncher config"
fi

if [[ -f "$STAGE/apps/newelle/keyfile" ]]; then
  NKF="$HOME/.var/app/io.github.qwersyk.Newelle/config/glib-2.0/settings"
  run "mkdir -p '$NKF'"
  run "cp -a '$STAGE/apps/newelle/keyfile' '$NKF/keyfile'"
  say "newelle settings"
  grep -q '<REDACTED>' "$STAGE/apps/newelle/keyfile" 2>/dev/null && \
    say "  note: an API key was redacted at backup time - re-enter it in Newelle"
fi

if [[ -d "$STAGE/apps/toshy" ]]; then
  run "mkdir -p '$HOME/.config/toshy'"
  run "rsync -a '$STAGE/apps/toshy/' '$HOME/.config/toshy/'"
  say "toshy config"
fi

# Flatpaks are listed, not auto-installed: each pulls GBs of runtime and the
# user should choose when that happens.
if [[ -s "$STAGE/apps/flatpaks-user.txt" ]]; then
  say "flatpaks to reinstall by hand:"
  while read -r app branch; do
    [[ -z "$app" || "$app" == "Application"* ]] && continue
    say "    flatpak install --user flathub $app"
  done < "$STAGE/apps/flatpaks-user.txt"
fi

# ---------------------------------------------------------------- dconf
# Cinnamon LAST: the WhiteSur theme's index.theme declares its own icon and
# cursor themes, and the live dconf values must win over them.
#
# Guard: `dconf` writes through the session's dconf-service, which uses the
# service's own home - NOT $HOME. If $HOME has been overridden (a staged test,
# a chroot, restoring into someone else's tree) a load here would silently
# rewrite the *logged-in user's* real settings. Detect that and refuse.
head_ "dconf"
PASSWD_HOME="$(getent passwd "$(id -un)" | cut -d: -f6)"
if [[ -n "$PASSWD_HOME" && "$PASSWD_HOME" != "$HOME" ]]; then
  say "SKIPPED - \$HOME ($HOME) is not this user's real home ($PASSWD_HOME)."
  say "dconf would write to $PASSWD_HOME and clobber the live session."
  say "Files were restored; load the settings from a real login as that user:"
  for name in gtk nemo x-apps linuxmint gnome-desktop plank cinnamon; do
    [[ -s "$STAGE/dconf/$name.dconf" ]] || continue
    say "    dconf load <path> < $BUNDLE/dconf/$name.dconf"
    break
  done
else
  for name in gtk nemo x-apps linuxmint gnome-desktop plank cinnamon; do
    f="$STAGE/dconf/$name.dconf"
    [[ -s "$f" ]] || continue
    case "$name" in
      cinnamon)      path=/org/cinnamon/ ;;
      plank)         path=/net/launchpad/plank/ ;;
      nemo)          path=/org/nemo/ ;;
      gnome-desktop) path=/org/gnome/desktop/ ;;
      x-apps)        path=/org/x/ ;;
      gtk)           path=/org/gtk/ ;;
      linuxmint)     path=/com/linuxmint/ ;;
    esac
    # Plank rewrites dock-items on exit; stop it before loading its keys.
    [[ "$name" == plank ]] && run "pkill -x plank 2>/dev/null || true"
    run "dconf load '$path' < '$f'"
    say "$(printf '%-14s' "$name") -> $path"
  done
fi

# ---------------------------------------------------------------- caches
head_ "refresh caches"
for d in "$HOME"/.local/share/icons/*/; do
  [[ -f "$d/index.theme" ]] || continue
  run "gtk-update-icon-cache -f -q '$d' 2>/dev/null || true"
done
say "icon caches rebuilt"
run "update-desktop-database '$HOME/.local/share/applications' 2>/dev/null || true"
say "desktop database updated"

# ---------------------------------------------------------------- restart
head_ "restart"
if (( APPLY )) && [[ -n "${DISPLAY:-}" ]]; then
  pkill -x plank 2>/dev/null || true
  (setsid plank >/dev/null 2>&1 &) || true
  say "plank restarted"
  say "now restart Cinnamon to pick up the panel layout and applets:"
  say "    Ctrl+Alt+Esc     (or:  cinnamon --replace & )"
else
  run "pkill -x plank; setsid plank &"
  say "then restart Cinnamon: Ctrl+Alt+Esc"
fi

# ---------------------------------------------------------------- manual steps
head_ "not covered - do these by hand"
cat <<'MANUAL'
  - nvm:   curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/master/install.sh | bash
  - git credentials (~/.git-credentials) - deliberately NOT backed up
  - GPG keys, browser profiles, keyrings - deliberately NOT backed up
  - conky is not autostarted; run `conky &` or add it to ~/.config/autostart
  - Toshy (if restored): re-run its installer to add the 'input' group, then log out
  - Ulauncher / Newelle: reinstall the app itself; only their configs are in this bundle
  - the WhiteSur GTK theme: ~/WhiteSur-gtk-theme holds the upstream source clone
MANUAL

if (( ! APPLY )); then
  printf '\n\033[1;33mDRY RUN complete\033[0m - re-run with --apply to make these changes.\n'
fi
