<p align="center">
  <img src="docs/assets/logo.svg" alt="VFox" width="120">
</p>

<h1 align="center">VFox</h1>

<p align="center"><b>轻量、开源、零遥测的多开指纹浏览器</b><br/>
A lightweight, open-source, telemetry-free anti-detect browser manager for Windows.</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <img alt="Platform" src="https://img.shields.io/badge/platform-Windows%2010%2F11-0078d4.svg">
  <img alt="Telemetry" src="https://img.shields.io/badge/telemetry-none-success.svg">
</p>

---

## 这是什么

VFox 是一个**多开指纹浏览器管理器**。它本身不是浏览器，而是驱动开源反检测引擎
[Camoufox](https://camoufox.com/)（打过 C++ 补丁的 Firefox，指纹伪造发生在**引擎层**，
而不是注入 JavaScript）来工作，并补齐了产品层：环境管理、指纹配置、代理、导入导出、
本地 API / MCP / CLI。

**心智模型：每个环境就是一台虚拟机。**

| 虚拟机概念 | VFox 对应物 |
| --- | --- |
| 虚拟硬件 | 环境的指纹配置（`FingerprintConfig`） |
| 虚拟磁盘 | `<数据目录>/profiles/<id>/userdata`（真实、独立的浏览器配置目录） |
| 开机 / 关机 | 启动 / 关闭一个**真实可见**的浏览器窗口 |
| 克隆 | 复制配置 + 整个配置目录 |
| 导出 / 导入 | 打包成 zip / 还原成新环境 |

## 三个硬承诺

1. **零遥测。** 没有统计、没有崩溃上报、没有更新回连、没有"匿名使用数据"。
   本软件自身只会产生三类网络流量：首次运行下载引擎内核、你自己配置的代理、
   以及开启 `geoip` 时引擎为匹配时区/语言而做的 IP 地理位置查询。
2. **零付费墙。** 所有功能对所有人开放。没有授权码、没有激活、没有"专业版"，
   代码里也不存在能长出收费逻辑的路径。
3. **真实窗口。** 每个环境启动的都是可见的真实浏览器窗口，无头模式仅用于 CI 与自动化，
   永远不会成为默认值。

## 功能

- **多环境隔离**：每个环境拥有独立的 cookie、localStorage、扩展与缓存目录
- **引擎级指纹**：操作系统、字体、屏幕、WebGL 厂商/渲染器、Canvas、Audio、
  语言、时区、地理位置、硬件并发数、设备内存、User-Agent
- **一键"自动"**：留空的指纹项由引擎按真实世界分布生成，保证同一环境内部自洽
- **代理**：HTTP / HTTPS / SOCKS5，逐环境绑定，支持用户名密码
- **批量操作**：批量启动（错峰拉起，不会瞬间打满 CPU）、批量停止、分组、搜索
- **虚拟机式管理**：克隆、导出 zip、导入 zip、打开数据目录
- **本地 API + MCP + CLI**：给脚本和 AI Agent 用的同一套接口，全部免费
- **轻量**：一个 Electron 窗口 + 一个 Node 核心进程，无后台守护、无轮询

## 安装

从 [Releases](../../releases/latest) 下载：

- `VFox-Setup-<version>.exe` — Windows 安装包（NSIS，x64）
- `VFox-<version>-portable.zip` — 便携版，解压即用

首次启动会提示下载浏览器引擎内核（约 550 MB，来自 Camoufox 官方发布页）。
下载一次即可，之后离线可用。

> 要求：Windows 10 1809+ / Windows 11，x64。无需预装 Node、Python 或任何运行时。

## 使用

1. 打开 VFox，点击**新建环境**
2. 指纹页保持默认即为"自动"，需要指定时再逐项填写
3. 需要代理的环境在代理页填写，建议同时开启"按 IP 自动匹配时区/语言/地理位置"
4. 回到列表点击**启动**，会弹出一个真实的浏览器窗口

数据默认存放在 `%APPDATA%\vfox`，整个目录可直接备份或迁移。

## 命令行

```bash
vfox list                     # 环境列表与运行状态
vfox create "账号A" --os windows --proxy socks5://127.0.0.1:1080
vfox start <id|名称>           # 启动并等待窗口就绪
vfox stop <id|名称>
vfox clone <id|名称> --name "账号A-2"
vfox export <id|名称> a.zip
vfox import a.zip
vfox kernel info | vfox kernel install
vfox serve                    # 仅启动本地 API 服务（默认 127.0.0.1:9000）
vfox mcp                      # 以 stdio 方式启动 MCP 服务，供 AI Agent 调用
```

## 本地 API

默认监听 `127.0.0.1:9000`，所有请求需带 `x-vfox-token` 头（token 在设置页可见）。
完整路由见 [`packages/shared/src/routes.ts`](packages/shared/src/routes.ts)。

## 构建

本项目**不需要**本地编译 Chromium：引擎是下载来的二进制，产品层全部是 TypeScript。
Windows 安装包由 GitHub Actions 构建并发布到 Releases。

```powershell
. .\scripts\dev-env.ps1   # 把各种缓存重定向进仓库内的 .cache/
pnpm install
pnpm kernel:fetch         # 下载引擎内核
pnpm build
pnpm dev                  # 开发模式运行桌面端
```

发布流程见 [docs/RELEASING.md](docs/RELEASING.md)。

## 第三方组件

| 组件 | 用途 | 协议 |
| --- | --- | --- |
| [Camoufox](https://github.com/daijro/camoufox) | 浏览器引擎（引擎层指纹伪造） | MPL-2.0 |
| [camoufox-js](https://github.com/apify/camoufox-js) | 引擎的 JavaScript 封装 | MPL-2.0 |
| [Playwright](https://playwright.dev/) | 浏览器驱动 | Apache-2.0 |
| [Electron](https://www.electronjs.org/) | 桌面外壳 | MIT |
| [Vue 3](https://vuejs.org/) / [Element Plus](https://element-plus.org/) | 界面 | MIT |

本项目自身的代码以 [MIT](LICENSE) 发布。引擎二进制在运行时下载，不随本仓库分发，
也未做任何修改。

## 免责声明

本项目仅供技术交流、学习与研究使用。请勿将其用于任何违法用途。
使用者需自行遵守所在地区法律法规以及所访问平台的服务条款。

## 致谢

- [Camoufox](https://camoufox.com/) — 没有它就做不出引擎级的指纹伪造
- [FingerprintJS](https://fingerprintjs.github.io/fingerprintjs/) · [BrowserLeaks](https://browserleaks.com/) — 指纹自检
