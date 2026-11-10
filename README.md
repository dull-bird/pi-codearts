# Pi CodeArts Provider

[![CI](https://github.com/dull-bird/pi-codearts/actions/workflows/ci.yml/badge.svg)](https://github.com/dull-bird/pi-codearts/actions/workflows/ci.yml)

[English quick start](#english-quick-start) · [环境配置](docs/environments.md) · [安全说明](SECURITY.md) · [测试报告](TEST-REPORT.md)

为 **Pi** 接入 CodeArts 的非官方 Provider 插件。直接使用官方网页授权、DPoP Refresh Token 和签名请求，**不启动 CodeArts CLI，不需要本地代理，不要求手工复制 Token**。

- 独立 OAuth 登录，Pi 在调用前自动续期，并持久保存轮换后的凭据。
- 动态发现账号可见的模型、图片能力和服务端公布的思考等级。
- 多环境独立 Provider：官方环境、兼容协议的企业/区域环境分别授权，不混用凭据。
- 流式文本/思考、工具调用与结果回传、图片、取消、busy/idle 心跳。
- 默认不读取或依赖原 CodeArts 客户端登录；临时票据登录不会冒充长期授权。

**不是华为官方项目。不是整个华为云的通用认证插件。** 兼容协议、账号权益与已验证范围见下文。

## 安装

需要 Pi，当前验证版本为 **Pi 1.5.0**。扩展由 Pi 加载，无需自行编译 TypeScript。

```bash
pi install git:github.com/dull-bird/pi-codearts@v0.2.0
```

在正在运行的 Pi 中执行 `/reload`；新启动的 Pi 自动加载。

> 如果此前已手动安装开发软链接，不要再同时安装 Git 包。先移除自己创建的 `~/.pi/agent/extensions/codearts` 链接，再用 `pi install`，避免重复注册。

## 首次使用

1. 在 Pi 执行 `/login`，选择 **CodeArts（官方）**。
2. 在官方浏览器页面完成授权。插件不接触账号密码。
3. 成功后自动发现模型。若目录查询临时失败，执行 `/codearts-refresh`。
4. `/model` 选择 CodeArts 模型，例如：

```text
/model codearts/glm-5.3-flash
```

之后可以直接启动：

```bash
pi --model codearts/glm-5.3-flash
```

**每个使用者登录自己的账号，不共享作者的账号、权益或凭据。没有安装 CodeArts CLI 也可以使用独立登录。**

## 长期登录与自动续期

浏览器授权使用 PKCE 和 ES256 DPoP，取得服务端签发的临时 AK/SK、Security Token 和 Refresh Token。Pi 保存到自己的认证存储，后续在调用前自动刷新；刷新在 Pi 的凭据锁内进行，避免并发轮换冲突。

- 到期时间以服务端响应为准，不硬编码“永久有效”或固定天数。
- 扩展预留 1 分钟；Pi 自己还会应用提前刷新窗口，当前默认约 5 分钟。
- 续期是按需发生的，退出 Pi 后不需要常驻一个登录进程。
- 刷新后的凭据会持久保存，下次启动继续使用。
- **Refresh Token 被撤销、过期或账号政策改变，仍须重新 `/login`。** 长期登录不等于永久绕过服务端认证。
- 默认要求 Refresh Token。旧式临时 ticket 授权、未发放 Refresh Token 的授权会明确失败，不会偷偷退回原客户端登录。

少数旧部署只能临时登录，可在专用环境显式启用 `allowTemporaryLogin`；这会失去自动续期保证。只读复用原客户端也必须显式启用 `allowLocalLogin`。详见[环境配置](docs/environments.md)。

## 思考强度

插件额外查询 CodeArts 的 **thinking-variants 能力接口**，不再只根据模型目录里的 `thinking_type` 判断。只有服务端公布的等级会显示在 Pi 选择器里；缺失等级使用 `null` 排除，而不是把所有模型强行标成可选 low/medium/high。

当前测试账号中：

| 模型 | 服务端公布的思考强度 |
| --- | --- |
| `GLM-5.2` | `high`、`max` |
| `glm-5.2-sft-harmony` | `high`、`max` |
| 其余当前可见模型 | 当前未公布可选强度 |

`GLM-5.2` 的 high 和 max 已分别进行真实推理验证，收到思考流；Pi 的选择会映射为请求中的 `reasoning_effort`。**未公布强度不等于模型本身完全不能思考，只表示此服务当前没有提供可依赖的强度选择。**

刷新能力后，重新选择模型；必要时 `/reload`，使当前选中的旧模型对象也得到更新。Pi 中可使用 `/thinking`（或配置的思考等级快捷键）选择支持的等级，也可：

```bash
pi --model codearts/GLM-5.2 --thinking high
```

## 会不会自动适应服务端变化？

**数据会动态更新，协议不会凭空猜测。**

- 登录时查询目录；交互会话启动时，超过 6 小时的模型缓存会在后台尝试刷新。
- `/codearts-refresh` 可立即重新查询模型和思考等级。
- 新增模型、服务端公布的能力或强度变化，可在接口兼容的前提下自动跟随。
- 兼容协议的其他环境可配置授权入口、Token 服务、API 网关、路径、Client ID、PKCE 方法和模型发现策略。
- 未知域名不会接收已有凭据；探测候选环境只读配置，不扫描网络或逐域名试 Token。
- 如果服务端改了认证协议、签名算法或响应格式，仍需要更新插件。

官方环境目前使用原官方客户端所使用并已验证的北京四服务入口；**这不是按用户位置自动选区，也不能仅凭入口判断模型执行位置或数据驻留政策**。

## 支持范围

| 场景 | 状态 |
| --- | --- |
| 当前官方授权和 `cn-north-4` 网关 | 真实验证 |
| 同协议、不同账号/Agent/区域/企业地址 | 可配置；需相应环境实测 |
| 企业 SSO 最终返回兼容的 CodeArts OAuth 凭据 | 可配置；未宣称全部企业 SSO 已验证 |
| Agent 目录没有固定默认 Agent | 自动发现该账号可访问的其他 Agent |
| 兼容签名认证、使用 OpenAI `/models` 的目录 | 可配置 `openai` 发现策略 |
| 没有发现接口的兼容部署 | 可配置静态模型及明确的思考等级 |
| 认证协议完全不同的私有部署 | 需要新适配器，不保证只换地址即可 |
| 华为云其他产品账号、任意 API Key | 不据此认定兼容 |

目前发现的 11 个模型不是发布时的硬编码模型清单；账号权限、可见模型和积分以服务端为准。

## 命令

| 命令 | 用途 |
| --- | --- |
| `/login` | 独立登录官方环境或已配置的其他环境 |
| `/codearts-refresh [provider-id]` | 刷新该环境的模型和思考能力 |
| `/codearts-status [provider-id]` | 登录来源、续期能力、到期时间、网关和思考等级；不显示秘密 |
| `/codearts-environments` | 列出已信任的环境，不发送认证请求 |
| `/codearts-configure [id]` | 从完整本机配置导入候选环境，或手动配置，确认后单独授权 |

未指定环境时，优先使用当前选中的 CodeArts Provider，否则使用官方 `codearts`。其他环境如 `company` 注册为 `codearts-company`。

## 配置、凭据和缓存

默认目录：

```text
~/.pi/agent/codearts.json                  用户明确配置的环境；不是认证文件
~/.pi/agent/auth.json                      Pi 管理的敏感凭据，请勿分享
~/.pi/agent/codearts-models.json            官方环境模型缓存，不含凭据
~/.pi/agent/codearts-models-<id>.json       其他环境的隔离缓存
```

遵循 Pi 的 `PI_CODING_AGENT_DIR`。`PI_CODEARTS_CONFIG` 可指定个人环境配置文件。**不自动读取项目仓库里的端点配置，以免项目文件把凭据引向陌生服务器。** 企业地址本身也可能敏感，不要随意把个人配置提交到 Git。

已有 v0.1 独立官方凭据可继续使用；无需为了升级立即重新授权。其他环境必须分别授权；变更认证地址会使原绑定失效，而不是迁移 Refresh Token。

## 更新和移除

上面的版本标签安装固定在 v0.2.0。升级时安装新的版本标签，并移除旧的包声明。若希望手动跟随 main，可不指定标签：

```bash
pi install git:github.com/dull-bird/pi-codearts
pi update --extensions
```

更新后 `/reload`。不后台下载执行新代码。

用 `pi list` 查看实际安装来源，再用 `pi remove <source>` 移除。移除插件不会改写原 CodeArts 客户端认证文件。需要删除 Pi 的独立登录时，先通过 Pi `/logout` 操作。

## 开发与测试

```bash
git clone https://github.com/dull-bird/pi-codearts.git
cd pi-codearts
npm ci --ignore-scripts
npm run check
npm test
```

宿主包是 peer dependencies，开发依赖用于离线测试；发布包不捆绑另一份 Pi，也没有额外运行时 npm 依赖。测试使用 Node 24/26；插件运行时由 Pi 加载 TypeScript。

```bash
npm run test:live      # 真实文本、工具、取消、图片、思考强度；需先独立登录
npm run test:e2e       # 真正运行 Pi，执行临时目录里的 read 工具
npm run test:refresh   # 在凭据锁内真实刷新 Pi 自有凭据，再用新进程验证持久登录
npm run test:login     # 重新打开浏览器，走 Pi 原生登录，再测试真实刷新
```

**真实测试会消耗少量账号额度。** 只上传固定测试文本、本地生成的 PNG 和临时测试文件，不上传用户项目。`test:login` 会更新 Pi 的 CodeArts 登录，不作为普通离线回归的一部分。离线 CI 不使用账号或 secrets。

费用字段当前为 0，表示没有配置可直接换算的现金定价，**不代表 CodeArts 免费**。兼容性限制、测试详情和安全边界见对应文档。

## English quick start

An unofficial **Pi extension package registering a CodeArts provider**. Native browser OAuth with refresh-token rotation; no CodeArts CLI subprocess and no local proxy.

```bash
pi install git:github.com/dull-bird/pi-codearts@v0.2.0
```

In Pi: `/reload`, `/login` → CodeArts, then `/model`. Each user authorizes their own account. Models and supported reasoning levels are discovered from the service, not copied from the author's account. Compatible enterprise endpoints can be configured as separate, credential-isolated providers; arbitrary Huawei Cloud products and incompatible SSO deployments are not automatically supported. Refresh tokens can still be revoked by the service.

MIT licensed. Not affiliated with or endorsed by Huawei. Use only with authorized accounts and in accordance with applicable service terms and organizational policies.
