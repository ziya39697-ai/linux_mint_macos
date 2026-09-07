#!/usr/bin/python3
"""
Golden Gate lock screen: runs the stock cinnamon-screensaver with a few
patched modules (overlay/) placed ahead of /usr/share/cinnamon-screensaver
on sys.path.

Safety first: the lock screen must never fail to appear.  Every overlay
module is imported up front; if any of them raises (for example after a
cinnamon-screensaver upgrade changed something they depend on), the overlay
is dropped and the unmodified screensaver runs instead.
"""
import importlib
import os
import runpy
import sys
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))
OVERLAY = os.path.join(HERE, "overlay")
SYSTEM = "/usr/share/cinnamon-screensaver"
MAIN = os.path.join(SYSTEM, "cinnamon-screensaver-main.py")
MODULES = ("monitorView", "clock", "unlock", "stage")

sys.path[:0] = [OVERLAY, SYSTEM]
os.chdir(SYSTEM)

try:
    for name in MODULES:
        mod = importlib.import_module(name)
        if not os.path.abspath(mod.__file__).startswith(OVERLAY):
            raise ImportError("%s resolved to %s, not the overlay" % (name, mod.__file__))
    print("Golden Gate lock screen: overlay active (%s)" % OVERLAY, flush=True)
except Exception:
    print("Golden Gate lock screen: overlay FAILED, using stock cinnamon-screensaver", flush=True)
    traceback.print_exc()
    for name in list(sys.modules):
        m = sys.modules[name]
        f = getattr(m, "__file__", None) or ""
        if f.startswith(OVERLAY) or f.startswith(SYSTEM):
            del sys.modules[name]
    sys.path.remove(OVERLAY)

runpy.run_path(MAIN, run_name="__main__")
