# 运行时注入 `chinese-settings` 根因定位报告（2026-03-05）

## 现象
- `~/.config/opencode/opencode.json` 的 `plugin` 列表里未声明 `chinese-settings`。
- 但 `opencode debug config` 的最终有效插件列表仍出现：
  - `file:///Users/wsxwj/.config/opencode/plugins/chinese-settings.js`

## 取证结论
- OpenCode 运行时会加载 `~/.config/opencode/plugins/` 下可加载的 `.js` 文件。
- 因此只要该目录存在 `chinese-settings.js`，即使不在 `opencode.json` 中，仍可能被纳入有效插件。

## 实际验证步骤（已执行）
1. 将 `chinese-settings.js` 改名为 `chinese-settings.disabled.js`。
2. 复测 `opencode debug config`：
   - 仍出现 `chinese-settings.disabled.js`（说明仍按 `.js` 扫描加载）。
3. 再改名为无 `.js` 后缀：`chinese-settings.disabled`。
4. 再次 `opencode debug config`：
   - `chinese-settings` 从有效插件列表消失。

## 无损修复策略
- 不删除文件，仅改为非 `.js` 扩展名：
  - `~/.config/opencode/plugins/chinese-settings.disabled`

## 风险与回滚
- 风险：如果未来想恢复该插件，需手动改回 `.js` 扩展。
- 回滚：
  - `mv ~/.config/opencode/plugins/chinese-settings.disabled ~/.config/opencode/plugins/chinese-settings.js`

## 建议
- 以后禁用本地插件，优先“改扩展名/移出 plugins 目录”，不要仅从 `opencode.json` 删除。

