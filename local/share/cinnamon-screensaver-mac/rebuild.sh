#!/bin/sh
# Re-create overlay/ from the currently installed cinnamon-screensaver and
# re-apply the Golden Gate patches.  Run after a cinnamon-screensaver upgrade.
set -e
B="$(cd "$(dirname "$0")" && pwd)"
S=/usr/share/cinnamon-screensaver
for f in stage.py clock.py unlock.py monitorView.py; do cp "$S/$f" "$B/overlay/$f"; done
# widgets/ is a package, so the overlay must carry all of it; only powerWidget.py is patched.
rm -rf "$B/overlay/widgets"; mkdir -p "$B/overlay/widgets"
cp "$S"/widgets/*.py "$B/overlay/widgets/"
python3 "$B/patches/apply.py"
for f in stage clock unlock monitorView widgets/powerWidget; do
    python3 -m py_compile "$B/overlay/$f.py"
    diff -u "$S/$f.py" "$B/overlay/$f.py" > "$B/patches/$(basename $f).diff" || true
done
echo "overlay rebuilt"
