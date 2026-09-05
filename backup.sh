#!/usr/bin/env bash
# Capture this machine's Cinnamon desktop customization into the bundle this
# script lives in. Read-only with respect to the live system: it only ever
# copies OUT. Safe to re-run at any time; re-running refreshes the bundle.
#
#   ./backup.sh              refresh the bundle and git-commit if anything changed
#   ./backup.sh --no-commit  refresh only, leave the commit to you
#
set -euo pipefail

BUNDLE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMMIT=1
[[ "${1:-}" == "--no-commit" ]] && COMMIT=0

say()  { printf '  %s\n' "$*"; }
head_() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

# Refuse to run against someone else's home by accident.
if [[ ! -d "$HOME/.config/cinnamon" ]]; then
  echo "error: no ~/.config/cinnamon - is this a Cinnamon desktop?" >&2
  exit 1
fi

# ---------------------------------------------------------------- dconf
# Cinnamon last in the restore, but dumped here in a stable order.
head_ "dconf"
dump() {
  local path="$1" out="$BUNDLE/dconf/$2.dconf"
  dconf dump "$path" > "$out"
  say "$(printf '%-22s' "$2") $(wc -l < "$out") lines"
}
dump /org/cinnamon/            cinnamon
dump /net/launchpad/plank/     plank
dump /org/nemo/                nemo
dump /org/gnome/desktop/       gnome-desktop
dump /org/x/                   x-apps
dump /org/gtk/                 gtk
dump /com/linuxmint/           linuxmint

# ---------------------------------------------------------------- config files
head_ "config"
CFG="$BUNDLE/config"
rm -rf "$CFG"; mkdir -p "$CFG"

# Applet settings (menu icon, calendar format, ...) - keep the tree shape.
mkdir -p "$CFG/cinnamon"
rsync -a --delete "$HOME/.config/cinnamon/spices" "$CFG/cinnamon/"
say "cinnamon/spices ($(find "$CFG/cinnamon/spices" -name '*.json' | wc -l) applet settings files)"

cp -a "$HOME/.config/cinnamon-monitors.xml" "$CFG/" 2>/dev/null && say "cinnamon-monitors.xml"

mkdir -p "$CFG/plank/dock1"
rsync -a --delete "$HOME/.config/plank/dock1/launchers" "$CFG/plank/dock1/"
say "plank launchers ($(ls "$CFG/plank/dock1/launchers" | wc -l) dockitems)"

mkdir -p "$CFG/launchpad"
cp -a "$HOME/.config/launchpad/layout.json" "$CFG/launchpad/" 2>/dev/null && say "launchpad/layout.json"

mkdir -p "$CFG/autostart"
cp -a "$HOME"/.config/autostart/*.desktop "$CFG/autostart/" 2>/dev/null && \
  say "autostart ($(ls "$CFG/autostart" | wc -l) entries)"

mkdir -p "$CFG/gtk-3.0"
cp -a "$HOME/.config/gtk-3.0/bookmarks" "$CFG/gtk-3.0/" 2>/dev/null && say "gtk-3.0/bookmarks"
cp -a "$HOME/.config/mimeapps.list"     "$CFG/mimeapps.list" 2>/dev/null && say "mimeapps.list"
cp -a "$HOME/.conkyrc"                  "$CFG/conkyrc"       2>/dev/null && say "conkyrc"
cp -a "$HOME/.gitconfig"                "$CFG/gitconfig"     2>/dev/null && say "gitconfig"

# Only the lines this user appended to the stock skel bashrc - never the whole
# file, so a future Mint's skel changes are not clobbered on restore.
if [[ -f /etc/skel/.bashrc ]]; then
  diff --changed-group-format='%>' --unchanged-group-format='' \
       /etc/skel/.bashrc "$HOME/.bashrc" > "$CFG/bashrc.delta" || true
  say "bashrc.delta ($(wc -l < "$CFG/bashrc.delta") lines appended vs /etc/skel)"
fi

# ---------------------------------------------------------------- local/
head_ "local"
install -m 755 "$HOME/.local/bin/launchpad" "$BUNDLE/local/bin/launchpad"
say "bin/launchpad ($(wc -l < "$BUNDLE/local/bin/launchpad") lines, mode 755)"

rm -rf "$BUNDLE/local/share/applications"; mkdir -p "$BUNDLE/local/share/applications"
cp -a "$HOME"/.local/share/applications/*.desktop "$BUNDLE/local/share/applications/" 2>/dev/null || true
say "share/applications ($(ls "$BUNDLE/local/share/applications" | wc -l) .desktop files)"

rm -rf "$BUNDLE/local/share/plank"; mkdir -p "$BUNDLE/local/share/plank"
rsync -a "$HOME/.local/share/plank/themes" "$BUNDLE/local/share/plank/"
say "share/plank/themes ($(ls "$BUNDLE/local/share/plank/themes" | tr '\n' ' '))"

# Cinnamon extensions (Blur Cinnamon et al). This tree was empty at the first
# audit, so the section did not exist then; without it the blur setup would be
# silently uncovered. The matching *settings* live under config/cinnamon/spices/
# and are already captured by the rsync above.
rm -rf "$BUNDLE/local/share/cinnamon"; mkdir -p "$BUNDLE/local/share/cinnamon"
if [[ -d "$HOME/.local/share/cinnamon/extensions" ]]; then
  rsync -a --exclude '__pycache__' \
    "$HOME/.local/share/cinnamon/extensions" "$BUNDLE/local/share/cinnamon/"
  say "share/cinnamon/extensions ($(ls "$BUNDLE/local/share/cinnamon/extensions" | wc -l) installed)"
fi

# ---------------------------------------------------------------- add-on apps
# Ulauncher (Spotlight), Newelle (AI assistant), Toshy (Mac keybindings).
# Each is skipped silently when absent, so this stays correct on a machine where
# only some of them exist.
head_ "add-on app configs"
APPS="$BUNDLE/apps"
rm -rf "$APPS"; mkdir -p "$APPS"

if [[ -d "$HOME/.config/ulauncher" ]]; then
  rsync -a --exclude 'cache' --exclude '*.log' "$HOME/.config/ulauncher" "$APPS/"
  say "ulauncher (settings, shortcuts, extensions, theme)"
fi

# Newelle keeps GSettings inside the flatpak's own config tree. Take only the
# keyfile - never the whole app dir, which holds caches and chat history.
NEWELLE_KF="$HOME/.var/app/io.github.qwersyk.Newelle/config/glib-2.0/settings/keyfile"
if [[ -f "$NEWELLE_KF" ]]; then
  mkdir -p "$APPS/newelle"
  cp -a "$NEWELLE_KF" "$APPS/newelle/keyfile"
  # Guard: an API key here would land in a public repo. Strip it and say so.
  if grep -qiE 'api[_-]?key|secret|token' "$APPS/newelle/keyfile"; then
    sed -i -E "s/^(.*(api[_-]?key|secret|token).*=).*/\1'<REDACTED>'/I" "$APPS/newelle/keyfile"
    say "newelle (keyfile - CREDENTIAL REDACTED)"
  else
    say "newelle (keyfile, no credentials present)"
  fi
