import { lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PetLibrary } from "./library.js";
import {
  MAX_PET_MANIFEST_BYTES,
  parsePetManifest,
  validatePetSheet,
} from "./manifest.js";

export interface PetInstallOptions {
  manifestPath: string;
  inputImage?: string;
  convertImage(path: string): Promise<Buffer>;
  library: PetLibrary;
}

export async function installPetPackage(options: PetInstallOptions) {
  const manifestPath = path.resolve(options.manifestPath);
  const info = await lstat(manifestPath);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_PET_MANIFEST_BYTES) {
    throw new TypeError("pet.json must be a regular file no larger than 64 KiB.");
  }
  const manifest = parsePetManifest(JSON.parse(await readFile(manifestPath, "utf8")) as unknown);
  if (options.inputImage !== undefined && !manifest.bubble) {
    throw new TypeError(
      "New pet image authoring requires a complete bubble profile in pet.json (appearance and all eight state rules). Start a new 'Create with OMP' workspace for the updated hatch-pet instructions; existing artwork can be reused.",
    );
  }
  if (options.inputImage !== undefined) {
    const spritePath = path.join(path.dirname(manifestPath), manifest.spritesheet);
    try {
      if ((await lstat(spritePath)).isSymbolicLink())
        throw new TypeError("Cannot replace a symbolic-link spritesheet.");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const data = await options.convertImage(path.resolve(options.inputImage));
    validatePetSheet(data, manifest);
    await writeFile(spritePath, data);
  }
  return options.library.importDirectory(path.dirname(manifestPath));
}
