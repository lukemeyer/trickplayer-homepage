/**
 * Display simulators and dithering pipelines.
 * Ported from trickplayer-g2/src/pixels.ts and trickplayer-pebble/src/pkjs/render.js.
 */

const STEP = 17;
const LEVELS = 15;
const clampLevel = (v) => (v < 0 ? 0 : v > LEVELS ? LEVELS : v);

/**
 * Luminance calculation, tone adjustment, and 16-level quantization.
 * Returns Float32Array with values in 0..255 snapped to steps of 17.
 */
export function quantisePlane(rgbaData, w, h, opts = {}) {
  const brightness = opts.brightness ?? 0;
  const contrast = opts.contrast ?? 0;
  const gamma = opts.gamma ?? 1;
  const dither = opts.dither ?? "floyd-steinberg";

  const n = w * h;
  const gray = new Float32Array(n);
  const contrastFactor = (259 * (contrast + 255)) / (255 * (259 - contrast));
  const applyGamma = gamma !== 1;
  const invGamma = 1 / gamma;

  for (let i = 0; i < n; i++) {
    const o = i << 2;
    let v = 0.299 * rgbaData[o] + 0.587 * rgbaData[o + 1] + 0.114 * rgbaData[o + 2];
    v += brightness;
    v = contrastFactor * (v - 128) + 128;
    if (applyGamma) v = 255 * Math.pow(v < 0 ? 0 : v / 255, invGamma);
    gray[i] = v < 0 ? 0 : v > 255 ? 255 : v;
  }

  if (dither === "floyd-steinberg") {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        const oldVal = gray[idx];
        const newVal = clampLevel(Math.round(oldVal / STEP)) * STEP;
        gray[idx] = newVal;
        const err = oldVal - newVal;
        if (x + 1 < w) gray[idx + 1] += (err * 7) / 16;
        if (y + 1 < h) {
          if (x > 0) gray[idx + w - 1] += (err * 3) / 16;
          gray[idx + w] += (err * 5) / 16;
          if (x + 1 < w) gray[idx + w + 1] += err / 16;
        }
      }
    }
  } else if (dither === "atkinson") {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        const oldVal = gray[idx];
        const newVal = clampLevel(Math.round(oldVal / STEP)) * STEP;
        gray[idx] = newVal;
        const err = (oldVal - newVal) / 8;
        if (x + 1 < w) gray[idx + 1] += err;
        if (x + 2 < w) gray[idx + 2] += err;
        if (y + 1 < h) {
          if (x > 0) gray[idx + w - 1] += err;
          gray[idx + w] += err;
          if (x + 1 < w) gray[idx + w + 1] += err;
        }
        if (y + 2 < h) gray[idx + 2 * w] += err;
      }
    }
  } else {
    // Plain threshold / nearest 16-level step
    for (let i = 0; i < n; i++) {
      gray[i] = clampLevel(Math.round(gray[i] / STEP)) * STEP;
    }
  }

  return gray;
}

/**
 * Pebble Time 2: 64-color panel simulation (2 bits per RGB channel).
 * Snap to 0, 85, 170, 255 with Floyd-Steinberg dithering.
 */
export function ditherPebble64(rgbaData, w, h) {
  const snap = (v) => {
    const l = Math.round((v * 3) / 255);
    return Math.max(0, Math.min(3, l)) * 85;
  };

  const r = new Float32Array(w * h);
  const g = new Float32Array(w * h);
  const b = new Float32Array(w * h);

  for (let i = 0; i < w * h; i++) {
    const o = i << 2;
    r[i] = rgbaData[o];
    g[i] = rgbaData[o + 1];
    b[i] = rgbaData[o + 2];
  }

  const out = new Uint8ClampedArray(w * h * 4);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      const oldR = r[idx], oldG = g[idx], oldB = b[idx];
      const newR = snap(oldR), newG = snap(oldG), newB = snap(oldB);

      const errR = oldR - newR;
      const errG = oldG - newG;
      const errB = oldB - newB;

      const o = idx << 2;
      out[o] = newR;
      out[o + 1] = newG;
      out[o + 2] = newB;
      out[o + 3] = 255;

      if (x + 1 < w) {
        r[idx + 1] += (errR * 7) / 16;
        g[idx + 1] += (errG * 7) / 16;
        b[idx + 1] += (errB * 7) / 16;
      }
      if (y + 1 < h) {
        if (x > 0) {
          r[idx + w - 1] += (errR * 3) / 16;
          g[idx + w - 1] += (errG * 3) / 16;
          b[idx + w - 1] += (errB * 3) / 16;
        }
        r[idx + w] += (errR * 5) / 16;
        g[idx + w] += (errG * 5) / 16;
        b[idx + w] += (errB * 5) / 16;
        if (x + 1 < w) {
          r[idx + w + 1] += errR / 16;
          g[idx + w + 1] += errG / 16;
          b[idx + w + 1] += errB / 16;
        }
      }
    }
  }

  return out;
}

/**
 * Draws an Image onto targetCanvas using the specified platform mode.
 * @param {HTMLImageElement} img
 * @param {HTMLCanvasElement} canvas
 * @param {string} mode "g2" | "pebble" | "wearos"
 * @param {object} opts Picture options (contrast, brightness, gamma, dither)
 */
export function renderFrameToCanvas(img, canvas, mode = "g2", opts = {}) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const w = canvas.width;
  const h = canvas.height;

  // Draw source image scaled to canvas
  ctx.drawImage(img, 0, 0, w, h);

  if (mode === "wearos") {
    // Wear OS uses native full color 24-bit/32-bit image untouched
    return;
  }

  const imgData = ctx.getImageData(0, 0, w, h);
  const data = imgData.data;

  if (mode === "g2") {
    // Even Realities G2: 16 shades of monochrome green phosphor
    const grayPlane = quantisePlane(data, w, h, opts);
    for (let i = 0; i < w * h; i++) {
      const v = grayPlane[i];
      const o = i << 2;
      // Authentic green waveguide appearance:
      // High green channel, slight red/blue tint for phosphor realism
      data[o] = Math.round(v * 0.08);       // minimal red
      data[o + 1] = Math.round(v);          // vibrant green
      data[o + 2] = Math.round(v * 0.22);    // slight blue/cyan phosphor hint
      data[o + 3] = 255;
    }
    ctx.putImageData(imgData, 0, 0);
  } else if (mode === "pebble") {
    // Pebble Time 2: 64-color panel with Floyd-Steinberg dither
    const pebblePixels = ditherPebble64(data, w, h);
    imgData.data.set(pebblePixels);
    ctx.putImageData(imgData, 0, 0);
  }
}