fi

if [[ -d "$HOME/.config/toshy" ]]; then
  rsync -a --exclude '*.log' "$HOME/.config/toshy" "$APPS/"
  say "toshy (Mac-style keybinding config)"
fi

# Flatpak inventory, so restore knows what to reinstall.
if command -v flatpak >/dev/null 2>&1; then
  flatpak list --user   --columns=application,branch --app 2>/dev/null > "$APPS/flatpaks-user.txt"   || true
  flatpak list --system --columns=application,branch --app 2>/dev/null > "$APPS/flatpaks-system.txt" || true
  say "flatpak inventory ($(cat "$APPS"/flatpaks-*.txt 2>/dev/null | grep -c .) apps)"
fi

# ---------------------------------------------------------------- assets
# The wallpaper and the panel menu icon. Resolved from live dconf so this keeps
# working after the paths are moved off ~/Downloads.
head_ "assets"
wp_uri="$(dconf read /org/cinnamon/desktop/background/picture-uri | tr -d "'")"
wp_path="$(python3 -c "import sys,urllib.parse as u;p=u.urlparse(sys.argv[1]);print(u.unquote(p.path))" "$wp_uri")"
rm -f "$BUNDLE"/assets/wallpaper.*
if [[ -f "$wp_path" ]]; then
  cp -a "$wp_path" "$BUNDLE/assets/wallpaper.${wp_path##*.}"
  say "wallpaper  <- $wp_path"
else
  say "WARNING: wallpaper not found at $wp_path"
fi

menu_json="$HOME/.config/cinnamon/spices/menu@cinnamon.org/0.json"
menu_icon="$(python3 -c "
import json,sys
try: print(json.load(open(sys.argv[1]))['menu-icon']['value'])
except Exception: print('')
" "$menu_json" 2>/dev/null || true)"
# Older/newer schema versions name the key differently - fall back to a scan.
[[ -z "$menu_icon" ]] && menu_icon="$(python3 -c "
import json,sys
d=json.load(open(sys.argv[1]))
for k,v in d.items():
    if isinstance(v,dict) and v.get('description')=='Icon': print(v.get('value','')); break
" "$menu_json" 2>/dev/null || true)"
rm -f "$BUNDLE"/assets/menu-icon.*
if [[ -f "$menu_icon" ]]; then
  cp -a "$menu_icon" "$BUNDLE/assets/menu-icon.${menu_icon##*.}"
  say "menu-icon  <- $menu_icon"
else
  say "menu icon is a named theme icon ('${menu_icon:-unset}') - nothing to copy"
fi

# ---------------------------------------------------------------- themes + icons
head_ "themes + icons (this is the slow part)"
rsync -a --delete "$HOME/.themes/" "$BUNDLE/themes/"
say "themes  $(du -sh "$BUNDLE/themes" | cut -f1)  ($(ls "$BUNDLE/themes" | tr '\n' ' '))"

rsync -a --delete \
  --exclude '.git' --exclude '__pycache__' \
  "$HOME/.local/share/icons/" "$BUNDLE/icons/"
