import { resolve } from 'node:path';
import { homedir } from 'node:os';

// Outside every QQ sandbox; shared across installation IDs so reinstalling the
// same AppID cannot reset today's usage.
export const imageQuotaDatabasePath = resolve(homedir(), '.omp', 'qqbot-data', 'image-quota.sqlite');


export function imageQuotaFailure(error: unknown, dailyLimit: number): string | null {
  if (typeof error === 'string') {
    return error.includes('QQ_IMAGE_QUOTA_EXHAUSTED')
      ? `今日生图配额已用完（每人每天 ${dailyLimit} 次，进行中的生图也占用额度）；北京时间次日 00:00 恢复。`
      : null;
  }
  if (!error || typeof error !== 'object') return null;
  if ('message' in error) {
    const message = imageQuotaFailure(error.message, dailyLimit);
    if (message) return message;
  }
  if ('cause' in error) return imageQuotaFailure(error.cause, dailyLimit);
  return null;
}
