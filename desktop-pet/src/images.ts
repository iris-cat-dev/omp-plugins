import { lstat, readFile } from "node:fs/promises";
import sharp from "sharp";
import { MAX_PET_IMAGE_BYTES } from "./manifest.js";
import type { PetLibraryOptions } from "./library.js";

const imageOptions = { limitInputPixels: 4096 * 4096 };

export async function convertPetImage(imagePath: string): Promise<Buffer> {
  const info = await lstat(imagePath);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_PET_IMAGE_BYTES) {
    throw new TypeError("Generated pet image must be a regular file no larger than 20 MiB.");
  }
  const image = sharp(await readFile(imagePath), imageOptions);
  const metadata = await image.metadata();
  if (!["png", "jpeg", "webp"].includes(metadata.format ?? "")) {
    throw new TypeError("Generated pet image must be PNG, JPEG, or WebP.");
  }
  if (!metadata.width || !metadata.height || metadata.width > 4096 || metadata.height > 4096) {
    throw new TypeError("Generated pet image must fit a 4096 × 4096 image.");
  }
  const { data, info: pixels } = await image.toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let transparent = false;
  for (let index = 3; index < data.length; index += 4) {
    if (data[index] < 255) { transparent = true; break; }
  }
  // Transparent artwork can contain green characters. Key only opaque atlases;
  // tolerate JPEG/WebP compression around the requested flat #00FF00 background.
  if (!transparent) {
    for (let index = 0; index < data.length; index += 4) {
      if (data[index] < 90 && data[index + 1] > 160 && data[index + 2] < 90) {
        data[index + 3] = 0;
      }
    }
  }
  return sharp(data, { raw: { width: pixels.width, height: pixels.height, channels: 4 } }).png().toBuffer();
}

export const decodePetImage: PetLibraryOptions["decodeImage"] = async (data, crop) => {
  const image = sharp(data, imageOptions);
  const { data: bitmap, info } = await image.toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const preview = await image.extract({ left: crop.x, top: crop.y, width: crop.width, height: crop.height }).png().toBuffer();
  return { width: info.width, height: info.height, bitmap, preview };
};
