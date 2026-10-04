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
  <img alt="Kernel" src="https://img.shields.io/badge/kernel-Camoufox%20(Firefox)-ff6611.svg">
</p>

---

## 这是什么

VFox 是一个**多开指纹浏览器管理器**。它本身不是浏览器，而是驱动开源反检测引擎
[Camoufox](https://camoufox.com/)（打过补丁的 Firefox，指纹伪造发生在 **C++ 引擎层**，
而不是注入 JavaScript）来工作，并补齐产品层：环境管理、指纹配置、代理、克隆与导入导出、
窗口同步器、本地 API / MCP / CLI。

**心智模型：每个环境就是一台虚拟机。**

| 虚拟机概念 | VFox 对应物 |
| --- | --- |
| 虚拟硬件 | 环境的指纹配置（`FingerprintConfig`） |
| 虚拟磁盘 | `<数据目录>/profiles/<id>/userdata`（真实、独立的浏览器配置目录） |
| 开机 / 关机 | 启动 / 关闭一个**真实可见**的浏览器窗口 |
| 克隆 | 复制配置 + 整个配置目录 |
| 导出 / 导入 | 打包成 zip / 还原成新环境 |

## 四个硬承诺

1. **零遥测。** 没有统计、没有崩溃上报、没有更新回连、没有"匿名使用数据"。
   本软件自身只会产生三类网络流量：首次运行下载引擎内核、你自己配置的代理、
   以及开启 `geoip` 时引擎为匹配时区/语言而做的 IP 地理位置查询。
2. **零付费、零推广。** 所有功能对所有人开放。没有授权码、没有激活、没有"专业版"、
   没有邀请返利、没有广告、没有任何指向社群或官网的推广入口。
3. **零云端。** 本项目不运营任何服务器，不要账号，不做云同步。
   环境数据只存在你的磁盘上，导出/导入用普通 zip，整个目录可以直接搬移。
4. **真实窗口。** 每个环境启动的都是可见的真实浏览器窗口，无头模式仅用于 CI 与自动化，
   永远不会成为默认值。

## 关于内核（请先读，避免误解）

VFox 使用 **Firefox 内核**（Camoufox），这是刻意的选择：Camoufox 在 C++ 层修改指纹，
页面无法通过检查 JS 注入痕迹来识破。

由此带来两条**必须提前说清**的事实：

- **只支持 Firefox 扩展（.xpi）**，Chrome 专属扩展（含部分钱包插件）无法加载。
  MetaMask 等主流钱包有 Firefox 版本，可以正常使用。
- 它**不会伪装成 Chrome**，也做不到：Gecko 没有 `navigator.userAgentData`、
  Web Bluetooth、通用传感器 API，TLS 指纹也是真实的 Firefox。伪装成 Chrome 反而自相矛盾。

## 指纹能力（真实清单）

以下项目由引擎在 C++ 层伪造，**同一环境每次启动身份保持一致**（VFox 会持久化生成的身份并在每次启动时回注，
不依赖引擎的随机生成）：

| 类别 | 说明 |
| --- | --- |
| 操作系统 / 浏览器版本 | UA、`oscpu`、`platform`、Firefox 版本号 |
| 屏幕 / 窗口 | `screen.*`、`window.outer*` / `inner*`、`screenX/Y`、像素比 |
| WebGL / WebGL2 | 厂商、渲染器、扩展列表、参数、着色器精度、上下文属性 |
| 字体 | 按目标系统匹配的真实字体集合 |
| 语言 / 时区 / 地理位置 | 可与代理出口 IP 自动匹配 |
| AudioContext | 采样率、输出延迟、声道数、音频指纹 |
| 硬件 | `hardwareConcurrency`、媒体设备数量/标签/groupId |
| WebRTC | IPv4 / IPv6 处理与防泄露 |
| 请求头 | User-Agent、Accept-Language、Accept-Encoding |
| 语音合成 | Speech Voices 列表 |
| 其他 | Do Not Track、自定义证书、每环境独立扩展 |

**我们不会声称的**：VFox **不做 Canvas 噪声**，也不做音频/WebGL 的"随机噪声开关"。
上游 Camoufox 刻意移除了 canvas 噪声——canvas 会跟随字体与 GPU 表现，像真实机器一样；
人为加噪声本身就是一个可被识别的特征。同理，MAC 地址、设备名、端口扫描"防护"这类
页面根本看不到的项目，我们不提供，也不会拿来做卖点。

## 功能

- **多环境隔离**：每个环境独立的 cookie、localStorage、扩展与缓存目录
- **一键"自动"**：留空的指纹项由引擎按真实世界分布生成，保证同一环境内部自洽
- **代理**：HTTP / HTTPS / SOCKS5，逐环境绑定，支持用户名密码
- **批量建号**：一次创建最多 50 个环境，每个环境独立生成设备身份，可共用分组/代理/启动选项；**全或无**，失败不会留下半个批次
- **批量操作**：批量启动（错峰拉起，不会瞬间打满 CPU）、批量停止、分组、搜索
- **虚拟机式管理**：克隆、导出 zip、导入 zip、打开数据目录、查看占用空间
- **窗口同步器**：主窗口操作一次，同步到所有从窗口；支持窗口平铺
  > 同步是**页面级**的：鼠标、滚轮、键盘会回放到从窗口的网页内容里。浏览器界面本身
  > （地址栏、标签页、原生下拉框、文件选择框、权限弹窗）不在同步范围内，同类工具也一样。
- **本地 API + MCP + CLI**：给脚本和 AI Agent 用的同一套接口，全部免费
- **轻量**：一个 Electron 窗口 + 一个 Node 核心进程，无后台守护、无轮询

## 安装

从 [Releases](../../releases/latest) 下载：

- `VFox-Setup-<version>.exe` — Windows 安装包（NSIS，x64，**每用户安装、不需要管理员权限**）
- `VFox-<version>-portable.zip` — **便携版，解压即用，整个文件夹可搬移**

> 安装包**不含**浏览器内核。首次启动会下载引擎（约 550 MB，解压后约 1 GB），
> 来自 Camoufox 官方发布页。下载一次即可，之后离线可用。
>
> 安装包**未做代码签名**，Windows SmartScreen 会提示"未知发布者"，需要手动选择"仍要运行"。
> 校验方式见 Release 页面里的 `SHA256SUMS.txt`。

### 便携版

解压后目录结构如下，**所有数据都在自己的文件夹里**，整个目录可以拷到 U 盘或另一台机器继续用：

```
VFox-0.2.0-portable/
├─ VFox.exe
├─ portable            ← 便携模式标记
├─ data/               ← 所有数据：环境、内核、日志、设置
└─ resources/
```

若把 `data/` 一起搬走，环境、登录状态、指纹身份和引擎都会保留。
删除 `portable` 标记文件即切换回安装模式（数据改存 `%APPDATA%\VFox`）。

### 环境要求

Windows 10 1809+ / Windows 11，x64。无需预装 Node、Python 或任何运行时。

## 使用

1. 打开 VFox，点击**新建环境**
2. 指纹页保持默认即为"自动"，需要指定时再逐项填写
3. 需要代理的环境在代理页填写，建议同时开启"按 IP 自动匹配时区/语言/地理位置"
4. 回到列表点击**启动**，会弹出一个真实的浏览器窗口

## 命令行

```bash
vfox list                     # 环境列表与运行状态
vfox create "账号A" --os windows --proxy socks5://127.0.0.1:1080
vfox create --count 20 --prefix 工作号 --group 注册   # 批量建号，上限 50
vfox start <id|名称>           # 启动并等待窗口就绪
vfox stop <id|名称>
vfox clone <id|名称> --name "账号A-2"
vfox export <id|名称> a.zip
vfox import a.zip
vfox sync status | vfox sync start <主控> <受控...> | vfox sync stop | vfox sync tile
vfox kernel info | vfox kernel install
vfox serve                    # 仅启动本地 API 服务（默认 127.0.0.1:9000）
vfox mcp                      # 以 stdio 方式启动 MCP 服务，供 AI Agent 调用
```

## 本地 API

默认监听 `127.0.0.1:9000`（端口被占用时自动换端口，实际端口在设置页可见），
所有请求需带 `x-vfox-token` 头。完整路由见
[`packages/shared/src/routes.ts`](packages/shared/src/routes.ts)。

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
