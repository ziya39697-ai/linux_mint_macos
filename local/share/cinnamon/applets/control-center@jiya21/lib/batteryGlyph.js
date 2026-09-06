/*
 * Cairo drawing for the panel battery glyph, kept free of St/Clutter so the
 * same code renders under plain cjs for previewing (see README).
 *
 * `var` and `function` on purpose: Cinnamon's require() exports every
 * top-level declaration, but GJS's legacy `imports.<module>` used by the
 * preview script only sees `var` and `function`.
 *
 * Geometry follows the macOS menu bar battery: a ≈2:1 body whose frame and
 * nub are painted at reduced opacity in the label colour, a solid fill that
 * tracks the exact percentage, a bolt knocked out of the fill on AC, red at
 * or under LOW_PCT, yellow in Low Power Mode.
 */

var BATTERY_ASPECT  = 1.625;                 /* area width / height */
var BATTERY_LOW_PCT = 20;
var FRAME_ALPHA     = 0.42;                  /* macOS secondary-label opacity */
var SYSTEM_RED      = [1.00, 0.27, 0.23];    /* #FF453A */
var SYSTEM_YELLOW   = [1.00, 0.84, 0.04];    /* #FFD60A */

/* Normalised bolt outline, x and y in [-0.5, 0.5]. */
var BOLT = [[0.12, -0.5], [-0.5, 0.08], [-0.08, 0.08],
            [-0.12, 0.5], [0.5, -0.08], [0.08, -0.08]];

function roundedRect(cr, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    cr.newSubPath();
    cr.arc(x + w - r, y + r,     r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0,            Math.PI / 2);
    cr.arc(x + r,     y + h - r, r, Math.PI / 2,  Math.PI);
    cr.arc(x + r,     y + r,     r, Math.PI,      3 * Math.PI / 2);
    cr.closePath();
}

/**
 * drawBattery:
 * @cr: cairo context (already cleared to transparent)
 * @W, @H: surface size in device pixels
 * @rgb: [r, g, b] label colour, each 0..1
 * @scale: ui scale factor (1 at 100%)
 * @pct: 0..100
 * @onAC: true while charging / plugged in
 * @lowPower: true while the power-saver profile is active
 */
function drawBattery(cr, W, H, rgb, scale, pct, onAC, lowPower) {
    let [r, g, b] = rgb;
    let lw = 1 * scale;
    pct = Math.max(0, Math.min(100, pct || 0));

    /* Body is 72% of the height, vertically centred; the nub hangs off the
     * right edge with a hairline gap. */
    let bodyH  = H * 0.72;
    let bodyY  = (H - bodyH) / 2;
    let nubW   = 1.75 * scale;
    let nubH   = bodyH * 0.38;
    let bodyX  = lw / 2;
    let bodyW  = W - nubW - lw - 1 * scale;
    let radius = bodyH * 0.28;

    cr.setLineWidth(lw);

    /* frame */
    cr.setSourceRGBA(r, g, b, FRAME_ALPHA);
    roundedRect(cr, bodyX, bodyY, bodyW, bodyH, radius);
    cr.stroke();

    /* nub: flat on the left, rounded on the right */
    let nx = bodyX + bodyW + lw / 2 + 0.5 * scale;
    let ny = bodyY + (bodyH - nubH) / 2;
    let nr = nubW * 0.5;
    cr.newSubPath();
    cr.moveTo(nx, ny);
    cr.lineTo(nx + nubW - nr, ny);
    cr.arc(nx + nubW - nr, ny + nr, nr, -Math.PI / 2, 0);
    cr.lineTo(nx + nubW, ny + nubH - nr);
    cr.arc(nx + nubW - nr, ny + nubH - nr, nr, 0, Math.PI / 2);
    cr.lineTo(nx, ny + nubH);
    cr.closePath();
    cr.fill();

    /* fill */
    let inset = lw + 1 * scale;
    let fx = bodyX + inset, fy = bodyY + inset;
    let fw = bodyW - 2 * inset, fh = bodyH - 2 * inset;
    let w  = fw * pct / 100;
    if (pct > 0) w = Math.max(w, 1.5 * scale);

    if (lowPower)                             cr.setSourceRGBA(SYSTEM_YELLOW[0], SYSTEM_YELLOW[1], SYSTEM_YELLOW[2], 1);
    else if (!onAC && pct <= BATTERY_LOW_PCT) cr.setSourceRGBA(SYSTEM_RED[0], SYSTEM_RED[1], SYSTEM_RED[2], 1);
    else                                      cr.setSourceRGBA(r, g, b, 1);

    if (w > 0) {
        roundedRect(cr, fx, fy, w, fh, Math.max(0.8 * scale, radius - inset));
        cr.fill();
    }

    /* bolt: a cleared halo first so it reads against the fill, then the bolt
     * itself in the label colour */
    if (onAC) {
        let bh = bodyH * 0.78, bw = bh * 0.6;   /* stays inside the frame */
        let cx = bodyX + bodyW / 2, cy = bodyY + bodyH / 2;
        const bolt = (grow) => {
            cr.newSubPath();
            for (let i = 0; i < BOLT.length; i++) {
                let x = cx + BOLT[i][0] * (bw + grow);
                let y = cy + BOLT[i][1] * (bh + grow);
                if (i === 0) cr.moveTo(x, y); else cr.lineTo(x, y);
            }
            cr.closePath();
        };
        cr.save();
        cr.setOperator(imports.cairo.Operator.CLEAR);
        bolt(2.2 * scale);
        cr.fill();
        cr.restore();
        cr.setSourceRGBA(r, g, b, 1);
        bolt(0);
        cr.fill();
    }
}
