<div align="center">

# ⚙️ AI Pet Studio · Backend

**为宠物图片与视频创作提供任务、积分和媒体 API。**

独立部署在 Cloudflare Workers 的 TypeScript 服务端。

[在线 Web 产品](https://ai-pet-studio-web.yangf999212.workers.dev/) ·
[Web 前端](https://github.com/yf9182/AIPetStudio-Web) ·
[iOS 客户端](https://github.com/yf9182/AIPetStudio--iOS)

![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)
![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)
![Tests](https://img.shields.io/badge/tests-Node.js-339933?logo=nodedotjs&logoColor=white)

</div>

## 🧭 服务职责

Worker 为 iOS 与 Web 提供一组共享的业务 API，处理用户会话、图片上传、生成任务、积分账本和购买回调。AI 任务交由 Vidu 执行；D1 保存业务记录，R2 保存私有上传文件。

~~~mermaid
flowchart LR
    A[iOS App] --> W[Cloudflare Worker API]
    B[Web Server] --> W
    W --> D[(D1 · 用户 / 任务 / 积分)]
    W --> R[(R2 · 私有输入媒体)]
    W --> V[Vidu · 图片与视频生成]
    P[RevenueCat / Stripe] -->|签名回调| W
    W --> G[Gemini · 宠物声音解读]
~~~

## 🌟 主要能力

- **会话与账户：** 设备会话、令牌校验、账户资料与删除
- **图片与视频任务：** 上传输入图片、创建任务、查询任务与结果
- **积分账本：** 余额、交易记录、购买入账、回调去重和失败补偿
- **宠物声音互动：** 宠物声音情绪解读、人的语音转写后匹配审核过的猫狗声音
- **支付回调：** RevenueCat App 内购买与 Stripe Web 购买
- **定时维护：** 清理过期任务资源并重试待处理的补偿记录

任务价格在 Worker 服务端固定：图像任务 10 积分、视频任务 50 积分。客户端提交的素材快照会经过字段校验并随任务保存，后续重试使用同一份快照。

## 🔌 API 一览

| 能力 | 入口 |
| --- | --- |
| 会话 | POST /v1/session/bootstrap、/challenge、/refresh |
| 账户与积分 | GET /v1/me、/v1/wallet、/v1/wallet/transactions |
| 上传与任务 | POST /v1/uploads/images、/v1/tasks；GET /v1/tasks |
| 宠物声音互动 | POST /v1/pet-translator/pet-to-human、/human-to-pet |
| 支付回调 | POST /v1/webhooks/revenuecat、/v1/webhooks/stripe |
| 健康检查 | GET /healthz |

完整请求格式、响应字段和边界条件见 docs/implementation-reference.md；宠物声音功能的 App 接入说明见 docs/pet-translator-app-integration.md。

## 🧰 技术选型

TypeScript · Cloudflare Workers · D1 · R2 · Vidu · Gemini · RevenueCat · Stripe

## 🚀 本地运行

需要 Node.js 和 npm。

~~~bash
npm install
npm run typecheck
npx wrangler d1 migrations apply ai-pet-studio-db --local
npx wrangler dev --local --port 8787
~~~

环境变量示例在 [.dev.vars.example](.dev.vars.example)。本地可以运行健康检查：

~~~bash
curl http://localhost:8787/healthz
~~~

运行测试：

~~~bash
npm test
~~~

本地任务生成、支付回调和宠物声音互动需要相应的测试配置或服务凭据；真实密钥应放在本地忽略文件或 Cloudflare Worker Secrets 中，不要提交到仓库。

## 🗂️ 相关仓库

- [Web 客户端](https://github.com/yf9182/AIPetStudio-Web)
- [iOS 客户端](https://github.com/yf9182/AIPetStudio--iOS)
- [素材管理平台](https://github.com/yf9182/material-hub)

<details>
<summary>查看部署顺序与详细业务契约</summary>

原 README 中的 D1 迁移、Worker Secret、任务快照、支付 Webhook 与宠物声音库配置说明已保留在 [docs/implementation-reference.md](docs/implementation-reference.md)。

</details>
