# 测试报告：v0.2.0

日期：2026-11-10。真实账号回归环境：macOS arm64、Node 26.13.0、Pi 1.5.0。

## 最终结果

| 检查 | 结果 | 验证方式 |
| --- | --- | --- |
| 全新开发依赖安装 | 通过 | `npm ci --ignore-scripts`；不再依赖作者机器的 Homebrew 包链接 |
| TypeScript | 通过 | `npm run check` |
| 离线回归 | **66/66 通过** | `npm test`，包含打包及隔离 Pi home 安装 |
| GitHub Actions | 通过 | Linux Node 24、Node 26 两个任务均成功：[CI 记录](https://github.com/dull-bird/pi-codearts/actions/runs/42845746725) |
| 公开 GitHub 源安装 | 通过 | 从真实仓库执行 `pi install git:...@<commit>`，隔离 HOME 成功加载插件，使用纯模拟凭据离线注册模型 |
| 官方 Pi 原生登录 | 通过 | `ModelRuntime.login` → 官方浏览器 → PKCE/DPoP → 保存凭据 |
| 登录后立即有模型 | 通过 | 登录后的 Pi 模型列表非空；发现 11 个模型 |
| 真实自动续期协议 | 通过 | 只在 Pi 自有凭据锁内执行真实 Refresh Token 请求 |
| 刷新后真实请求 | 通过 | 新凭据查询模型目录，11 个模型 |
| 新进程持久登录 | 通过 | 启动新 Node/Pi Runtime，读取已保存的新凭据并再次成功认证 |
| 旧官方独立登录兼容 | 通过 | 升级前凭据在新代码中仍可访问，不需要依赖原客户端 |
| 中文文本/SSE/usage | 通过 | `glm-5.3-flash` 真实推理 |
| 工具流/参数解析/结果回传 | 通过 | lookup 调用及固定验证码回传 |
| 流中取消 | 通过 | 收到 delta 后 abort，得到 aborted |
| 图片输入/图片工具结果 | 通过 | 生成的红色 PNG，视觉模型正确识别 |
| 思考强度发现 | 通过 | 独立 thinking-variants API 返回 GLM-5.2 两个型号的 high/max |
| high 与 max 实际生效的请求映射 | 通过 | `GLM-5.2` 分别发送 high/max，请求中对应 reasoning_effort，收到真实思考流并回答 13×17=221 |
| 会话心跳和释放 | 通过 | busy/idle 签名请求均 HTTP 200，最终 idle |
| Pi 工具执行端到端 | 通过 | 真正运行 Pi → CodeArts → read 临时文件 → 工具结果 → 最终答案 |
| 原客户端认证文件未写入 | 通过 | 真实推理前后 auth.json SHA-256 一致；从未用其 Refresh Token 续期 |
| 全局模型注册 | 通过 | `pi --list-models codearts`；11 个模型，两个型号标为支持思考 |

**强度测试验证了请求参数、服务端接受和实际思考流，不声称仅凭两次简单算术题就能量化高低强度的质量差异。**

## 66 项离线测试的范围

- HMAC 签名、DPoP ES256 验签、方法/URL 绑定与唯一 jti。
- 本机 AES/scrypt 存储格式的只读导入；不刷新原客户端凭据。
- 独立刷新轮换、无新 refresh token 时保留旧值、撤销和异常响应。
- Pi 真正的自动过期刷新路径：5 个并发认证请求只刷新一次并保存轮换结果。
- 原生 Pi 登录成功后自动发布模型；失败登录保留原来存储的凭据。
- 禁止无授权时自动读取本机登录；默认拒绝 ticket/无 Refresh Token 的假长期登录。
- 官方非标准 callback state 与 PKCE 的兼容回归；标准 required-state 环境的匹配/缺失/错误检查。
- 授权拒绝、取消、超时、监听端口清理。
- HTTPS、URL userinfo、query/fragment、非法路径、穿越、未知模式的配置拒绝。
- 跨环境凭据拒绝、认证地址变更后强制重新授权、自定义 DPoP/Client ID 路由。
- 各环境 Provider/凭据/缓存隔离；无完整配置时不猜测域名。
- 配置损坏不移除官方 Provider；模型缓存指纹和 TTL。
- 其他租户 Agent、分页、重复模型；OpenAI 目录及静态目录策略。
- 思考等级从能力 API 获取，Pi 只显示实际支持档位，请求映射正确。
- Unicode 字节拆分、工具参数流、事件配对、usage、空响应、跨 Provider 重放。
- 请求/响应/Provider Event hooks；取消、截断、坏 JSON、上下文错误、限流及 HTTP-200 网关错误。
- 认证解析错误不回显响应或凭据原文。
- 心跳引用计数、排空期间新请求、周期计时器与关闭清理。
- 发布 tarball 白名单；无 node_modules、认证文件、研究材料或测试账号数据。
- tarball 解包后，通过 `pi install` 在隔离 HOME 安装：未登录时不假装可用；放入纯模拟凭据后离线注册模型，无需 CodeArts CLI。

坏 JSON 测试会使宿主 OpenAI 解析器输出两行预期诊断，测试正常通过；内容为合成数据。

## 本轮真实回归发现的协议差异

此前只看 `thinking_type` 会漏掉可选强度；现查询单独的 `/v1/model/thinking-variants`，使用服务端 strengths。

真实原生授权回归还发现官方 callback state 并非原样回传的扩展 OAuth state。错误的标准化假设会导致登录失败，因此已按已验证的 CodeArts 协议采用 PKCE 模式；提供明确的 `stateMode: "required"` 给会回传标准 state 的兼容环境。该修复经过再次真实登录、刷新和新进程验证，失败尝试没有覆盖旧凭据。

## 未声称验证的项目

- 没有逐一推理测试全部可见模型；模型列表及能力会随服务端变化。
- 未在其他公司的内网、其他区域或其他商业账号上做真实登录。对应多环境与协议选项已做模拟回归，不等于所有企业版本都兼容。
- 未等待数小时让真实 Access Token 自然过期。真实刷新和跨进程持久登录已验证；过期触发与并发互斥在真实 Pi Runtime 配合模拟服务端验证。
- 未真实耗尽上下文、积分、并发数或限流额度；相应错误分支使用合成响应。
- 未宣称支持任意 OIDC/SSO、device-code、任意华为云 API Key 或完全不同的私有协议。
- CI 已在 Linux Node 24/26 通过，但只运行无真实账号测试；真实账号回归不进入公共 CI。

## 重跑

```bash
npm ci --ignore-scripts
npm run check
npm test
npm run test:live
npm run test:e2e
npm run test:refresh
```

需要重新验证授权入口时另行运行 `npm run test:login`。真实测试会消耗少量额度，授权与续期测试会更新 Pi 自有凭据；不修改原 CodeArts 客户端认证文件。
