import { z } from 'zod';
import { sandboxRelativePath } from './sandbox-files.ts';

const ImageRequestSchema = z.object({
  type: z.literal('qqbot_generate_image'),
  prompt: z.string().max(32_000).regex(/\S/),
  images: z.array(z.string().refine(path => {
    try { return sandboxRelativePath(path) === path; } catch { return false; }
  })).max(16).default([]),
}).strict();
export type ImageRequest = z.infer<typeof ImageRequestSchema>;

export const IMAGE_REQUEST_PROTOCOL = `QQ 生图由 QQ 插件处理，不使用原生 generate_image 或其他代理绕过插件。需要绘图或编辑图片时，只输出一个完整 JSON，不加代码围栏或其他消息：
{"type":"qqbot_generate_image","prompt":"完整的绘图要求","images":[]}
编辑图片时，images 只能填当前 QQ 专用目录中已有图片的相对路径。不要输出账号、发送者、额度、供应商或密钥字段。普通聊天仍用自然语言；缺少绘图信息时先澄清。`;

export function parseImageRequest(text: string): ImageRequest | { type: 'invalid_image_request' } | null {
  let value: unknown;
  try { value = JSON.parse(text); }
  catch {
    return /^\s*\{\s*"type"\s*:\s*"qqbot_generate_image"/.test(text) ? { type: 'invalid_image_request' } : null;
  }
  if (!value || typeof value !== 'object' || !('type' in value) || value.type !== 'qqbot_generate_image') return null;
  const parsed = ImageRequestSchema.safeParse(value);
  return parsed.success ? parsed.data : { type: 'invalid_image_request' };
}
