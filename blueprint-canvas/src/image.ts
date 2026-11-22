import { z } from "zod";

export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_GRAPH_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 32 * 1024 * 1024;
const MimeType = z.enum(["image/png", "image/jpeg", "image/webp"]);

export function imageBytes(data: string): number {
  return data.length / 4 * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
}

export const BlueprintImageSchema = z.strictObject({
  name: z.string().min(1),
  mimeType: MimeType,
  data: z.string().min(4).max(Math.ceil(MAX_IMAGE_BYTES / 3) * 4).refine(
    (data) => data.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(data) && imageBytes(data) <= MAX_IMAGE_BYTES,
    "图片数据无效或超过 4 MiB",
  ),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
}).refine(({ width, height }) => width * height <= MAX_IMAGE_PIXELS, "图片超过 32 MP");
export type BlueprintImage = z.infer<typeof BlueprintImageSchema>;

export function imageUrl(image: Pick<BlueprintImage, "data" | "mimeType">): string {
  return `data:${image.mimeType};base64,${image.data}`;
}

function matchesFormat(bytes: Uint8Array, type: BlueprintImage["mimeType"]) {
  if (type === "image/png") return [137, 80, 78, 71, 13, 10, 26, 10].every((value, i) => bytes[i] === value);
  if (type === "image/jpeg") return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const header = String.fromCharCode(...bytes);
  return header.startsWith("RIFF") && header.slice(8, 12) === "WEBP";
}

async function imageDimensions(url: string) {
  const image = new Image();
  try {
    image.src = url;
    await image.decode();
  } catch (error) {
    throw new Error("无法解码这张图片", { cause: error });
  }
  const { naturalWidth: width, naturalHeight: height } = image;
  if (width * height > MAX_IMAGE_PIXELS) throw new Error("图片超过 32 MP");
  return { width, height };
}

export async function decodeGeneratedImage(image: Pick<BlueprintImage, "data" | "mimeType">): Promise<BlueprintImage> {
  if (!matchesFormat(Uint8Array.from(atob(image.data.slice(0, 16)), (char) => char.charCodeAt(0)), image.mimeType)) {
    throw new Error("生成的图片与返回的文件格式不符");
  }
  const dimensions = await imageDimensions(imageUrl(image));
  const extension = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" }[image.mimeType];
  return BlueprintImageSchema.parse({ ...image, ...dimensions, name: `生成图片.${extension}` });
}

// Drag/drop and preview adapted from OpenAGI js/flow-canvas.js (imageDropEl).
export async function importBlueprintImage(file: File): Promise<BlueprintImage> {
  const format = MimeType.safeParse(file.type);
  if (!format.success) throw new Error("请选择 PNG、JPEG 或 WebP 图片");
  if (!file.size || file.size > MAX_IMAGE_BYTES) throw new Error("图片必须非空且不超过 4 MiB");
  if (!matchesFormat(new Uint8Array(await file.slice(0, 12).arrayBuffer()), format.data)) {
    throw new Error("图片内容与文件格式不符");
  }
  const url = URL.createObjectURL(file);
  const dimensions = await imageDimensions(url).finally(() => URL.revokeObjectURL(url));
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result).split(",", 2)[1]!);
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(file);
  return BlueprintImageSchema.parse({ name: file.name, mimeType: format.data, data: await promise, ...dimensions });
}
