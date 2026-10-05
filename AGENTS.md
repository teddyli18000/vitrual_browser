# AGENTS.md — VFox

**这里只有两样东西：主人说过的原则，和 agent 踩过的坑。**

产品说明、目录结构、API 列表、怎么装怎么跑 —— 那些属于 `README.md` 和 `docs/`，不在这里。
写之前问一句：这是**原则**还是**坑**？都不是，就别写。

---

## 一、主人的原则

原话优先 —— 转述会失真。

### 轻量与干净

- 「我希望尽可能做的轻量化一点，别占用太多，别堆屎山」
- 「不准往我电脑上装任何东西」
- 「portable 版本的，所有的数据都要在自己的文件夹里，可以整个移动」

### 不碰的东西

- 「涉及到付费的我们都不做，推广啥的都不做，云同步啥的也不做」
- **零遥测。** 产品自身只允许三种外发流量：首次运行的引擎下载、用户自己配的代理、开启 geoip 时的
  GeoIP 查询。新增外发必须写进 `README.md` 并在 PR 里说明理由。
- 仓库里不放密钥；代理凭据只存在用户本地 profile 里。

### 跑在哪

- 「对于可能有危险的构建测试啥的，绝不能在我电脑上跑，放到 GitHub 上，反正无限额度」
- 「你本地你不好测，是吧？」→ **CI 是主要证据。** 沙箱里浏览器起不来（Chromium 死于 Mojo 的命名
  管道）、Electron 起不来、renderer 构建不了，所以**没在 CI 跑过的浏览器/打包结论等于没验证过**。
  本地跑了一半，不许说成"验证过了"。

### 怎么交付

- 「你是领导你自己规划版本规划提交规划 pr 啥的，还有 issue，你自己管理好……版本该发布就发布，
  别全部堆在一起」
- 「人家写完开了 pr，你还要让专门 review 的 agent 去审查，你把原则啥的给它规定好了……你自己也要
  大概看一下」
- 「长期规划还有架构啥的，甚至是你检查出来的 bug，都别自己乱修，多拉几个 agent 来讨论」
- 「别再把主线搞坏了，要确保每一次迭代都正常」
- 「我不希望再拿到一个残次品」
- 「不要停下来直到做出一个满意的结果」
- 「反正你看两个，一个 GitHub，一个 workbuddy」

### 怎么测

- 「我们现在就是要用 action 来在尽可能多的站点上检查我们的浏览器……全部在 action 用 playwright
  拉着跑……反正 ci 免费，猛猛测」
- 「我指的检测指纹的网站，是那种专门检测的，**你要把结果拿回来看的**……单靠写代码是没法判断结果的」
- 「弄好之后你通过 action，自己去试我们的指纹这些有没有问题，多试几个网站……然后要审查查证，
  不能犯这种低级错误」
- 「你还要对齐优秀的，知道吗？自己去找，自己发版本迭代」

### 体验

- 「有一个体验上的优化，不要一打开浏览器就是满屏知道吗？但也别太小」
- 「这个你不能固定死了，因为我的电脑如果分辨率高你写的很小就会很小」→ 窗口尺寸是**比例**，
  上限**相对工作区**，不是像素。绝对上限在大屏上会变成小窗口。

---

## 二、纪律（由上面的原则推出来，具体到能执行）

1. 一个行为变更先开 issue；非平凡设计先写提案并评审，**再**写代码。
2. 一个 PR 只做一件事，作者不自审。
3. 每个 PR 由**没写它的人**评审，必须报告三件事：验证了什么（附原始输出）、**没验证什么**、
   还认为哪里错。只点头的不是评审。
4. **Lead 合并，作者不合并**；Lead 在同一个 commit 上自己重跑一遍门禁，不信摘要 —— 摘要是主张，
   而主张正是评审要查的东西。
5. **每条断言都要有"它变红"的输出。** 从没红过的守卫等于没有守卫；**扫到 0 个输入还返回绿的守卫
   更糟**，因为有人信它（这个错误本仓库已经犯过两次）。
