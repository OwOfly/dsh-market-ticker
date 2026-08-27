# dsh-market-ticker

DeepSeek Harness (DSH) Web GUI 的「行情终端条」插件。把原「交易终端」(trading) 皮肤内置的行情能力抽成独立插件，**换任何皮肤都能用**，并支持在页面内直接自定义全部配置。

![preview](https://img.shields.io/badge/dsh-%3E%3D0.1.0--rc.8-blue)

## 功能

三件套（均可独立开关）：

| 区域 | 内容 |
|------|------|
| 仿终端标题栏 | 品牌 K 线 logo + 自定义标题 + 行情 chips + 窗口装饰按钮 |
| 行情跑马灯 | 自选标的无缝循环滚动，悬停暂停 |
| 底部指数状态栏 | A股/港股/美股市场时段 + 指数报价 |

**自定义设置**：任意行情条上 hover 找到 ⚙ 齿轮（标题栏齿轮常显），弹出设置浮层：

- 三个区域 + 市场时段的显隐开关
- 跑马灯自选标的列表、状态栏指数列表
- 刷新间隔（5~600 秒）、标题栏 chips 数量（0~8）、标题文字
- 红涨绿跌 ↔ 绿涨红跌 一键切换
- 标签页标题/图标的钉住开关

保存写入 `localStorage` 即刻生效，刷新浏览器保留。

## 标的语法

| 市场 | 语法 | 示例 |
|------|------|------|
| A股/指数 | `sh`/`sz` + 代码 | `sh000001`、`sz300059` |
| 港股/指数 | `hk` + 代码 | `hkHSI`、`hk00700` |
| 美股/指数 | `us` + 代码 | `usAAPL`、`usIXIC` |
| 加密货币 | 大写交易对 | `BTCUSDT`、`ETHUSDT` |
| 外汇 | 三三位货币对 | `USD/CNY` |

若安装了 `dsh-fun-ticker` 插件，跑马灯会优先跟随其自选列表（同源代理）。

## 数据源（三级降级）

1. **dsh-fun-ticker 同源代理** `/plugins/dsh-ticker/api/*`（未安装自动跳过）
2. **腾讯财经** `qt.gtimg.cn` — A股/港股/美股/指数
3. **币安 Binance** `api.binance.com` / `data-api.binance.vision` — 加密货币；**Frankfurter** `api.frankfurter.dev` — 外汇

所有源失败时显示占位符，下一个刷新周期自动重试。

## 安装

```powershell
dsh plugin --profile web add dsh-market-ticker
```

安装后需要**重启 dsh web 进程**（新装静态插件的宿主注册表只在启动时构建），再硬刷新浏览器（Ctrl+Shift+R）。

> 本地源码调试可用 link 方式：把包放进 profile 的 pnpm workspace 并以 `link:` 依赖安装后重启。

## 与 trading 皮肤的关系

本插件复刻了 trading 皮肤的行情 chrome，两者同时启用会**双重显示**。建议二选一：

- 使用本插件：切换 active 皮肤到其他皮肤（如 blue-fantasy）
- 继续用 trading 皮肤：不要安装本插件

注意：本插件自带全部配色变量与深浅色主题适配，不依赖任何皮肤的私有变量。

## 故障排查

| 现象 | 处理 |
|------|------|
| 安装后无齿轮/无行情条 | 重启 dsh web 后硬刷新；console 应有 `[dsh-market-ticker] client half registered` |
| 浏览器 console 报 `loaded without registering` | client.js 形态损坏，重新安装插件包 |
| 页面顶部内容被遮挡 | 设置中关闭不用的顶部区域，或反馈宿主皮肤的 padding 冲突 |
| 行情一直显示 `--` | 公共行情源网络不可达或代理拦截，检查浏览器 Network 里 `qt.gtimg.cn` 请求 |

## 兼容性

- DSH >= 0.1.0-rc.8，web profile
- Chromium 内核现代浏览器（依赖 CSS 变量、AbortSignal.timeout 降级安全）

## License

MIT © 2026 OwOfly (姚鹏飞)