# The ~/.icons/default cursor stub lives at a different path than the
# ~/.local/share/icons one; keep it separately so restore can place both.
mkdir -p "$BUNDLE/icons/.dot-icons"
rsync -a --delete "$HOME/.icons/" "$BUNDLE/icons/.dot-icons/" 2>/dev/null || true
say "icons   $(du -sh "$BUNDLE/icons" | cut -f1)  ($(ls "$BUNDLE/icons" | tr '\n' ' '))"

# ---------------------------------------------------------------- packages
head_ "packages"
PKG="$BUNDLE/packages"
# Mint records exactly what the user chose to install, which is far more useful
# than diffing 2600 packages against the install baseline.
dconf read /com/linuxmint/install/installed-apps \
  | tr ',' '\n' | grep -o "apt:[a-z0-9._+-]*" | sed 's/^apt://' | sort -u \
  > "$PKG/intentional.txt"
say "intentional.txt   $(wc -l < "$PKG/intentional.txt") packages"

apt-mark showmanual 2>/dev/null | sort -u > "$PKG/manual-full.txt"
say "manual-full.txt   $(wc -l < "$PKG/manual-full.txt") packages (reference only)"

if [[ -f /var/log/installer/initial-status.gz ]]; then
  zcat /var/log/installer/initial-status.gz | awk '/^Package: /{print $2}' | sort -u \
    > "$PKG/.baseline.tmp"
  dpkg-query -W -f='${Package}\n' | sort -u > "$PKG/.current.tmp"
  comm -13 "$PKG/.baseline.tmp" "$PKG/.current.tmp" > "$PKG/added-since-install.txt"
  rm -f "$PKG/.baseline.tmp" "$PKG/.current.tmp"
  say "added-since-install.txt   $(wc -l < "$PKG/added-since-install.txt") (incl. dependencies)"
fi

rsync -a --delete /etc/apt/sources.list.d/ "$PKG/sources.list.d/" 2>/dev/null || true
say "sources.list.d    $(ls "$PKG/sources.list.d" | wc -l) repo files"

# ---------------------------------------------------------------- manifest
head_ "manifest"
python3 - "$BUNDLE" <<'PY'
import hashlib, json, os, subprocess, sys, time

bundle = sys.argv[1]
SKIP_TOP = {"icons", ".git"}          # summarised, not checksummed

def sh(*cmd):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, check=True).stdout.strip()
    except Exception:
        return None

def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()

# Checksum everything except the icon themes and git internals. The icon set is
# ~100k small files; hashing it would dominate the runtime for little benefit,
# so it is summarised by file count and total size instead.
sums = {}
for entry in sorted(os.listdir(bundle)):
    if entry in SKIP_TOP:
        continue
    full = os.path.join(bundle, entry)
    if os.path.isfile(full):
        if entry != "manifest.json":
            sums[entry] = sha256(full)
        continue
    for root, _dirs, files in os.walk(full):
        for f in files:
            path = os.path.join(root, f)
            if os.path.islink(path):
                continue
            sums[os.path.relpath(path, bundle)] = sha256(path)

icon_files = icon_bytes = 0
for root, _dirs, files in os.walk(os.path.join(bundle, "icons")):
    for f in files:
        path = os.path.join(root, f)
        icon_files += 1
        if not os.path.islink(path):
            icon_bytes += os.path.getsize(path)

manifest = {
    "generated":     time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    "hostname":      sh("hostname"),
    "user":          os.environ.get("USER"),
    "distro":        sh("lsb_release", "-ds"),
    "cinnamon":      sh("cinnamon", "--version"),
    "kernel":        sh("uname", "-r"),
    "session_type":  os.environ.get("XDG_SESSION_TYPE"),
    "icons_summary": {"files": icon_files, "bytes": icon_bytes},
    "files":         dict(sorted(sums.items())),
}
with open(os.path.join(bundle, "manifest.json"), "w") as fh:
    json.dump(manifest, fh, indent=2)
    fh.write("\n")
print(f"  {len(sums)} files checksummed; icons/ summarised as "
      f"{icon_files} files / {icon_bytes // (1 << 20)} MiB")
PY

# ---------------------------------------------------------------- commit
head_ "done"
say "bundle size: $(du -sh "$BUNDLE" --exclude=.git | cut -f1)"
if (( COMMIT )) && git -C "$BUNDLE" rev-parse --git-dir >/dev/null 2>&1; then
  git -C "$BUNDLE" add -A
  if git -C "$BUNDLE" diff --cached --quiet; then
    say "git: no changes since last backup"
  else
    # Use the configured git identity so commits attribute correctly on a
    # remote; fall back to a placeholder only if git has no identity at all.
    if git -C "$BUNDLE" config user.email >/dev/null 2>&1; then
      git -C "$BUNDLE" commit -q -m "backup $(date '+%Y-%m-%d %H:%M')"
    else
      git -C "$BUNDLE" -c user.name="desktop-backup" -c user.email="backup@localhost" \
          commit -q -m "backup $(date '+%Y-%m-%d %H:%M')"
    fi
    say "git: committed $(git -C "$BUNDLE" rev-parse --short HEAD)"
  fi
fi
