import { dHash, HASH_H, HASH_W, THUMB, type Fingerprint } from '../../lib/dupes';
import { canvas, decode } from './process';

/** Intermediate size: big enough to average out detail before the 9×8 reduction. */
const MID = 64;

/**
 * Perceptual fingerprint of an encoded image, plus its real pixel size.
 * Transparent areas are composited on white so a logo on transparency and
 * the same logo on white compare equal.
 */
export async function fingerprint(bytes: Uint8Array, mime: string): Promise<{ fp: Fingerprint; width: number; height: number }> {
  const dec = await decode(bytes, mime);
  try {
    const [mid, mctx] = canvas(MID, MID);
    mctx.fillStyle = '#fff';
    mctx.fillRect(0, 0, MID, MID);
    mctx.drawImage(dec.source, 0, 0, MID, MID);
    const px = mctx.getImageData(0, 0, MID, MID).data;
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < px.length; i += 4) {
      r += px[i];
      g += px[i + 1];
      b += px[i + 2];
    }
    const n = MID * MID;

    const [, sctx] = canvas(HASH_W, HASH_H);
    sctx.drawImage(mid, 0, 0, HASH_W, HASH_H);
    const small = sctx.getImageData(0, 0, HASH_W, HASH_H).data;
    const gray = new Float32Array(HASH_W * HASH_H);
    for (let i = 0; i < gray.length; i++) gray[i] = 0.299 * small[i * 4] + 0.587 * small[i * 4 + 1] + 0.114 * small[i * 4 + 2];

    const [, tctx] = canvas(THUMB, THUMB);
    tctx.drawImage(mid, 0, 0, THUMB, THUMB);
    const tpx = tctx.getImageData(0, 0, THUMB, THUMB).data;
    const thumb: number[] = [];
    for (let i = 0; i < tpx.length; i += 4) thumb.push(tpx[i], tpx[i + 1], tpx[i + 2]);

    return {
      fp: { hash: dHash(gray), aspect: dec.width / Math.max(1, dec.height), color: [r / n, g / n, b / n], thumb },
      width: dec.width,
      height: dec.height,
    };
  } finally {
    dec.close();
  }
}
