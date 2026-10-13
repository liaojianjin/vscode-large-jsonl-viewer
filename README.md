# Large JSONL Viewer

<img src="assets/icon.png" width="96" height="96" alt="Large JSONL Viewer icon">

面向大文件的只读 VS Code Desktop JSONL / NDJSON 查看器。源文件不加载为 TextDocument：后台仅扫描换行建立字节索引，正文一次读取一条记录。

## 安装与打开

正式扩展 ID 为 `LiaoJianjin.large-jsonl-viewer`。

1. 在 [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=LiaoJianjin.large-jsonl-viewer) 或 [Open VSX](https://open-vsx.org/extension/LiaoJianjin/large-jsonl-viewer) 安装，也可从 [GitHub Releases](https://github.com/liaojianjin/vscode-large-jsonl-viewer/releases/latest) 下载 `large-jsonl-viewer-0.2.0.vsix` 后选择 **Install from VSIX… / 从 VSIX 安装…**。
2. 在资源管理器右键 `.jsonl` / `.ndjson` 文件，选择 **Large JSONL: Open in Viewer**；也可从命令面板运行此命令并选择文件。
3. 前 100 行渐进加入下拉列表。无需等待全文件索引即可浏览已就绪的行。

也可使用终端安装：

```sh
code --install-extension LiaoJianjin.large-jsonl-viewer
# 本地安装包
code --install-extension large-jsonl-viewer-0.2.0.vsix
```

从旧版 `local-jsonl-tools.large-jsonl-viewer` 迁移时，请先卸载旧扩展再安装新版；发布者变更会产生不同的扩展 ID。

扩展以 `option` 注册，不自动修改默认编辑器关联。首次跳到尚未索引的行需要等待扫描，当前正文保持可读；可单独取消跳转。

## 操作

- 首行、上一行、下一行、输入物理行号跳转；`Alt+↑` / `Alt+↓` 切行。完整索引后可跳到末行。
- **随机** 跳到任意已索引记录，尽量避开当前行；索引完成前仅在已就绪范围内抽样，完成后覆盖全文件。
- **← / →** 按浏览历史后退、前进（`Alt+←` / `Alt+→`）。这与上一行/下一行独立：例如 `1 → 随机第 80 行 → 随机第 12 行`，后退回到第 80 行，前进回到第 12 行。后退后重新跳行会清除前进分支；取消、失败与过期请求不加入历史。每个视图最多保留 200 次已显示的访问，文件版本变化时清空。
- 顶部仅保留一条紧凑工具栏，索引与记录状态移至底部。点击索引状态可查看初始范围、字节进度、速度与剩余时间，并暂停、取消或继续索引。
- 默认开启 **自动换行**，长字符串随正文宽度折行，不修改原文或复制内容。开关同时作用于格式化正文、原始文本和超长记录的文本窗口，切行与重新显示时保留偏好。
- 常规记录使用本地打包的 Monaco；**更多** 中提供对象/数组折叠、展开 1/2 级或全部、原始文本切换、查找、复制与导出。
- **更多 → 正文默认展开层数** 可设置后续记录的默认深度，也可在 VS Code 设置中调整 `largeJsonl.defaultExpandDepth`。默认 2 级，支持 1–128 级；`0` 全部折叠，`-1` 全部展开。修改立即作用于当前常规正文，并保存为用户设置；超长记录的分页结构仍按需展开。
- 右侧 key 导航可显示 1/2 级；点击定位并展开祖先，中文、emoji 和重复 key 都以实际位置定位。面板默认占约 20% 宽度、上限 200px，支持调整和收起；窄窗口默认收起。
- **专注** 模式隐藏结构导航与底部状态栏，正文占满可用宽度。退出后恢复原来的结构面板偏好。
- 格式化只改空白：保留 `9007199254740993`、`-0`、精度较高的小数、科学计数法、重复 key、属性顺序和字符串转义。
- 超长记录使用增量严格校验和分页结构；每页最多 100 项，可逐层展开，标量与原文按 64 KiB 字节窗口查看。二级导航随展开节点加入。
- 可复制常规记录的原文，也可流式导出当前记录。导出保留源记录字节与行分隔符，不能覆盖源文件。

## 数据与缓存

支持未压缩 UTF-8、本地普通文件、对象/数组/标量根。空白行仍占源文件行号，作为无效记录展示；末尾 LF 不产生额外空行；CRLF 跨块支持。文件开头 BOM 会明确提示。非法 UTF-8 显示错误和有界十六进制片段，不静默替换字符。

索引存储于扩展的 `globalStorageUri/indexes`，不保存 JSON 正文。每个偏移使用小端 uint64，页面带 SHA-256 校验；检查点从已完成行的边界恢复。缓存启动先检查文件大小、mtime/ctime、身份、首尾抽样指纹，再按需校验索引页。打开相同实际路径的多个视图共享会话，各自保留选中行。

文件追加、截断、替换或改写会使会话失效；点击 **重建索引** 恢复。索引、读取和结果绑定文件版本，旧结果不会覆盖新请求。暂停/取消保留已索引范围；关闭视图取消记录 worker，关闭最后一个文档保存检查点。缓存目录不可写时使用临时目录并显示提示；非活动缓存按总容量进行 LRU 清理。

## 设置

| 设置 | 默认值 | 用途 |
| --- | --- | --- |
| `largeJsonl.defaultExpandDepth` | 2 | 常规正文默认展开层数；0 全部折叠，-1 全部展开 |
| `largeJsonl.wordWrap` | true | 新视图默认按宽度自动换行，视图内开关保留偏好 |
| `largeJsonl.scanChunkMiB` | 4 | 索引扫描块，支持 1/4/8 MiB |
| `largeJsonl.recordLimitMiB` | 8 | 单行超过此预算时进入流式结构模式 |
| `largeJsonl.cacheLimitMiB` | 512 | 非活动磁盘索引缓存预算 |
| `largeJsonl.minimap` | false | 启用 Monaco 代码缩略图 |

常规记录还受 100,000 节点、128 层深度、16 MiB 格式化文本和约 2 秒处理预算限制，超限进入流式模式。流式模式容器栈上限 2,048 层，原文窗口仍可使用。导航/节点元数据保留最多 2,000 项，普通正文折叠状态保留最近 10 行。后台索引在前台记录处理时降低 I/O 竞争。

## 开发与验证

需要 Node.js 22 或更高版本构建；运行目标为 VS Code 1.95+ 的桌面扩展宿主。当前真实宿主测试使用 macOS arm64、VS Code 1.140.0，尚未逐一验证最低版本、Windows 和 Linux。

```sh
npm ci
npm run check
npm test
npm run test:integration
npm run test:large-records
npm run package
```

按 F5 启动开发窗口。`npm run watch` 监听构建。集成测试默认使用 macOS 已安装的 VS Code；其他平台可用 `JSONL_VSCODE_EXECUTABLE` 指定可执行文件，未指定则由 `@vscode/test-electron` 下载测试版本。测试使用临时用户和扩展目录。

发布命令：`npm run publish:marketplace` 使用已登录的 `vsce` 发布者或 `VSCE_PAT`；`npm run publish:openvsx` 使用 `OVSX_PAT` 发布到 Open VSX。两个注册表均使用发布者 `LiaoJianjin`。不要将 token 写入源码或提交到 Git。

可复现性能工具：

```sh
npm run fixtures -- --out fixtures/1g.jsonl --sizeMiB 1024 --lineKiB 100
npm run benchmark -- --file fixtures/1g.jsonl --chunkMiB 4
# 混合长行，生成过程不整条物化
npm run fixtures -- --out fixtures/mixed.jsonl --sizeMiB 512 --longMiB 256
```

输出包含纯读取、完整索引、前 100 行边界就绪、随机记录后端 p50/p95 和 RSS。操作系统缓存未驱逐，读基准在索引前后各测一次；后端结果不包含 Webview 展示，不能作为完整用户交互延迟。详见 [验证报告](docs/validation.md)。

## 当前边界

首发不支持编辑保存、全文件搜索、跨记录 JSONPath、gzip、云存储、vscode.dev 或远程 URI。没有随机分块读取能力的文件系统会明确拒绝打开。超长节点换页会重新扫描选中的容器，首次发现后部字段依然需要读取前面的字节。

已运行 1/10 GiB 后端基准及 32/256 MiB 单条记录测试。50/100 GB 实际规模、冷缓存、完整 Webview p95、长时间切行内存和跨平台验收尚未完成；当前数据不能证明“100 GB 几秒完成索引”。文件身份与抽样指纹为快速校验，查看期间文件稳定是正常使用前提。

实现设计来自项目内 `plan.md`；代码独立实现。依赖依据：[VS Code Custom Editor](https://code.visualstudio.com/api/extension-guides/custom-editors)、[Monaco Editor](https://github.com/microsoft/monaco-editor)、[jsonc-parser](https://github.com/microsoft/node-jsonc-parser)。Monaco 与第三方许可证随 VSIX 本地资源提供。
