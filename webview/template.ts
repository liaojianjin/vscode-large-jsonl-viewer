// Static UI only. Record content always goes through textContent or Monaco.
export const VIEWER_HTML = `
<header class="toolbar">
  <nav class="navigation" aria-label="记录导航">
    <button id="first" title="首行">首行</button>
    <button id="previous" title="上一行 · Alt+↑" aria-label="上一行">‹</button>
    <label for="line">第</label><input id="line" type="number" min="1" step="1" value="1" aria-label="源文件物理行号"><span>行</span>
    <button id="go" class="primary">跳转</button>
    <button id="next" title="下一行 · Alt+↓" aria-label="下一行">›</button>
    <button id="last">末行</button>
    <select id="initial" aria-label="前 100 行"><option>扫描中…</option></select>
  </nav>
  <div class="view-tools">
    <button id="wrap" aria-pressed="true" title="长文本按正文宽度自动换行">自动换行</button>
    <button id="toggle-outline" aria-expanded="true" aria-controls="sidebar">结构</button>
    <button id="focus" aria-pressed="false" title="隐藏结构与状态栏，扩大正文区域">专注</button>
    <details id="more" class="dropdown">
      <summary aria-label="更多查看操作">更多</summary>
      <div class="menu-panel actions-panel">
        <span class="menu-label">正文展开</span>
        <div class="button-group"><button id="fold-1">1 级</button><button id="fold-2">2 级</button><button id="unfold">全部</button></div>
        <button id="fold-all">折叠全部</button>
        <button id="raw">原始文本</button>
        <button id="find">查找</button>
        <button id="copy">复制原始记录</button>
        <button id="export">导出原始记录</button>
      </div>
    </details>
  </div>
</header>
<div id="message" role="status" aria-live="polite" hidden><span></span><button id="cancel-jump" hidden>取消本次跳转</button><button id="dismiss" aria-label="关闭提示">×</button></div>
<main>
  <section id="content"><div id="editor"></div><div id="large" hidden></div></section>
  <div id="splitter" role="separator" aria-label="调整结构面板宽度" aria-orientation="vertical" tabindex="0"></div>
  <aside id="sidebar">
    <div class="outline-head"><strong>结构</strong><button id="depth-1" class="active">1 级</button><button id="depth-2">2 级</button><button id="close-outline" aria-label="收起结构导航" title="收起结构导航">×</button></div>
    <div id="outline"><div id="outline-inner"></div></div><div id="outline-hint"></div>
  </aside>
</main>
<footer class="statusbar">
  <span id="details">选择已就绪的行即可查看</span>
  <details id="index-details" class="dropdown">
    <summary><span id="index-summary">正在打开…</span></summary>
    <div class="menu-panel index-panel">
      <strong id="index-progress">正在打开文件…</strong>
      <span id="initial-progress">前 100 行：0 / 100</span>
      <span id="speed">正在估算速度…</span>
      <div class="button-group"><button id="pause">暂停索引</button><button id="cancel-index">取消索引</button><button id="reload" hidden>重建索引</button></div>
    </div>
  </details>
  <progress id="progress" max="100" value="0" aria-label="索引进度"></progress>
</footer>`;
