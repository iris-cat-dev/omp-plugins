const inspectionError = () => ({
  state: 'error', reason: '无法检查 QQ 登录状态。', accountId: null, version: null,
});

/** Owns one QQ sender and its optional temporary QQ session. */
export function createNotificationTransport({ qq, signal }) {
  const abort = new AbortController();
  let closing;

  return {
    async prepare({ signal: attemptSignal, maySend } = {}) {
      const currentSignal = AbortSignal.any([abort.signal, signal, attemptSignal].filter(Boolean));
      const mayContinue = () => !currentSignal.aborted && (maySend?.() ?? true);
      let connection;
      try { connection = await qq.inspect(); }
      catch { connection = inspectionError(); }
      if (mayContinue() && connection.state === 'not_logged_in') {
        try { connection = await qq.ensureLoggedIn({ signal: currentSignal, mayContinue }); }
        catch {
          connection = mayContinue() ? inspectionError() : {
            ...connection, reason: '提醒已停止；不再等待 QQ 登录。',
          };
        }
      }
      return { connection };
    },
    send(params) { return qq.send(params); },
    async finishBatch({ mayClose } = {}) {
      const mayExit = () => !abort.signal.aborted && !signal?.aborted && (mayClose?.() ?? true);
      try { return await qq.finishBatch({ mayClose: mayExit }); }
      catch {
        return {
          state: 'error', reason: '临时 QQ 退出失败；已提交的提醒不受影响，请核对后手动退出 QQ。',
          accountId: null, version: null,
        };
      }
    },
    close() {
      if (!closing) {
        abort.abort();
        closing = Promise.resolve().then(() => qq.close());
      }
      return closing;
    },
  };
}