6. 发版从绿的 main 上切，一次一个；发布前打包套件要跑在**真正发货的产物**上，不是构建目录 ——
   `release/win-unpacked` 不是用户下载的东西，便携 zip 和安装包才是。v0.3.4 对着构建目录全绿、
   到用户机器上每次安装都失败，就是因为那个目录让模块解析向上走进了本仓库自己的 `node_modules`。
7. 从共享工作树组装 PR 之前，**两个方向都要查**：
   ```powershell
   git diff --stat origin/main                 # 每个 hunk 都必须属于这件事
   git diff origin/main | Select-String '^-'   # main 上的东西一个都不许消失
   ```
   共享树几小时就会落后 main。从 `origin/main` 开 worktree；凡是共享树里拷来的文件，在 diff 干净
   之前都当可疑。这个坑同一天里犯过两次：一次**回滚**了 main 上已有的工作，一次**混进**了别的分支
   的文件。

---

## 三、坑

### 引擎与指纹

- **`playwright-core` 精确钉 1.60.0**（`camoufox-js` 的 peer 范围是 `<1.61.0`）。新版会破坏打过补丁
  的 Juggler 协议。
- **持久 profile 和 `wsEndpoint` 可以同时要**，走 `firefox.launchServer({ ...opts, _userDataDir })`
  这条私有路径（`coreBundle.js:52555-52586`）。两个私有选项是承重的：`_userDataDir`（否则是临时
  目录）、`_sharedBrowser: true`（最后一个自动化客户端断开后浏览器不能消失）。有守卫测试断言这个
  钩子还在 —— Playwright 悄悄升级必须让 CI 红，而不是把每个 profile 降级成临时目录。
- **`better-sqlite3` 是真运行时依赖，必须编译。** `camoufox-js/dist/webgl/sample.js` 引它，而那个
  WebGL 采样器**每次启动都跑**。别用 grep 判断依赖：只在顶层 `dist/*.js` 里找静态 import 会漏掉
  嵌套那个，`require('better-sqlite3')` 才作数。
- **引擎每次启动会重掷八样东西**，只钉 `identity.fingerprint` 不够：七个 `CAMOU_CONFIG`
  （`canvas:seed`、`audio:seed`、`fonts:spacing_seed`、`canvas:aaOffset`、`canvas:aaCapOffset`、
  `window.history.length`、`window.screenY`）**加一次全新的 WebGL 采样**。八个全钉。
- **CAMOU_CONFIG 是通过 `env` 里的分块变量传的**（`CAMOU_CONFIG_<n>`，每块 2047 字符），不在
  `options.config` 里 —— 读 `options.config` 什么都看不到。
- **`_castToProperties` 会丢掉 falsy 值**（`fingerprints.js:13` 开头 `if (!data) continue`），
  所以存 `innerWidth: 0` 永远到不了引擎。
- **WebGL 采样按真实 GPU 市场份额加权**，`webgl_data.db` 的 `win`/`mac`/`lin` 是**浮点权重不是标记**。
  实测 2000 次：只有 15/32 对会出现，前三名占 81%，单个 GTX 980 占 45%，三个 profile 撞车概率
  61.3%。**修法不是拉平权重**（真实分布本身就是指纹），而是在引擎自己的表上、只从"别的 profile
  还没占用的对"里选。`createBatch` 要带上整批的集合 —— 只跟 store 去重的话同批之间照样撞。
  **重新抽不是修法**：热门对被占走后剩下的很稀有，有限次抽取经常抽不中。要从表里选，不要重掷。
- **读指纹值可能比伪造它更难。** 引擎冒烟测试报 `webglVendor: null`，原因是 canvas 元素只能有**一种**
  上下文类型，探针在同一个元素上先建 `2d` 又要 `webgl`。一个上下文一个元素。断定某个维度没被伪造
  之前，先证明探针能读到它。

### 沙箱与本地环境

