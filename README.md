# ApusPay (天燕付) 易支付独立版网关

> 纯净、现代、高性能的自部署聚合支付网关（Codename: Strelizia True Apus）。完全兼容易支付（EasyPay）V1 与 V2 协议标准，适用于任何电商、发卡系统、会员站点及 SaaS 平台。

[![Bun](https://img.shields.io/badge/Bun-1.4%2B-black?logo=bun)](https://bun.sh)
[![React](https://img.shields.io/badge/React-19-blue?logo=react)](https://react.dev)
[![Hono](https://img.shields.io/badge/Hono-v4-E36002?logo=hono)](https://hono.dev)
[![EasyPay](https://img.shields.io/badge/EasyPay-V1%20%26%20V2-green)]()
[![License](https://img.shields.io/badge/License-MIT-purple)]()

---

## 🌟 核心特性

- **标准易支付兼容**：
  - **EasyPay V1**：支持 `submit.php`（收银台跳转）、`mapi.php`（接口直连免跳转返回二维码与链接）、`api.php?act=order`（订单查询）。
  - **EasyPay V2**：全面支持 RSA 非对称签名、`/api/pay/create`、`/api/pay/query`、`/api/merchant/orders` 等规范。
  - 完美对接各类发卡网（如独角数卡、异世界发卡）、WordPress/WooCommerce、Faka 等所有支持易支付的平台。
- **全渠道支付支持**：
  - **支付宝官方当面付（F2F）**：官方商户 API，自动生成预下单二维码，支持移动端 Alipay Scheme 直接拉起支付。
  - **支付宝经营码 / 账单流水**：支持个人经营码收款，自动浮动分匹配，通过官方开放平台账单 API 自动轮询对账。
  - **支付宝转账码**：转账备注匹配模式，零成本免签约。
  - **微信支付官方 Native（APIv3）**：官方商户直连，Native 二维码下单与 APIv3 签名校验 / AES-256-GCM 异步回调。
  - **微信收款码 Hook 监听**：保留独立 Windows PC Hook 辅助工具（`wechat-hook/`），通过 HTTP Webhook 自动对账免挂机。
- **纯净现代化架构**：
  - 彻底移除旧版中所有的 Minecraft Bukkit 插件、NMS 包处理、Java CLI 运行时等无关代码。
  - 前端采用 **React 19 + TailwindCSS v4 + Lucide**，内置沉浸式自适应双主题（支付宝经典蓝 / 微信生态绿）收银台与现代化管理后台。
  - 后端采用 **Bun + Hono + bun:sqlite**，单进程自包含，内存占用 < 50MB，毫秒级冷启动与超高并发。

---

## 🚀 快速开始

### 方式一：本地使用 Bun 运行

需要先安装 [Bun](https://bun.sh)（>= 1.3.0）：

```bash
# 1. 安装依赖
bun install

# 2. 启动开发服务器（API + Webpack/Vite 前端热重载）
bun run dev

# 3. 或者构建前端并以生产模式启动
bun run build
bun run start
```

服务默认运行在 `http://localhost:3000`。首次访问将进入初始化向导，设置管理员账号与初始商户密钥。

### 方式二：Docker / Docker Compose 部署

我们提供了针对 Bun 优化的一键 Docker Compose 配置：

```bash
# 启动容器
docker-compose up -d

# 查看日志
docker-compose logs -f
```

数据与上传文件会自动持久化在 `./data` 目录下。

---

## ⚙️ 支付渠道配置

在后台 **「通道设置」** 页面中即可直接在线配置，无需重启服务：

### 1. 支付宝配置
- **当面付（推荐）**：填入支付宝开放平台 `AppId`、应用私钥、支付宝公钥，选择模式为「当面付（F2F）」。
- **经营码对账**：上传支付宝经营码，配置有账单查询权限的开放平台凭据，系统会自动开启 `0.01` ~ `0.99` 元浮动金额排队对账。
- **转账备注**：配置支付宝商户 UID，买家付款时备注订单号自动匹配。

### 2. 微信支付配置
- **官方 Native（APIv3）**：填入微信支付商户号（MchId）、AppId、商户 API 证书序列号、商户 APIv3 密钥及私钥。系统自动接收并解密微信官方回调。
- **个人静态收款码 + PC Hook**：上传个人微信赞赏/收款码，在后台设置 Hook Token；将 `wechat-hook` 运行在挂机 PC 上，微信收到转账后会自动向 `/api/hook/receive` 推送入账消息并核销订单。

---

## 🔌 易支付接入文档

### 易支付 V1 规范

- **网关地址**：`http(s)://your-domain.com/`
- **商户 ID (PID)**：后台「商户密钥」中展示的 PID（如 `1000000001`）
- **商户密钥 (KEY)**：后台设置的 MD5 通信密钥

#### 接口列表
1. **收银台页面跳转**：
   - 方式：`GET` / `POST`
   - 路径：`/submit.php`
   - 参数：`pid`, `type` (`alipay` 或 `wxpay`), `out_trade_no`, `notify_url`, `return_url`, `name`, `money`, `sign`, `sign_type="MD5"`
2. **API 免跳转下单**：
   - 方式：`POST`
   - 路径：`/mapi.php`
   - 返回 JSON：`{ code: 1, msg: "success", trade_no: "...", qrcode: "...", payurl: "..." }`
3. **订单查询接口**：
   - 方式：`GET`
   - 路径：`/api.php?act=order&pid={PID}&key={KEY}&out_trade_no={商户单号}`

### 易支付 V2 规范（RSA）

- **接口地址**：`/api/pay/create`
- **签名算法**：SHA256WithRSA
- **接口说明**：商户使用在后台登记的商户私钥签名请求，平台自动使用平台私钥对响应数据进行签名校验。

---

## 🛠️ 测试与质量验证

本项目拥有完整且严格的自动化测试套件：

```bash
# 执行类型检查（TypeScript）
bun run typecheck

# 执行单元测试与合约测试
bun run test

# 执行端到端完整构建与检验
bun run check
```

---

## 📁 目录结构

```
apuspay/
  ├── src/
  │   ├── server/           # Hono 后端服务
  │   │   ├── index.ts      # 主入口与生命周期托管
  │   │   ├── admin.ts      # 管理后台 API
  │   │   ├── alipay.ts     # 支付宝当面付与对账轮询
  │   │   ├── wechat.ts     # 微信支付 Native APIv3 服务
  │   │   ├── easypay.ts    # 易支付 V1/V2 协议网关
  │   │   ├── orders.ts     # 订单流转与状态机
  │   │   ├── db.ts         # SQLite 数据库模型与升级
  │   │   ├── notifications.ts # 异步通知队列与重试
  │   │   └── security.ts   # MD5/RSA/AES 加密与验签
  │   ├── web/              # React 19 前端界面
  │   │   ├── pages/        # 收银台、仪表盘、通道设置、订单明细等
  │   │   └── components/   # UI 组件库
  │   └── shared/           # 前后端通用类型契约与接口
  ├── tests/                # 自动化测试用例
  ├── wechat-hook/          # 独立微信 PC Hook 挂机工具（C#）
  ├── Dockerfile            # 生产 Docker 镜像配置
  └── docker-compose.yml    # 一键容器化部署
```

---

## 📄 开源许可

本项目遵循 [MIT License](LICENSE) 开源协议。
