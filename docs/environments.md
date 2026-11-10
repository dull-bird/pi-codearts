# 服务环境与兼容性

## 设计边界

这里的“自适应”不是扫描网络、读取作者账号的模型清单，也不是把任意华为云账号转换成模型权限。

- **动态数据**：从账号的 Agent/model/variant API 查询，缓存后用于 Pi。
- **可配置协议参数**：可信服务地址、路由、Client ID、PKCE 方法、scope、目录策略。
- **不可自动猜测的变化**：新签名算法、完全不同的 Token 响应、新的 SSE 协议或非兼容 SSO。需要适配器版本更新。

认证仍要求 CodeArts 的 PKCE/DPoP 和临时签名凭据协议。`discovery: "openai"` 只表示使用 OpenAI 风格的模型目录，不会把认证切换成普通 Bearer API Key。

## 零配置官方登录

`codearts` 是保留的官方 Provider，使用验证过的端点。v0.1 的独立官方 OAuth 凭据向后兼容；新登录会携带环境绑定。

不接受通过用户配置替换官方授权或 Token 地址。需要其他区域、站点或专有网关时，新建一个单独环境，避免将已签发的官方 Refresh Token 发送到其他服务器。

## 添加环境

推荐在 Pi 使用：

```text
/codearts-configure company
```

插件会只读检查已知客户端 JSON 配置中的完整端点信息；有候选时让用户选择，没有时手动填写。**发现不是信任**：显示 API、授权、Token 地址并确认后才保存，之后还要为这个 Provider 单独 `/login`。

识别目前支持已知路径中的显式字段：

```json
{
  "provider": {
    "inferhub-provider": {
      "options": {
        "inferhubBaseUrl": "https://gateway.example",
        "authorizeUrl": "https://sso.example/authorize",
        "tokenUrl": "https://identity.example/token",
        "clientId": "CodeArts_Tui"
      }
    }
  }
}
```

读取位置为 `~/.codeartsdoer/codearts_cli.json` 和 `~/.codeartsdoer/codearts-data/codearts.json`。这只是已识别的配置形状，**不是保证所有客户端都存在这些字段**。缺少授权/Token 地址时不会根据一个域名臆测其他地址，也不执行客户端二进制。完全没有客户端时，官方独立授权仍然可用。

## 配置文件

默认 `~/.pi/agent/codearts.json`，仅从个人 agent 目录读取；`PI_CODEARTS_CONFIG` 可覆盖完整路径。配置不含凭据，但企业域名本身可能敏感，不建议提交到项目仓库。

```json
{
  "version": 1,
  "environments": [
    {
      "id": "company",
      "label": "CodeArts — Company",
      "apiOrigin": "https://gateway.example",
      "authorizeUrl": "https://sso.example/codearts/authorize",
      "tokenUrl": "https://identity.example/v1/oauth2/tokens",
      "clientId": "CodeArts_Tui",
      "pkceMethod": "SHA-256",
      "discovery": "agents"
    }
  ]
}
```

这些 `.example` 地址是占位符，必须替换为管理员提供并核实的地址，不会实际部署服务。

重新 `/reload` 后：

```text
/login
```

选择 `CodeArts — Company` 独立授权，然后：

```text
/codearts-refresh codearts-company
/model codearts-company/<模型ID>
```

### 字段

| 字段 | 默认值/用途 |
| --- | --- |
| `id` | 必填；1–40 个小写字母、数字或短横线，字母开头；`official` 保留 |
| `label` | 显示名称，默认 id |
| `apiOrigin` | 必填；HTTPS origin，不带路径 |
| `authorizeUrl` | 必填；授权页完整 URL，不带 query/fragment |
| `tokenUrl` | 必填；Token 服务完整 URL，不带 query/fragment |
| `clientId` | 必填；由该服务支持的 OAuth Client ID |
| `pkceMethod` | `SHA-256`；兼容环境也可设 `S256` |
| `scope` | 可选；发送给授权页的 scope |
| `stateMode` | `pkce`（已验证的 CodeArts 非标准回调依赖 PKCE）；标准 state 回传环境用 `required` 严格检查 |
| `agentId` | 可选；明确指定 agent_id 或 original_id，不存在时明确报错 |
| `discovery` | `agents` / `openai` / `static` |
| `models` | 可选；静态目录或同 ID 的完整元数据覆盖条目 |
| `allowTemporaryLogin` | `false`；显式允许不能续期的临时授权 |
| `allowLocalLogin` | `false`；显式允许只读复用本机登录 |
| `localAuthDir` | 默认 `~/.codeartsdoer/cli-data`；只读兼容模式的目录 |
| `paths` | 可选；覆盖下面的服务路径 |

### 默认路径

```json
{
  "account": "/snap-manager/v1/current/user",
  "agents": "/v1/agent-center/agents/useragents",
  "detail": "/v1/agent-center/agents/detail",
  "chat": "/api/v2/chat/completions",
  "heartbeat": "/snap-manager/v1/chat-session/heartbeat",
  "models": "/v1/models",
  "variants": "/v1/model/thinking-variants"
}
```

