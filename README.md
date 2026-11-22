# DSH Codex Bridge

English · [简体中文](README.zh.md)

`@charleypeng/dsh-codex-bridge` connects DeepSeek Harness to the account signed into your local Codex client. It adds **Settings → Codex**, with quota, automatic model discovery, model picker switches, and the reasoning levels advertised by Codex. The Codex-only `ultra` orchestration mode is excluded.

## Install

1. Make sure Codex is signed in locally with ChatGPT and that your DSH build provides the pi-ai adapter, credentials, profile configuration, and storage domain services. Developed against DSH Desktop with `dsh-llm-pi-ai` 0.2.2-rc.5.
2. Clone this repository: `git clone https://github.com/charleypeng/dsh-codex-bridge.git`.
3. In DSH's plugin manager, add the cloned directory as a local bundle. If upgrading from the old `@local/codex-bridge` bundle, disable that bundle first; do not enable both copies together.
4. Open **Settings → Codex**, choose **Import credential and enable**, and pick an enabled Codex model in the composer. Model switches affect picker visibility, not account entitlement.

## Credentials and caching

The Host reads `$CODEX_HOME/auth.json`, or `~/.codex/auth.json` by default. It imports the grant into DSH's credential service and uses it with OpenAI's Codex backend. On credential refresh, it also attempts to update the local Codex credential file. Do not commit or share that file. The UI cache does not store OAuth tokens. The backend endpoints are not the public OpenAI API and can change; failed refreshes retain the last successful data.

See [plugin details](docs/DETAIL.md) for migration and runtime behavior. This is an independent plugin, not an official OpenAI or DeepSeek product.

## Development

Run `npm test` with a recent Node.js. To include the runtime adapter integration test, run the suite with the DSH-provided Node/Electron runtime and its `DSH_INSTALL_DIR` set to the installed CLI package directory.

[MIT](LICENSE)
