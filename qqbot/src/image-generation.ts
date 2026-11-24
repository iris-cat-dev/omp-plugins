import { randomUUID } from 'node:crypto';
import type { GeneratedImage, ImageGenerationInput, OmpApi } from '@omp-desktop/client';
import type { Peer } from './state.ts';
import { imageQuotaDatabasePath } from './image-quota.ts';
import { ImageGenerationQuotaLedger } from './image-quota-ledger.ts';

// Exact host/client-authored pre-generation failures. Generic provider failures
// intentionally carry no reliable outcome and must keep their reservations.
const NO_GENERATION_ERRORS: Record<string, true> = {
  'Image generation is disabled on this host.': true,
  'Image generation is disabled by the OMP provider policy on this host.': true,
  'Set an OpenAI image API key in this host’s image generation settings.': true,
  'The selected ChatGPT image account is unavailable. Sign in or choose another subscription account on the host.': true,
  'The host’s OMP Node SDK does not support direct image generation. Update or rebuild the selected SDK.': true,
  'The image provider returned no image.': true,
  'Image generation requires a connected host': true,
  'Plugin capability is not granted: images.generate': true,
};

/** One plugin service shares this generator between chat images and scene images. */
export class QQImageGenerator {
  private ledger: ImageGenerationQuotaLedger | undefined;
  private active = new Set<AbortController>();
  private disposed = false;

  constructor(private omp: Pick<OmpApi, 'images'>, private databasePath = imageQuotaDatabasePath) {}

  async generate(peer: Pick<Peer, 'appId' | 'scope'>, senderId: string, input: ImageGenerationInput, signal: AbortSignal): Promise<GeneratedImage> {
    signal.throwIfAborted();
    if (this.disposed) throw new Error('QQ 图片生成服务已关闭。');
    const ledger = this.ledger ??= new ImageGenerationQuotaLedger(this.databasePath);
    const requestId = randomUUID();
    const reservation = ledger.reserve(requestId, { appId: peer.appId, scope: peer.scope, senderId });
    if (!reservation.created) throw new Error('QQ 图片请求标识重复，已拒绝生成。');
    const controller = new AbortController();
    this.active.add(controller);
    try {
      const image = await this.omp.images.generate(input, { signal: AbortSignal.any([signal, controller.signal]) });
      // Account for the real API output before PNG validation, disk publication,
      // cancellation checks or QQ upload. Those later steps never refund images.
      ledger.settle(requestId, 'succeeded');
      return image;
    } catch (error) {
      if (error instanceof Error && NO_GENERATION_ERRORS[error.message] === true) ledger.settle(requestId, 'failed');
      throw error;
    } finally {
      this.active.delete(controller);
      if (this.disposed && !this.active.size) this.closeLedger();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const controller of this.active) controller.abort(new Error('QQ 图片生成服务已关闭。'));
    if (!this.active.size) this.closeLedger();
  }

  private closeLedger(): void {
    this.ledger?.close();
    this.ledger = undefined;
  }
}
