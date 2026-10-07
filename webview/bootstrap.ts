const hostApi = (globalThis as any).acquireVsCodeApi();
(globalThis as any).jsonlHostApi = hostApi;
function report(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  hostApi.postMessage({ type: 'startupError', message: message.slice(0, 2000) });
  const banner = document.createElement('div'); banner.style.padding = '16px'; banner.textContent = `查看器界面错误：${message}`; document.body.prepend(banner);
}
window.addEventListener('error', event => report(event.error ?? event.message));
window.addEventListener('unhandledrejection', event => report(event.reason));
