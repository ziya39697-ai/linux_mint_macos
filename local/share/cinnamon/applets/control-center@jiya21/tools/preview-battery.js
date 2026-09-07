/*
 * Renders the panel battery glyph in several states to a PNG, without
 * Cinnamon:   cjs tools/preview-battery.js out.png [scale]
 * Dark panel colour behind white label colour, like WhiteSur-Dark.
 */
const Cairo = imports.cairo;
const GLib  = imports.gi.GLib;

let here = GLib.path_get_dirname(imports.system.programInvocationName);
imports.searchPath.unshift(here + "/../lib");
const Draw = imports.batteryGlyph;

const [out, scaleArg] = ARGV;
const scale = parseInt(scaleArg || "8");
const H = 16 * scale, W = Math.round(H * Draw.BATTERY_ASPECT);
const PAD = 6 * scale;

const states = [
    { pct: 100, ac: false, lp: false, show: true  },
    { pct: 74,  ac: false, lp: false, show: true  },
    { pct: 49,  ac: true,  lp: false, show: true  },
    { pct: 20,  ac: false, lp: false, show: true  },
    { pct: 8,   ac: false, lp: false, show: true  },
    { pct: 55,  ac: false, lp: true,  show: true  },
    { pct: 100, ac: true,  lp: false, show: true  },
    { pct: 74,  ac: false, lp: false, show: false },
    { pct: 49,  ac: true,  lp: false, show: false },
];

let surf = new Cairo.ImageSurface(Cairo.Format.ARGB32,
                                  W + 2 * PAD, states.length * (H + PAD) + PAD);
let cr = new Cairo.Context(surf);
cr.setSourceRGB(30 / 255, 30 / 255, 32 / 255);
cr.paint();

states.forEach((s, i) => {
    /* draw into a group so the bolt's CLEAR only clears the glyph, as it
     * would on the DrawingArea's own transparent surface */
    cr.save();
    cr.translate(PAD, PAD + i * (H + PAD));
    cr.pushGroup();
    Draw.drawBattery(cr, W, H, [1, 1, 1], scale, s.pct, s.ac, s.lp, s.show);
    cr.popGroupToSource();
    cr.paint();
    cr.restore();
});

surf.writeToPNG(out);
print("wrote " + out);
