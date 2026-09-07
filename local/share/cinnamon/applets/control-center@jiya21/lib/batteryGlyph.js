/*
 * Cairo drawing for the panel battery glyph, kept free of St/Clutter so the
 * same code renders under plain cjs for previewing (see README).
 *
 * `var` and `function` on purpose: Cinnamon's require() exports every
 * top-level declaration, but GJS's legacy `imports.<module>` used by the
 * preview script only sees `var` and `function`.
 *
 * Geometry follows the macOS 27 Golden Gate menu bar battery (the iOS one):
 * a ≈2.3:1 rounded body drawn translucent in the label colour with a small
 * nub, a solid fill from the left that tracks the exact percentage, and -
 * when "show percentage" is on - the number (plus a bolt on AC) inside the
 * body, knocked out of the fill where they overlap and painted in the label
 * colour where they do not.  Red at or under LOW_PCT, yellow in Low Power Mode.
 */

var BATTERY_ASPECT  = 2.25;                  /* area width / height */
var BATTERY_LOW_PCT = 20;
var BODY_ALPHA      = 0.36;                  /* translucent body + nub */
var SYSTEM_RED      = [1.00, 0.27, 0.23];    /* #FF453A */
var SYSTEM_YELLOW   = [1.00, 0.84, 0.04];    /* #FFD60A */
var FONT_FAMILY     = "Inter";

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

function boltPath(cr, cx, cy, bw, bh) {
    cr.newSubPath();
    for (let i = 0; i < BOLT.length; i++) {
        let x = cx + BOLT[i][0] * bw;
        let y = cy + BOLT[i][1] * bh;
        if (i === 0) cr.moveTo(x, y); else cr.lineTo(x, y);
    }
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
 * @showPct: draw the number inside the body (macOS "Show Percentage")
 */
function drawBattery(cr, W, H, rgb, scale, pct, onAC, lowPower, showPct) {
    let [r, g, b] = rgb;
    pct = Math.max(0, Math.min(100, pct || 0));

    /* Body is 74% of the height, vertically centred; the nub hangs off the
     * right edge with a hairline gap. */
    let bodyH  = H * 0.74;
    let bodyY  = (H - bodyH) / 2;
    let nubW   = 1.6 * scale;
    let nubH   = bodyH * 0.40;
    let bodyX  = 0.5 * scale;
    let bodyW  = W - nubW - 1.5 * scale - bodyX;
    let radius = bodyH * 0.30;

    /* translucent body */
    cr.setSourceRGBA(r, g, b, BODY_ALPHA);
    roundedRect(cr, bodyX, bodyY, bodyW, bodyH, radius);
    cr.fill();

    /* nub: flat on the left, rounded on the right */
    let nx = bodyX + bodyW + 0.8 * scale;
    let ny = bodyY + (bodyH - nubH) / 2;
    let nr = nubW * 0.6;
    cr.newSubPath();
    cr.moveTo(nx, ny);
    cr.lineTo(nx + nubW - nr, ny);
    cr.arc(nx + nubW - nr, ny + nr, nr, -Math.PI / 2, 0);
    cr.lineTo(nx + nubW, ny + nubH - nr);
    cr.arc(nx + nubW - nr, ny + nubH - nr, nr, 0, Math.PI / 2);
    cr.lineTo(nx, ny + nubH);
    cr.closePath();
    cr.fill();

    /* solid fill tracking the level, clipped to the body */
    let fillW = bodyW * pct / 100;
    if (pct > 0) fillW = Math.max(fillW, 2 * scale);

    if (lowPower)                             cr.setSourceRGBA(SYSTEM_YELLOW[0], SYSTEM_YELLOW[1], SYSTEM_YELLOW[2], 1);
    else if (!onAC && pct <= BATTERY_LOW_PCT) cr.setSourceRGBA(SYSTEM_RED[0], SYSTEM_RED[1], SYSTEM_RED[2], 1);
    else                                      cr.setSourceRGBA(r, g, b, 1);

    cr.save();
    roundedRect(cr, bodyX, bodyY, bodyW, bodyH, radius);
    cr.clip();
    if (fillW > 0) {
        cr.rectangle(bodyX, bodyY, fillW, bodyH);
        cr.fill();
    }
    cr.restore();

    /* Number (and bolt) inside the body.  Where they sit on the fill they are
     * knocked out (the panel shows through, as on iOS); elsewhere they are
     * painted in the label colour.  Without the percentage only the bolt
     * shows, centred. */
    let text = showPct ? String(Math.round(pct)) : "";
    let fontPx = bodyH * 0.80;
    cr.selectFontFace(FONT_FAMILY, imports.cairo.FontSlant.NORMAL, imports.cairo.FontWeight.BOLD);
    cr.setFontSize(fontPx);
    let ext = text ? cr.textExtents(text) : null;
    let textW = ext ? ext.xAdvance : 0;
    let bh = bodyH * 0.66, bw = bh * 0.56;
    let gap = onAC && text ? 0.8 * scale : 0;
    let totalW = textW + gap + (onAC ? bw : 0);
    if (!text && !onAC) return;

    let x0 = bodyX + (bodyW - totalW) / 2;
    let cy = bodyY + bodyH / 2;

    /* GJS cairo has showText (paints at once) but no textPath, so the glyphs
     * are painted with the current source/operator under a clip. */
    const glyphs = () => {
        if (text) {
            cr.moveTo(x0 - ext.xBearing, cy - (ext.yBearing + ext.height / 2));
            cr.showText(text);
        }
        if (onAC) {
            boltPath(cr, x0 + textW + gap + bw / 2, cy, bw, bh);
            cr.fill();
        }
    };

    /* knock-out over the fill */
    cr.save();
    cr.rectangle(bodyX, bodyY, fillW, bodyH);
    cr.clip();
    cr.setOperator(imports.cairo.Operator.CLEAR);
    glyphs();
    cr.restore();

    /* label colour over the translucent part */
    cr.save();
    cr.rectangle(bodyX + fillW, bodyY, bodyW - fillW, bodyH);
    cr.clip();
    cr.setSourceRGBA(r, g, b, 1);
    glyphs();
    cr.restore();
}
