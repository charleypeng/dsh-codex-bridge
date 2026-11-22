# DSH Codex Bridge

[English](README.md) · 简体中文

`@charleypeng/dsh-codex-bridge` 将本机 Codex 客户端已登录的账号接入 DeepSeek Harness。安装后，在 **设置 → Codex** 可查看额度与重置时间、自动同步模型目录，并用开关选择哪些模型出现在模型选择器中。推理档位跟随 Codex 目录，排除仅用于 Codex 子代理编排的 `ultra`。

## 安装

1. 确认本机 Codex 已使用 ChatGPT 账号登录，且当前 DSH 提供 pi-ai 适配器、凭证、配置和持久存储服务。插件基于带有 `dsh-llm-pi-ai` 0.2.2-rc.5 的 DSH 桌面版开发。
2. 克隆仓库：
   ```sh
   git clone https://github.com/charleypeng/dsh-codex-bridge.git
   ```
3. 在 DSH 插件管理器中，将克隆后的目录添加为本地插件包。如果从旧版 `@local/codex-bridge` 迁移，请先停用旧版，不要同时启用两个版本。
4. 打开 **设置 → Codex**，点击 **导入凭证并启用**，然后在对话输入框的模型选择器中选择已经启用的 Codex 模型。开关只控制模型是否出现在选择器里，不会改变账号权限或额度。

## 凭证与缓存

插件的宿主端读取 `$CODEX_HOME/auth.json`，默认路径为 `~/.codex/auth.json`。它将登录凭证导入 DSH 凭证服务，用于访问 OpenAI 的 Codex 后端。续期时，插件也会尝试更新本机 Codex 凭证文件。不要提交或分享该文件。

设置页优先显示缓存，随后在后台刷新；刷新失败时保留上次成功的数据。界面缓存不保存 OAuth 令牌。插件使用的 Codex 后端接口不是公开的 OpenAI API，可能随版本变化。

迁移和运行机制见[插件详情（英文）](docs/DETAIL.md)。本插件为独立项目，不是 OpenAI 或 DeepSeek 的官方产品。

## 开发

使用较新的 Node.js 执行 `npm test`。如果要运行适配器集成测试，请使用 DSH 随附的 Node/Electron 运行时，并将 `DSH_INSTALL_DIR` 指向已安装的 DSH CLI 包目录。

## 许可证

[MIT](LICENSE)
