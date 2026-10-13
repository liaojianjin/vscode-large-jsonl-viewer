# Changelog

## 0.2.1

- Use a smaller transparent PNG icon that meets the Marketplace's 1 MiB upload limit.

## 0.2.0

- Add configurable default JSON expansion depth, with a viewer dropdown and live VS Code settings updates.
- Add random record selection within the indexed range and back/forward browsing history.
- Keep at most 200 committed visits per view; cancelled and failed jumps preserve history, and file changes clear it.
- Add navigation commands and Alt+Left/Alt+Right keybindings.

## 0.1.4

- Make the padding outside the icon's rounded tile transparent with a real PNG alpha channel.
- Preserve the navy tile and the JSON braces, record lines and magnifying glass.

## 0.1.3

- Add a PNG extension icon combining JSON braces, record lines and a magnifying glass.
- Include the icon in the VSIX and show it in the README and extension registries.

## 0.1.2

- Publish under the official `LiaoJianjin` publisher identity.
- Update installation instructions and extension host tests for `LiaoJianjin.large-jsonl-viewer`.
- Add CLI publishing commands for Visual Studio Marketplace and Open VSX.

## 0.1.1

- Enable word wrap by default for formatted JSON, raw records and large value windows, with a persistent viewer toggle.
- Give content more space with a single compact toolbar, a bottom status bar, collapsible outline and focus mode.
- Move folding, find, copy and export into the More menu; keep indexing details and controls in a status popover.

## 0.1.0

- Initial desktop viewer: progressive persistent indexing, lossless record display, folding, key navigation and bounded streaming trees.
