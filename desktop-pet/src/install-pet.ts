import { fileURLToPath } from "node:url";
import path from "node:path";
import { installPetPackage } from "./creation-cli.js";
import { convertPetImage, decodePetImage } from "./images.js";
import { PetLibrary } from "./library.js";

async function main() {
  const [manifestPath, ...args] = process.argv.slice(2);
  if (!manifestPath || (args.length !== 0 && (args.length !== 2 || args[0] !== "--input-image" || !args[1]))) {
    throw new TypeError("Usage: install-pet.js <pet.json> [--input-image <generated image>]");
  }
  const userDataPath = process.env.OMP_ELECTRON_USER_DATA_DIR;
  if (!userDataPath) throw new Error("Run the install-pet helper from a 'Create with OMP' workspace to select the local pet library.");
  // Both compiled formats live at dist/{cjs,esm}; do not rely on npm self-links.
  const pluginDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const library = new PetLibrary({
    pluginDirectory,
    builtInDirectory: path.join(pluginDirectory, "assets", "pets"),
    userDataPath,
    executablePath: process.execPath,
    decodeImage: decodePetImage,
  });
  const pet = await installPetPackage({ manifestPath, inputImage: args[1], convertImage: convertPetImage, library });
  console.log(JSON.stringify(pet));
}

void main().catch((error: unknown) => {
  console.error(`[pet creation] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
