import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { convertPetImage, decodePetImage } from "./images.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function imagePath(extension: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "omp-pet-image-"));
  roots.push(root);
  return path.join(root, `generated.${extension}`);
}

describe("pet image conversion", () => {
  it.each(["png", "jpeg", "webp"] as const)("removes opaque chroma-key backgrounds from %s without resizing artwork", async (format) => {
    const input = await imagePath(format);
    await sharp({ create: { width: 64, height: 64, channels: 3, background: "#00FF00" } })
      .composite([{ input: await sharp({ create: { width: 32, height: 32, channels: 3, background: "#FF0000" } }).png().toBuffer(), left: 16, top: 16 }])
      .toFormat(format).toFile(input);
    const converted = await convertPetImage(input);
    const decoded = await decodePetImage(converted, { x: 16, y: 16, width: 32, height: 32 });
    expect([decoded.width, decoded.height]).toEqual([64, 64]);
    expect(decoded.bitmap[3]).toBe(0);
    const center = (32 * 64 + 32) * 4;
    expect(decoded.bitmap[center]).toBeGreaterThan(240);
    expect(decoded.bitmap[center + 3]).toBe(255);
    expect(await sharp(decoded.preview).metadata()).toMatchObject({ width: 32, height: 32, format: "png" });
  });

  it("preserves a green character when the source already has transparency", async () => {
    const input = await imagePath("png");
    await sharp({ create: { width: 16, height: 16, channels: 4, background: { r: 0, g: 255, b: 0, alpha: 1 } } })
      .extend({ top: 1, bottom: 1, left: 1, right: 1, background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toFile(input);
    const converted = await convertPetImage(input);
    const { data } = await sharp(converted).raw().toBuffer({ resolveWithObject: true });
    expect(data[3]).toBe(0);
    expect([...data.subarray((9 * 18 + 9) * 4, (9 * 18 + 9) * 4 + 4)]).toEqual([0, 255, 0, 255]);
  });

  it("decodes grayscale artwork into RGBA instead of interpreting luminance as alpha", async () => {
    const input = await imagePath("png");
    await sharp(Buffer.alloc(16 * 16, 128), { raw: { width: 16, height: 16, channels: 1 } }).toColourspace("b-w").png().toFile(input);
    const converted = await convertPetImage(input);
    const decoded = await decodePetImage(converted, { x: 0, y: 0, width: 16, height: 16 });
    expect([...decoded.bitmap.subarray(0, 4)]).toEqual([128, 128, 128, 255]);
  });
});
