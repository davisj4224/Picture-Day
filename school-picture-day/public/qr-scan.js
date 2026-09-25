/* Reads each photo in the browser before it is uploaded: looks for a QR
   card and makes a small preview image, so the server never needs image
   libraries and the upload stays a plain file transfer.

   Detection order:
     1. The browser's built-in BarcodeDetector (Chrome, Edge, Android).
     2. jsQR — loaded from /assets/vendor/jsQR.js if you have vendored it,
        otherwise from a CDN. See README for working fully offline. */

let detector = null;
let jsQR = null;
let readyPromise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.appendChild(s);
  });
}

async function prepare() {
  if ('BarcodeDetector' in window) {
    try {
      const formats = await window.BarcodeDetector.getSupportedFormats();
      if (formats.includes('qr_code')) {
        detector = new window.BarcodeDetector({ formats: ['qr_code'] });
        return 'BarcodeDetector';
      }
    } catch {
      /* fall through to jsQR */
    }
  }
  try {
    await loadScript('/assets/vendor/jsQR.js');
  } catch {
    await loadScript('https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js');
  }
  jsQR = window.jsQR;
  if (!jsQR) throw new Error('No QR reader is available in this browser.');
  return 'jsQR';
}

export function ready() {
  if (!readyPromise) readyPromise = prepare();
  return readyPromise;
}

function drawTo(bitmap, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, w, h);
  return { canvas, ctx, w, h };
}

async function detect(bitmap, maxSide) {
  const { canvas, ctx, w, h } = drawTo(bitmap, maxSide);
  if (detector) {
    const found = await detector.detect(canvas).catch(() => []);
    if (found && found.length) return found[0].rawValue;
    return null;
  }
  const data = ctx.getImageData(0, 0, w, h);
  const result = jsQR(data.data, w, h, { inversionAttempts: 'attemptBoth' });
  return result ? result.data : null;
}

function toBlob(canvas, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}

/** Returns { qr, thumb, capturedAt } for one image file. */
export async function scan(file) {
  await ready();
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    bitmap = await createImageBitmap(file);
  }

  let qr = null;
  for (const side of [1400, 800, 2000]) {
    qr = await detect(bitmap, side);
    if (qr) break;
  }

  const { canvas } = drawTo(bitmap, 520);
  const thumb = await toBlob(canvas, 0.72);
  bitmap.close?.();

  return { qr, thumb, capturedAt: file.lastModified || Date.now() };
}