- 跑任何 node/pnpm/playwright/camoufox 之前先 `. .\scripts\dev-env.ps1`（把各种缓存指进 `./.cache/`）。
- **沙箱禁止把任何子进程 stdio 槽设成 `'pipe'`，而且这个限制会被孙进程继承** —— esbuild、Electron、
  Playwright、Chromium 自己的子进程沙箱全都因此起不来。Chromium 用 `stdio: 'ignore'` + CDP 起也会
  死于 `FATAL:mojo\public\cpp\platform\platform_channel.cc:112`，因为 **Mojo 的平台通道就是命名
  管道**。所以本地 UI 截图、本地打包运行都不可能。
- **本地跑 vitest 有可用配方**（四个墙都能绕）：一个十几行的 preload 本地回答 `net use` 探测、
  命令行 `--pool=threads`（不写 config 文件）、测试写成 `.mjs` 直接 import 构建产物 `dist/`。
  见 `packages/server/test/{run-vitest.mjs,sandbox-preload.mjs}`。否则退回 `tsc` + `biome` + 临时
  harness 跑 `dist`，或 `node --test --test-isolation=none`。CI 不受影响。

### 打包与发布

- **必须发生在打包产物里的步骤，写进 `electron.vite.config.ts`，不要挂在 package script 上。**
  `scripts/build-installer.mjs` 直接跑 `electron-vite build`，**从不调用** `apps/desktop` 的 `build`
  脚本，所以 `cmd && node extra.mjs` 这种链在 CI 和发布里静默不执行。这个坑让 v0.3.0 每次安装都报
  `Cannot find module …\out\main\unzip-worker.js`。
- **根 `package.json` 不能有 `"type": "module"`。** electron-builder 会把辅助工具解到仓库内的
  `.cache/electron-builder/`，根级 ESM 会让 Node 把那些 CJS 文件当 ESM 解析，报
  `ReferenceError: require is not defined in ES module scope`。本仓库脚本全是 `.mjs`，这字段没有收益。
- **`electron` 必须精确版本。** electron-builder 不接受范围（它要下平台二进制），而
  `node-linker=hoisted` 下没有 `apps/desktop/node_modules/electron` 给它解析范围。
- **Electron 主进程必须构建成 CJS。** 开着 `"type": "module"` 时 electron-vite 输出 ESM，而 Electron
  的 `electron` 模块是 CJS 且导出动态定义，于是启动即
  `SyntaxError: … does not provide an export named 'BrowserWindow'`。构建成功、类型检查全过，
  **只有真正运行才会暴露**。
- **`noDefaultViewport: true`，不是 `viewport: null`。** `launchServer` 校验服务端 schema，它只有
  `noDefaultViewport`（`coreBundle.js:20993`）；传 `viewport: null` 会抛 `ValidationError`。
- **`adm-zip` 0.5.x 在 Windows 上会静默导出空目录树。** `addLocalFolderAsync2` 走 `fixPath`
  这个 zip 内部归一化器，绝对 Windows 路径就不存在了，ENOENT 分支直接 resolve 什么都没加。要用
  `fs.readdir(root, { recursive: true, withFileTypes: true })` 逐个 add 文件。
- **引擎约 493 MB，故意不提交、不塞进安装包**，首次运行才下载。
- **便携模式**的数据解析顺序：`VFOX_DATA_DIR` → `process.execPath` 旁边的 `portable` 标记或 `data/`
  目录 → `app.getPath('userData')`。便携 zip 带标记和空的 `data/`；**任何地方都不许持久化绝对
  路径**，否则文件夹一移动就坏。
- **`koffi` 自带各平台预编译二进制**，不需要构建步骤；加进 `pnpm.onlyBuiltDependencies` 只会让
  postinstall 在沙箱里 EPERM 失败。
- **store 的原子写入在 Windows 上会 EPERM**（临时文件 rename 覆盖时目标被占用）；已有 10 次 × 20ms
  重试仍可能失败，见 issue #74。