路径必须为同 origin 的绝对路径，不接受 `//host`、查询参数、fragment、路径穿越或反斜杠。`chat` 必须以 `/chat/completions` 结尾。可将 `account`、`heartbeat`、`variants` 设为 `null`，用于确实没有这些可选接口的兼容部署；关闭 heartbeat 的环境需要自行确认服务端会话资源管理语义。

## 模型发现

### `agents`（默认）

1. 分页读取账号可见 Agent，单次最多 100，安全上限 1,000 条。
2. 显式指定 `agentId` 时使用该 Agent；不存在时报错。
3. 未指定时优先使用已验证的官方默认 Agent。该 Agent 不可访问/没有模型时尝试其他可见 Agent。
4. 没有官方默认 Agent 的租户，读取其可访问 Agent 的模型并按模型 ID 去重。
5. 再批量查询模型的思考强度，每批最多 50 个模型。

不会把固定 Agent ID 的存在当成所有租户都能使用的前提。服务端的权限拒绝不会通过换账号或绕过权限处理。

### `openai`

GET `paths.models`，接受 `{ "data": [{ "id": "..." }] }` 风格目录。认证仍为该环境的 CodeArts 签名认证。缺少的上下文/输出限制使用保守默认值，必要时通过 `models` 提供准确元数据。

### `static`

需要显式提供 `models`，不查询目录接口。适用于管理员确认协议兼容，但未部署目录服务的环境。例如：

```json
{
  "discovery": "static",
  "models": [
    {
      "id": "private-model",
      "name": "Private model",
      "contextWindow": 131072,
      "maxTokens": 8192,
      "input": ["text"],
      "reasoning": true,
      "thinkingLevelMap": {
        "off": null,
        "minimal": null,
        "low": "low",
        "medium": null,
        "high": "high",
        "xhigh": null,
        "max": null
      }
    }
  ]
}
```

只有管理员/服务文档确认支持时才填写强度。`null` 从 Pi 选择器中排除该档。缺失字段在 Pi 中可能触发默认档位，因此有限强度集合建议完整填写 7 个键。不要用不真实的等级假装支持多档思考。

## 授权回调差异

真实回归发现，当前官方入口返回的 callback `state` 不是扩展传入的标准 OAuth state；不能把“所有叫 state 的字段”都当成同一个协议。默认 `stateMode: "pkce"` 不发送/验证自定义 state，而是使用每次随机的 PKCE verifier、临时 loopback listener 和 DPoP 换取绑定凭据。对于明确支持原样回传标准 OAuth state 的兼容部署，可设置 `stateMode: "required"`，缺失或不匹配都拒绝。不会登录失败后静默关闭 state 检查去试别的服务器。

## 凭据隔离

- `official` → `codearts`；`company` → `codearts-company`，在 Pi auth.json 下分别存储。
- 新 OAuth 凭据绑定环境 ID、API origin、授权地址、Token 地址、Client ID、scope、PKCE 方法和回调 state 模式。
- 改动这些认证目标后，旧凭据拒绝继续发送；需要重新授权。
- 模型缓存也携带环境指纹；地址改变后不会复用旧缓存。
- 旧版未绑定凭据只允许迁移到原官方环境，不能拿到任意自定义地址试用。
- 不根据 Token、授权响应或项目文件中的陌生域名自动放行。

## 旧式登录（可选，不推荐）

官方环境仅允许覆盖以下非端点选项：

```json
{
  "version": 1,
  "official": {
    "allowLocalLogin": true
  },
  "environments": []
}
```

这会在 `/login` 中增加只读复用本地登录的选项；**不会自动回退到它**。只存只读标记，不复制轮换凭据，不使用原客户端的 Refresh Token。原客户端到期且没有更新时，该模式会失效。

`allowTemporaryLogin: true` 允许 ticket 或无 Refresh Token 的授权，状态中会明确标为不可续期。默认关闭，适合明确接受此限制的旧部署，不能用于承诺长期登录。

自定义环境的本机凭据还必须通过原记录的环境标识匹配，防止错把官方本机登录用于陌生服务器。

## 网络、浏览器与企业证书

- 所有认证和推理保持 HTTPS 证书校验，不提供跳过 TLS 验证的开关。
- 私有 CA 应通过组织批准的证书部署方式配置，例如启动 Node/Pi 前设置 `NODE_EXTRA_CA_CERTS`，而不是 `NODE_TLS_REJECT_UNAUTHORIZED=0`。
- 浏览器授权使用随机端口 `127.0.0.1` 回调。远程开发机、容器或无浏览器机器需要可靠的浏览器访问和 loopback 转发；目前没有宣称支持 device-code 流程。
- 本机只读存储适配当前 CodeArts 客户端布局；其他版本/平台的布局未逐一实测，可显式指定目录，但不能保证所有“登录器”通用。
- 客户端本身是否通过企业 SSO、商业套餐或内部入口获得权限，不能仅凭域名判断。请遵守组织的数据与接入政策。
