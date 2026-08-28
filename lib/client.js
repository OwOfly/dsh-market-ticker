/**
 * dsh-market-ticker — 行情终端条（客户端半区）
 *
 * 从「交易终端」(trading) 皮肤的 hooks.mjs 完整移植行情能力并抽成独立插件：
 * - 三件套 UI：① 仿终端标题栏（logo + 标题 + 行情 chips + 窗口装饰）
 *              ② 中部行情跑马灯（无缝双拷贝滚动）
 *              ③ 底部指数状态栏（A股/港股/美股时段 + 指数报价）
 *   三个区域均可在设置中独立开关。
 * - 数据源三级降级：dsh-fun-ticker 同源代理 → 腾讯 qt.gtimg.cn（A股/港美股/指数，
 *   script-tag 加载）→ 币安 Binance（加密货币）+ Frankfurter（外汇）。
 * - 自定义设置：⚙ 齿轮弹出设置浮层，保存到 localStorage 即刻生效、刷新保留；
 *   可配置自选标的、指数列表、刷新秒数、chip 数量、标题文字、红涨绿跌方向、
 *   时段显示、标签页标题/图标的钉住行为。
 * - 配色自带（--mt-* 变量，浅/深色主题跟随 body[data-ds-dark-theme]），
 *   不依赖任何皮肤私有变量，跨皮肤可用。
 *
 * 静态 bundle 形态：客户端半区必须经 window.__ModuleLoader__.load({id, factory})
 * 注册（client-modules 只认该形态，裸 ESM 导出会报 "loaded without registering"）。
 * factory 采用官方产物的 CJS 约定：factory(require) → module.exports；
 * 本插件无外部模块依赖，require 参数不使用。
 * id 与 URL /plugins/<id>/client.js 中的包名一致。
 * 兼容 DSH >= 0.1.0-rc.8。
 */

window.__ModuleLoader__.load({
	id: 'dsh-market-ticker',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		/** 本插件不需要等待任何 cordis 服务（纯 DOM 操作）。 */
		const inject = [];

		/* ════════════════════════ 设置系统 ════════════════════════ */

		/** localStorage 键；升级 schema 时换版本号即可无损迁移。 */
		const LS_KEY = 'dsh-market-ticker/settings/v1';

		/** 出厂默认值（即原 trading 皮肤的自定义配置：19 个自选 + 默认指数列）。 */
		const DEFAULTS = {
			showTitlebar: true,
			showTape: true,
			showStatusbar: true,
			titleText: '行情终端 · DeepSeek Harness',
			chipCount: 3,
			tapeSymbols: [
				'sh000001', 'sz399001', 'sz399006',
				'sz300059', 'sz300308', 'sh688256', 'sh603986', 'sh688836',
				'hkHSI', 'hk00700', 'hk09988',
				'usIXIC', 'usDJI', 'usNVDA', 'usAAPL', 'usTSLA',
				'BTCUSDT', 'ETHUSDT', 'USD/CNY',
			],
			indexSymbols: ['hkHSI', 'hkHSTECH', 'usDJI', 'usINX', 'usIXIC'],
			refreshSec: 30,
			statusGap: 20,
			redUp: true,
			showSessions: true,
			pinTitleAndFavicon: true,
		};

		/**
		 * 读取设置：DEFAULTS 深合并 + 字段级合法性与范围校验，
		 * 损坏/半旧的 localStorage 数据自动回落到默认值，绝不抛错。
		 */
		function loadSettings() {
			const out = JSON.parse(JSON.stringify(DEFAULTS));
			try {
				const raw = localStorage.getItem(LS_KEY);
				if (!raw) return out;
				const saved = JSON.parse(raw);
				if (typeof saved !== 'object' || saved === null) return out;
				for (const key of Object.keys(DEFAULTS)) {
					if (!(key in saved)) continue;
					const value = saved[key];
					if (typeof DEFAULTS[key] === 'boolean') {
						if (typeof value === 'boolean') out[key] = value;
					} else if (Array.isArray(DEFAULTS[key])) {
						if (Array.isArray(value)) {
							out[key] = value.filter((s) => typeof s === 'string' && s.trim() !== '').map((s) => s.trim());
						}
					} else if (typeof DEFAULTS[key] === 'number') {
						const num = Number(value);
						if (Number.isFinite(num)) out[key] = num;
					} else if (typeof DEFAULTS[key] === 'string') {
						if (typeof value === 'string' && value !== '') out[key] = value;
					}
				}
			} catch {
				// localStorage 不可用或内容损坏：静默用默认值
			}
			out.refreshSec = Math.min(600, Math.max(5, Math.round(out.refreshSec)));
			out.chipCount = Math.min(8, Math.max(0, Math.round(out.chipCount)));
			out.statusGap = Math.min(40, Math.max(0, Math.round(out.statusGap)));
			return out;
		}

		/** 写入 localStorage；失败（隐私模式等）只影响持久化，不影响本次会话效果。 */
		function saveSettings(settings) {
			try {
				localStorage.setItem(LS_KEY, JSON.stringify(settings));
			} catch {
				// ignore
			}
		}

		/* ════════════════════════ 数据层（自 hooks.mjs 原样移植） ════════════════════════ */

		/** 解析涨跌趋势：红涨绿跌只是配色语义，up/down 的判定恒为「正数涨」。 */
		function trendOf(q) {
			if (q.changeAbs > 0) return 'up';
			if (q.changeAbs < 0) return 'down';
			if (q.changePct > 0) return 'up';
			if (q.changePct < 0) return 'down';
			return 'flat';
		}

		/** AbortSignal for one request; fails safe where AbortSignal.timeout is absent. */
		function timeoutSignal(ms) {
			if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
				return AbortSignal.timeout(ms);
			}
			const controller = new AbortController();
			setTimeout(() => controller.abort(), ms);
			return controller.signal;
		}

		/** String -> finite number, or NaN. */
		function toNumber(value) {
			if (typeof value === 'number') return Number.isFinite(value) ? value : Number.NaN;
			if (typeof value === 'string') return Number.parseFloat(value);
			return Number.NaN;
		}

		/**
		 * Parse one v_<sym>="..." payload. Tencent splits fields on ~; the stable
		 * indices used here (verified on sh/sz/hk/us families):
		 *   1 name, 3 last, 4 prevClose, 30 time, 31 change, 32 changePct,
		 *   33 high, 34 low.
		 */
		function parseTencentRow(raw) {
			const f = raw.split('~');
			if (f.length < 35) return null;
			const price = toNumber(f[3]);
			if (!Number.isFinite(price)) return null;
			return {
				name: f[1] !== undefined && f[1] !== '' ? f[1] : f[2] ?? '',
				price,
				prevClose: toNumber(f[4]),
				change: toNumber(f[31]),
				changePct: toNumber(f[32]),
				high: toNumber(f[33]),
				low: toNumber(f[34]),
			};
		}

		/**
		 * Load a Tencent quote batch through a script tag (qt.gtimg.cn serves
		 * classic scripts — the response assigns v_<sym> globals). trackPending
		 * registers a cancel callback so teardown can retract a still-pending
		 * script node and never leak DOM.
		 */
		function loadTencentQuotes(symbols, timeoutMs = 8000, trackPending) {
			return new Promise((resolve) => {
				if (symbols.length === 0) { resolve(new Map()); return; }
				const globals = symbols.map((s) => `v_${s}`);
				let settled = false;
				const script = document.createElement('script');
				let untrack;
				const finish = (out) => {
					if (settled) return;
					settled = true;
					untrack?.();
					clearTimeout(timer);
					script.remove();
					for (const g of globals) {
						try { delete window[g]; } catch { /* noop */ }
					}
					resolve(out);
				};
				const timer = window.setTimeout(() => finish(new Map()), timeoutMs);
				untrack = trackPending?.(() => finish(new Map()));
				script.onload = () => {
					const out = new Map();
					for (const s of symbols) {
						const raw = window[`v_${s}`];
						if (typeof raw !== 'string') continue;
						const row = parseTencentRow(raw);
						if (row !== null) out.set(s, row);
					}
					finish(out);
				};
				script.onerror = () => finish(new Map());
				script.src = `https://qt.gtimg.cn/q=${symbols.join(',')}&_t=${Date.now()}`;
				document.head.append(script);
			});
		}

		/** Binance hosts in preference order; the public mirror has no geo gating. */
		const BINANCE_ENDPOINTS = [
			'https://api.binance.com/api/v3/ticker/24hr',
			'https://data-api.binance.vision/api/v3/ticker/24hr',
		];

		/** Display names for the well-known pairs. */
		const CRYPTO_NAMES = {
			BTCUSDT: '比特币', ETHUSDT: '以太坊', BNBUSDT: 'BNB', SOLUSDT: 'Solana',
			XRPUSDT: '瑞波币', DOGEUSDT: '狗狗币', ADAUSDT: 'Cardano', AVAXUSDT: 'Avalanche',
			LINKUSDT: 'Chainlink', LTCUSDT: '莱特币', DOTUSDT: 'Polkadot', TRXUSDT: '波场',
			SHIBUSDT: 'SHIB', TONUSDT: 'TON', BCHUSDT: 'BCH', UNIUSDT: 'Uniswap',
			ATOMUSDT: 'Cosmos', NEARUSDT: 'NEAR', APTUSDT: 'Aptos', ARBUSDT: 'Arbitrum',
			OPUSDT: 'Optimism', FILUSDT: 'Filecoin', SUIUSDT: 'SUI', PEPEUSDT: 'PEPE',
		};

		/**
		 * Fetch 24h tickers for a crypto batch. Races both hosts in parallel
		 * (国内直连 api.binance.com 常超时，串行等待会把整批行情首拉拖住 8s+);
		 * Promise.any 取最先成功者，全败时回空 map。
		 */
		async function fetchBinanceQuotes(symbols, timeoutMs = 8000) {
			if (symbols.length === 0) return new Map();

			/** 单 host 拉取并解析；HTTP 错误/空结果抛错供竞速淘汰。 */
			const tryHost = async (endpoint) => {
				const response = await fetch(
					`${endpoint}?symbols=${encodeURIComponent(JSON.stringify(symbols))}`,
					{ signal: timeoutSignal(timeoutMs) },
				);
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				const rows = await response.json();
				const out = new Map();
				for (const row of rows) {
					const symbol = String(row.symbol ?? '');
					const price = toNumber(row.lastPrice);
					if (symbol === '' || !Number.isFinite(price)) continue;
					out.set(symbol, {
						symbol,
						name: CRYPTO_NAMES[symbol] ?? symbol,
						price,
						changeAbs: toNumber(row.priceChange),
						changePct: toNumber(row.priceChangePercent),
						source: 'binance',
					});
				}
				if (out.size === 0) throw new Error('empty result');
				return out;
			};

			try {
				return await Promise.any(BINANCE_ENDPOINTS.map(tryHost));
			} catch {
				return new Map(); // 全 host 失败：本族降级为空
			}
		}

		/** Frankfurter hosts in preference order (.dev is the current home). */
		const FRANKFURTER_ENDPOINTS = [
			'https://api.frankfurter.dev/v1',
			'https://api.frankfurter.app/v1',
		];

		/** Chinese names for common currencies. */
		const FX_CURRENCY_NAMES = {
			CNY: '人民币', USD: '美元', EUR: '欧元', JPY: '日元', GBP: '英镑', HKD: '港元',
			AUD: '澳元', CAD: '加元', CHF: '瑞士法郎', KRW: '韩元', SGD: '新加坡元',
			TWD: '新台币', THB: '泰铢', RUB: '卢布', INR: '卢比', BRL: '雷亚尔',
			MXN: '比索', TRY: '里拉', ZAR: '兰特', SEK: '瑞典克朗', NOK: '挪威克朗',
			DKK: '丹麦克朗', NZD: '新西兰元', CZK: '捷克克朗', PLN: '兹罗提', HUF: '福林',
		};

		/** ISO date (YYYY-MM-DD) of days days before date, in UTC. */
		function isoDaysAgo(date, days) {
			return new Date(date.getTime() - days * 86_400_000).toISOString().slice(0, 10);
		}

		/**
		 * Fetch one FX base's rates for a target list from the first host that
		 * answers. Resolves { base, rates, prev } or null on total failure.
		 * prev 从前一个工作日回溯取值（最多回看 4 天跳过周末/假日）作为涨跌基准。
		 */
		async function frankfurterRates(base, targets) {
			const symbols = targets.join(',');
			const date = new Date();
			for (const endpoint of FRANKFURTER_ENDPOINTS) {
				try {
					const latestUrl = `${endpoint}/latest?base=${base}&symbols=${symbols}`;
					const latestResponse = await fetch(latestUrl, { signal: timeoutSignal(8000) });
					if (!latestResponse.ok) continue;
					const latest = await latestResponse.json();
					if (latest.rates === undefined) continue;
					const rates = new Map();
					for (const [code, value] of Object.entries(latest.rates)) {
						const n = toNumber(value);
						if (Number.isFinite(n)) rates.set(code, n);
					}
					let prev = new Map();
					for (let back = 1; back <= 4 && prev.size === 0; back += 1) {
						const prevUrl = `${endpoint}/${isoDaysAgo(date, back)}?base=${base}&symbols=${symbols}`;
						try {
							const prevResponse = await fetch(prevUrl, { signal: timeoutSignal(6000) });
							if (!prevResponse.ok) continue;
							const prevJson = await prevResponse.json();
							prev = new Map();
							for (const [code, value] of Object.entries(prevJson.rates ?? {})) {
								const n = toNumber(value);
								if (Number.isFinite(n)) prev.set(code, n);
							}
						} catch {
							// keep walking back
						}
					}
					return { base, rates, prev };
				} catch {
					// next host
				}
			}
			return null;
		}

		/**
		 * Fetch FX pair quotes (USD/CNY grammar). Pairs are grouped by base;
		 * each group is one request plus one previous-day request for the change.
		 */
		async function fetchFrankfurterQuotes(pairs, timeoutMs = 8000) {
			void timeoutMs;
			const out = new Map();
			if (pairs.length === 0) return out;
			const byBase = new Map();
			for (const pair of pairs) {
				const [base, target] = pair.split('/');
				if (base === undefined || target === undefined || base === target) continue;
				const list = byBase.get(base) ?? [];
				list.push(target);
				byBase.set(base, list);
			}
			const results = await Promise.all(
				[...byBase.entries()].map(([base, targets]) => frankfurterRates(base, targets)),
			);
			for (const result of results) {
				if (result === null) continue;
				for (const [target, rate] of result.rates) {
					const symbol = `${result.base}/${target}`;
					const prevRate = result.prev.get(target);
					const hasPrev = Number.isFinite(prevRate) && prevRate !== 0;
					const changeAbs = hasPrev ? rate - prevRate : 0;
					const changePct = hasPrev ? ((rate - prevRate) / prevRate) * 100 : 0;
					out.set(symbol, {
						symbol,
						name: `${FX_CURRENCY_NAMES[result.base] ?? result.base}/${FX_CURRENCY_NAMES[target] ?? target}`,
						price: rate,
						changeAbs,
						changePct,
						source: 'frankfurter',
					});
				}
			}
			return out;
		}

		/** The fun-ticker plugin's same-origin API base (404s when not installed). */
		const TICKER_API_BASE = '/plugins/dsh-ticker/api';

		/** Read the user's fun-ticker watchlist; null when the plugin is absent. */
		async function fetchTickerSettings(timeoutMs = 5000) {
			if (typeof fetch === 'undefined') return null;
			try {
				const response = await fetch(`${TICKER_API_BASE}/settings`, { signal: timeoutSignal(timeoutMs) });
				if (!response.ok) return null;
				const data = await response.json();
				if (data.ok !== true) return null;
				const symbols = data.section?.symbols;
				if (!Array.isArray(symbols)) return null;
				const list = symbols.filter((s) => typeof s === 'string' && s.length > 0);
				return list.length > 0 ? list : null;
			} catch {
				return null;
			}
		}

		/** Poll the fun-ticker quote proxy for the given watchlist; null on failure. */
		async function fetchTickerQuotes(symbols, timeoutMs = 8000) {
			if (typeof fetch === 'undefined' || symbols.length === 0) return null;
			try {
				const response = await fetch(
					`${TICKER_API_BASE}/quotes?symbols=${encodeURIComponent(symbols.join(','))}`,
					{ signal: timeoutSignal(timeoutMs) },
				);
				if (!response.ok) return null;
				const data = await response.json();
				if (data.ok !== true || data.quotes === undefined) return null;
				const quotes = [];
				for (const row of Object.values(data.quotes)) {
					const symbol = String(row.symbol ?? '');
					const price = toNumber(row.price);
					if (symbol === '' || !Number.isFinite(price)) continue;
					quotes.push({
						symbol,
						name: typeof row.name === 'string' && row.name !== '' ? row.name : symbol,
						price,
						changePct: toNumber(row.changePct),
						changeAbs: toNumber(row.changeAbs),
						source: 'ticker',
					});
				}
				return quotes.length > 0 ? quotes : null;
			} catch {
				return null;
			}
		}

		/** Classify one standalone symbol into its upstream family. */
		function classifyDirectSymbol(symbol) {
			const value = symbol.trim();
			if (/^(?:sh|sz|hk|us)[A-Za-z0-9.]+$/.test(value)) return 'tencent';
			// Crypto pairs must contain a letter — a bare 6-digit code is A-share
			// grammar, never a crypto pair.
			if (/^(?=.*[A-Z])[A-Z0-9]{4,12}$/.test(value)) return 'crypto';
			if (/^[A-Z]{3}\/[A-Z]{3}$/.test(value)) return 'fx';
			return null;
		}

		/**
		 * Fetch a quote batch from the public feeds directly. Every family
		 * failure degrades to an empty slice; the merged result may be shorter
		 * than requested.
		 */
		async function fetchDirectQuotes(symbols, timeoutMs = 8000, trackPending) {
			const tencentSymbols = [];
			const cryptoSymbols = [];
			const fxSymbols = [];
			for (const symbol of symbols) {
				const category = classifyDirectSymbol(symbol);
				if (category === 'tencent') tencentSymbols.push(symbol);
				else if (category === 'crypto') cryptoSymbols.push(symbol);
				else if (category === 'fx') fxSymbols.push(symbol);
			}
			const [tencent, crypto, fx] = await Promise.all([
				loadTencentQuotes(tencentSymbols, timeoutMs, trackPending),
				fetchBinanceQuotes(cryptoSymbols, timeoutMs),
				fetchFrankfurterQuotes(fxSymbols, timeoutMs),
			]);
			const quotes = [];
			for (const [symbol, row] of tencent) {
				quotes.push({
					symbol,
					name: row.name !== '' ? row.name : symbol,
					price: row.price,
					changeAbs: row.change,
					changePct: row.changePct,
					source: 'tencent',
				});
			}
			for (const quote of crypto.values()) quotes.push(quote);
			for (const quote of fx.values()) quotes.push(quote);
			return quotes;
		}

		/* ── 市场时段（A股/港股/美股开盘状态） ─────────────────────────── */

		/** Weekday in the target timezone ('Mon'..'Sun'). */
		function tzWeekday(timeZone, date) {
			return new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(date);
		}

		/** Minutes since midnight in the target timezone. */
		function tzMinutes(timeZone, date) {
			const parts = new Intl.DateTimeFormat('en-US', {
				timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
			}).formatToParts(date);
			const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
			const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
			return hour * 60 + minute;
		}

		/** Is now a weekday in timeZone? */
		function isWeekday(timeZone, now) {
			const day = tzWeekday(timeZone, now);
			return day !== 'Sat' && day !== 'Sun';
		}

		/** Phase for one continuous-session market. */
		function continuousPhase(minutes, open, close, preOpen) {
			if (minutes >= open && minutes < close) return 'trading';
			if (preOpen !== undefined && minutes >= preOpen && minutes < open) return 'pre';
			return 'closed';
		}

		/** Phase for a split-session market (A-share, HK). */
		function splitPhase(minutes, open, lunch, resume, close) {
			if (minutes >= open && minutes < lunch) return 'trading';
			if (minutes >= lunch && minutes < resume) return 'lunch';
			if (minutes >= resume && minutes < close) return 'trading';
			return 'closed';
		}

		/** Session phases for the three markets at now. */
		function marketSessions(now = new Date()) {
			const aShareOpen = isWeekday('Asia/Shanghai', now);
			const hkOpen = isWeekday('Asia/Hong_Kong', now);
			const usOpen = isWeekday('America/New_York', now);
			return {
				aShare: aShareOpen
					? splitPhase(tzMinutes('Asia/Shanghai', now), 9 * 60 + 30, 11 * 60 + 30, 13 * 60, 15 * 60)
					: 'closed',
				hk: hkOpen
					? splitPhase(tzMinutes('Asia/Hong_Kong', now), 9 * 60 + 30, 12 * 60, 13 * 60, 16 * 60)
					: 'closed',
				us: usOpen
					? continuousPhase(tzMinutes('America/New_York', now), 9 * 60 + 30, 16 * 60, 4 * 60)
					: 'closed',
			};
		}

		/** Chinese label for one phase. */
		function phaseLabel(phase) {
			switch (phase) {
				case 'trading': return '盘中';
				case 'lunch': return '午休';
				case 'pre': return '盘前';
				default: return '休市';
			}
		}

		/**
		 * Create a scheduler that drives all jobs from one tickMs interval,
		 * gating each job by its own periodMs. stop clears the interval so no
		 * work leaks; restart 用于修改刷新频率后按新周期重建。
		 */
		function createRefreshScheduler(jobs, tickMs) {
			const lastRun = new Map();
			let timer = null;

			const tick = () => {
				const now = Date.now();
				for (const job of jobs) {
					const last = lastRun.get(job) ?? now;
					if (now - last >= job.periodMs) {
						lastRun.set(job, now);
						job.run();
					}
				}
			};

			return {
				start: () => {
					if (timer !== null) return;
					const now = Date.now();
					for (const job of jobs) lastRun.set(job, now);
					timer = setInterval(tick, tickMs);
				},
				stop: () => {
					if (timer !== null) {
						clearInterval(timer);
						timer = null;
					}
				},
			};
		}

		/* ── 文案与格式化 ───────────────────────────────────────────── */

		/** Candlestick brand mark, inline so the plugin carries no static assets. */
		const CANDLE_SVG = [
			'<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 48 48">',
			'<rect x="6" y="14" width="8" height="20" fill="#fff"/>',
			'<rect x="9" y="6" width="2" height="36" fill="#fff"/>',
			'<rect x="17" y="20" width="8" height="18" fill="#fff"/>',
			'<rect x="20" y="12" width="2" height="34" fill="#fff"/>',
			'<rect x="28" y="10" width="8" height="16" fill="#fff"/>',
			'<rect x="31" y="4" width="2" height="28" fill="#fff"/>',
			'</svg>',
		].join('');

		/** Gear icon for the settings buttons. */
		const GEAR_SVG = [
			'<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none"',
			' stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">',
			'<circle cx="12" cy="12" r="3"/>',
			'<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33',
			' 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0',
			' 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0',
			' 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0',
			' 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83',
			' 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51',
			' 1z"/></svg>',
		].join('');

		/** Brand-red rounded-square favicon carrying the candle mark. */
		const FAVICON_SVG = [
			'<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">',
			'<rect x="2" y="2" width="60" height="60" rx="14" fill="#f23645"/>',
			'<rect x="14" y="24" width="8" height="16" rx="1" fill="#fff"/>',
			'<rect x="17" y="18" width="2" height="28" rx="1" fill="#fff"/>',
			'<rect x="28" y="30" width="8" height="14" rx="1" fill="#fff"/>',
			'<rect x="31" y="24" width="2" height="26" rx="1" fill="#fff"/>',
			'<rect x="42" y="22" width="8" height="12" rx="1" fill="#fff"/>',
			'<rect x="45" y="16" width="2" height="24" rx="1" fill="#fff"/>',
			'</svg>',
		].join('');

		/** Title bar decorative window glyphs (aria-hidden). */
		const TITLEBAR_GLYPHS = ['–', '□', '×'];

		/** Placeholder quote for the pre-data chrome. */
		function placeholderQuote(symbol) {
			return { symbol, name: symbol, price: Number.NaN, changePct: Number.NaN, changeAbs: Number.NaN, source: 'none' };
		}

		/** 0.42 -> "+0.42%"、-0.42 -> "-0.42%"（箭头由调用方拼接）；flat renders an em dash. */
		function pctText(trend, pct) {
			if (trend === 'flat') return '—';
			const abs = Math.abs(pct).toFixed(2);
			return `${trend === 'up' ? '+' : '-'}${abs}%`;
		}

		/** 3926.96 -> 3,926.96; NaN renders '--'. */
		function priceText(price) {
			return Number.isFinite(price)
				? price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
				: '--';
		}

		/* ════════════════════════ CSS ════════════════════════ */

		/**
		 * 全部样式。配色通过两层变量解耦：
		 *   --mt-red / --mt-green：随主题切换的实际色值；
		 *   --mt-up  / --mt-down ：语义映射，由根元素 data-redup 决定指向谁，
		 *   这样「红涨绿跌 ↔ 绿涨红跌」切换无需触碰主题色定义。
		 */
		const MT_CSS = `
#mt-root{position:relative;z-index:999998;--mt-font:"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Segoe UI",sans-serif;--mt-mono:"SFMono-Regular",Menlo,Consolas,"Liberation Mono",monospace;--mt-red:#e02e3d;--mt-green:#089981;--mt-warn:#c08a35;--mt-up:var(--mt-red);--mt-down:var(--mt-green);--mt-flat:#8b96a5;--mt-text:#1b2431;--mt-dim:#6b7788;--mt-border:#d4dce5;--mt-brand:#e02e3d;--mt-titlebar-bg:linear-gradient(180deg,#fff,#f2f5f8);--mt-tape-bg:#fff;--mt-statusbar-bg:#f2f5f8;--mt-panel-bg:#fff;--mt-input-bg:#fff;--mt-card-bg:rgba(127,142,160,.09);--mt-ring:rgba(226,46,61,.16);font-family:var(--mt-font)}
#mt-root[data-redup="false"]{--mt-up:var(--mt-green);--mt-down:var(--mt-red)}
body[data-ds-dark-theme] #mt-root{--mt-red:#f23645;--mt-green:#089981;--mt-warn:#d69a3a;--mt-flat:#5f6b7a;--mt-text:#dbe2ec;--mt-dim:#7c8897;--mt-border:#222b39;--mt-brand:#f23645;--mt-titlebar-bg:linear-gradient(180deg,#161d27,#10151d);--mt-tape-bg:#0e131b;--mt-statusbar-bg:#0e131b;--mt-panel-bg:#161d27;--mt-input-bg:#10151d;--mt-card-bg:rgba(255,255,255,.045);--mt-ring:rgba(242,54,69,.2)}
.mt-titlebar{z-index:1000000;background:var(--mt-titlebar-bg);border-bottom:1px solid var(--mt-border);height:34px;color:var(--mt-text);font:600 13px/34px var(--mt-font);user-select:none;align-items:center;gap:8px;padding:0 8px;display:flex;position:fixed;top:0;left:0;right:0}
.mt-titlebar-icon{background:var(--mt-brand);border-radius:5px;justify-content:center;align-items:center;width:20px;height:20px;display:inline-flex;box-shadow:inset 0 1px #ffffff40;flex-shrink:0}
.mt-titlebar-icon svg{width:14px;height:14px;display:block}
.mt-titlebar-title{color:var(--mt-text);letter-spacing:.02em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mt-titlebar-chips{align-items:center;gap:14px;margin-left:auto;display:inline-flex;overflow:hidden}
.mt-chip{font:500 12px/1 var(--mt-mono);font-variant-numeric:tabular-nums;white-space:nowrap;align-items:baseline;gap:5px;display:inline-flex}
.mt-chip-name{color:var(--mt-dim)}
.mt-chip-val{color:var(--mt-text);font-weight:600}
.mt-chg[data-trend="up"]{color:var(--mt-up)}
.mt-chg[data-trend="down"]{color:var(--mt-down)}
.mt-chg:not([data-trend]){color:var(--mt-flat)}
.mt-glyph{text-align:center;width:26px;color:var(--mt-dim);border-radius:4px;display:inline-block}
.mt-btn{border:none;background:transparent;color:var(--mt-dim);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;border-radius:4px;padding:0}
.mt-btn:hover{background:rgba(127,142,160,.18);color:var(--mt-text)}
.mt-tape{z-index:999999;background:var(--mt-tape-bg);border-bottom:1px solid var(--mt-border);user-select:none;height:30px;position:fixed;top:34px;left:0;right:0;overflow:hidden}
.mt-tape-track{white-space:nowrap;will-change:transform;align-items:center;height:100%;animation:mtTapeMove 60s linear infinite;display:inline-flex}
.mt-tape:hover .mt-tape-track{animation-play-state:paused}
@keyframes mtTapeMove{from{transform:translateX(0)}to{transform:translateX(-50%)}}
@media (prefers-reduced-motion:reduce){.mt-tape-track{animation:none}}
.mt-item{border-right:1px solid rgba(127,142,160,.25);height:100%;font:500 12px/30px var(--mt-mono);font-variant-numeric:tabular-nums;align-items:baseline;gap:6px;padding:0 16px;display:inline-flex}
.mt-item-name{color:var(--mt-dim);white-space:nowrap}
.mt-item-price{color:var(--mt-text);font-weight:600}
.mt-statusbar{z-index:1000000;background:var(--mt-statusbar-bg);border-top:1px solid var(--mt-border);height:26px;color:var(--mt-dim);font:500 12px/26px var(--mt-mono);font-variant-numeric:tabular-nums;user-select:none;white-space:nowrap;align-items:center;gap:14px;padding:0 10px;display:flex;position:fixed;bottom:0;left:0;right:0}
.mt-statusbar-group{align-items:center;gap:var(--mt-status-gap,12px);display:inline-flex}
.mt-statusbar-spacer{flex:1}
.mt-cell{color:var(--mt-dim);align-items:baseline;gap:4px;display:inline-flex}
.mt-cell[data-phase="trading"]{color:var(--mt-up)}
.mt-cell[data-phase="lunch"],.mt-cell[data-phase="pre"]{color:var(--mt-warn)}
.mt-cell[data-trend="up"]{color:var(--mt-up)}
.mt-cell[data-trend="down"]{color:var(--mt-down)}
.mt-statusbar-label{color:var(--mt-brand);font-weight:600}
.mt-hidden{display:none !important}
.mt-gear{opacity:0;transition:opacity .15s ease}
.mt-titlebar .mt-gear,.mt-gear.always,.mt-tape:hover .mt-gear,.mt-statusbar:hover .mt-gear,.mt-gear:focus-visible{opacity:1}
.mt-gear.always{opacity:1}
.mt-mask{position:fixed;inset:0;z-index:1100000;background:rgba(10,14,21,.42);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;animation:mtFade .18s ease-out}
@keyframes mtFade{from{opacity:0}to{opacity:1}}
.mt-panel{width:560px;max-width:calc(100vw - 40px);max-height:min(86vh,760px);display:flex;flex-direction:column;box-sizing:border-box;background:var(--mt-panel-bg);color:var(--mt-text);border:1px solid var(--mt-border);border-radius:16px;box-shadow:0 32px 80px rgba(0,0,0,.30),0 6px 20px rgba(0,0,0,.14);overflow:hidden;animation:mtPop .24s cubic-bezier(.2,.8,.3,1)}
@keyframes mtPop{from{opacity:0;transform:translateY(14px) scale(.97)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.mt-mask,.mt-panel{animation:none}}
.mt-head{display:flex;align-items:center;gap:11px;padding:15px 18px 13px;border-bottom:1px solid var(--mt-border);background:var(--mt-titlebar-bg);flex-shrink:0}
.mt-head-icon{width:32px;height:32px;border-radius:9px;background:var(--mt-brand);display:flex;align-items:center;justify-content:center;box-shadow:inset 0 1px #ffffff40;flex-shrink:0}
.mt-head-icon svg{width:17px;height:17px;display:block}
.mt-head-titles{flex:1;min-width:0}
.mt-head-title{font-size:14px;font-weight:700;letter-spacing:.02em;line-height:1.3}
.mt-head-sub{font-size:11px;color:var(--mt-dim);line-height:1.4;margin-top:2px}
.mt-head-close{width:26px;height:26px;border:none;border-radius:8px;background:transparent;color:var(--mt-dim);cursor:pointer;font-size:13px;line-height:1;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.mt-head-close:hover{background:var(--mt-card-bg);color:var(--mt-text)}
.mt-body{overflow-y:auto;padding:14px 18px;display:flex;flex-direction:column;gap:12px;scrollbar-width:thin}
.mt-body::-webkit-scrollbar{width:8px}
.mt-body::-webkit-scrollbar-thumb{background:var(--mt-border);border-radius:4px}
.mt-card{background:var(--mt-card-bg);border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:10px}
.mt-card-title{display:flex;align-items:center;gap:7px;font-size:12px;font-weight:700;letter-spacing:.02em}
.mt-card-title .mt-dot{width:6px;height:6px;border-radius:50%;background:var(--mt-brand);flex-shrink:0}
.mt-toggles{display:grid;grid-template-columns:1fr 1fr;gap:9px 16px}
.mt-toggle-row{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:12.5px;color:var(--mt-text);cursor:pointer;user-select:none;min-height:20px}
.mt-toggle-row input{position:absolute;opacity:0;width:0;height:0;pointer-events:none}
.mt-slider{position:relative;flex-shrink:0;width:34px;height:19px;border-radius:999px;background:rgba(127,142,160,.4);transition:background .18s ease}
.mt-slider::after{content:"";position:absolute;top:2.5px;left:3px;width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.25);transition:transform .18s ease}
.mt-toggle-row input:checked + .mt-slider{background:var(--mt-brand)}
.mt-toggle-row input:checked + .mt-slider::after{transform:translateX(15px)}
.mt-toggle-row input:focus-visible + .mt-slider{box-shadow:0 0 0 3px var(--mt-ring)}
.mt-row{display:flex;flex-wrap:wrap;gap:12px;row-gap:8px}
.mt-label{display:flex;flex-direction:column;gap:4px;font-size:11.5px;font-weight:600;color:var(--mt-dim)}
.mt-input,.mt-textarea{box-sizing:border-box;border:1px solid var(--mt-border);background:var(--mt-input-bg);color:var(--mt-text);border-radius:9px;font:500 12.5px/1.5 var(--mt-mono);padding:7px 10px;outline:none;width:100%;transition:border-color .15s ease,box-shadow .15s ease}
.mt-input:focus,.mt-textarea:focus{border-color:var(--mt-brand);box-shadow:0 0 0 3px var(--mt-ring)}
.mt-textarea{min-height:92px;resize:vertical;line-height:1.6}
.mt-num{width:110px !important}
.mt-list-head{display:flex;align-items:center;gap:8px}
.mt-pill{font-size:10.5px;font-weight:600;color:var(--mt-dim);background:var(--mt-input-bg);border:1px solid var(--mt-border);border-radius:999px;padding:1px 9px;line-height:1.7;white-space:nowrap}
.mt-pill b{color:var(--mt-brand);font-weight:700}
.mt-hint{font-size:11px;line-height:1.7;color:var(--mt-dim);background:var(--mt-card-bg);border-left:3px solid var(--mt-brand);border-radius:8px;padding:9px 12px}
.mt-hint code{font-family:var(--mt-mono);background:var(--mt-input-bg);border-radius:4px;padding:0 4px}
.mt-actions{display:flex;gap:10px;justify-content:flex-end;align-items:center;border-top:1px solid var(--mt-border);padding:12px 18px;background:var(--mt-titlebar-bg);flex-shrink:0}
.mt-spacer{flex:1}
.mt-action{border:1px solid var(--mt-border);background:transparent;color:var(--mt-text);border-radius:9px;font:600 12.5px/1 var(--mt-font);padding:10px 16px;cursor:pointer;transition:background .15s ease,transform .1s ease,filter .15s ease}
.mt-action:hover{background:var(--mt-card-bg)}
.mt-action:active{transform:scale(.97)}
.mt-action.primary{background:var(--mt-brand);border-color:var(--mt-brand);color:#fff;box-shadow:0 2px 8px var(--mt-ring)}
.mt-action.primary:hover{filter:brightness(1.07)}
`;

		/** 向 head 注入样式表（幂等，带标记防重复）。 */
		function injectCssOnce() {
			const id = 'dsh-market-ticker-style';
			if (document.getElementById(id)) return;
			const style = document.createElement('style');
			style.id = id;
			style.textContent = MT_CSS;
			document.head.append(style);
		}

		/* ════════════════════════ 行情快照缓存（stale-while-revalidate） ════════════════════════ */

		/** 行情快照 localStorage 键；首帧先回放上次数据再后台刷新，双击启动不再看 `--`。 */
		const QUOTES_CACHE_KEY = 'dsh-market-ticker/quotes-cache/v1';

		/** 快照有效期：超龄不回放，避免长假后展示误导性旧价。 */
		const QUOTES_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

		/** 读取行情快照；缺失/损坏/超龄一律回 null。 */
		function loadQuotesCache() {
			try {
				const raw = localStorage.getItem(QUOTES_CACHE_KEY);
				if (!raw) return null;
				const data = JSON.parse(raw);
				if (typeof data !== 'object' || data === null || typeof data.ts !== 'number') return null;
				if (Date.now() - data.ts > QUOTES_CACHE_TTL_MS) return null;
				if (!Array.isArray(data.tape) || !Array.isArray(data.index)) return null;
				return data;
			} catch {
				return null;
			}
		}

		/** 合并写入行情快照（tape/index 分批到达，各自更新自己的字段）。 */
		function saveQuotesCache(patch) {
			try {
				const next = { ...loadQuotesCache(), ...patch, ts: Date.now() };
				localStorage.setItem(QUOTES_CACHE_KEY, JSON.stringify(next));
			} catch {
				// localStorage 不可用时静默降级为无缓存
			}
		}

		/* ════════════════════════ 应用入口 ════════════════════════ */

		function apply(_ctx) {
			try {
				injectCssOnce();

				// 幂等守卫：重复 apply 时先拆掉旧 root（HMR / 双注册场景防双条）。
				document.getElementById('mt-root')?.remove();

				let settings = loadSettings();
				const body = document.body;
				const originalTitle = document.title;

				/** 待取消的在途腾讯 script 加载（teardown 时回收，防止泄漏）。 */
				const pendingLoads = new Set();
				const trackPending = (cancel) => {
					pendingLoads.add(cancel);
					return () => pendingLoads.delete(cancel);
				};

				// ── DOM 骨架 ───────────────────────────────────────────────

				const root = document.createElement('div');
				root.id = 'mt-root';

				// 标题栏
				const titlebar = document.createElement('div');
				titlebar.className = 'mt-titlebar';
				const brand = document.createElement('span');
				brand.className = 'mt-titlebar-icon';
				brand.innerHTML = CANDLE_SVG;
				const title = document.createElement('span');
				title.className = 'mt-titlebar-title';
				const chips = document.createElement('span');
				chips.className = 'mt-titlebar-chips';
				titlebar.append(brand, title, chips);
				for (const glyph of TITLEBAR_GLYPHS) {
					const btn = document.createElement('span');
					btn.className = 'mt-glyph';
					btn.setAttribute('aria-hidden', 'true');
					btn.textContent = glyph;
					titlebar.append(btn);
				}
				const gearTitlebar = makeGearButton(true);
				gearTitlebar.style.marginLeft = '6px';
				titlebar.append(gearTitlebar);

				// 跑马灯
				const tape = document.createElement('div');
				tape.className = 'mt-tape';
				const track = document.createElement('div');
				track.className = 'mt-tape-track';
				tape.append(track);
				const gearTape = makeGearButton(false);
				gearTape.style.position = 'absolute';
				gearTape.style.right = '8px';
				gearTape.style.top = '50%';
				gearTape.style.transform = 'translateY(-50%)';
				gearTape.style.background = 'var(--mt-panel-bg)';
				gearTape.style.boxShadow = '0 0 0 1px var(--mt-border)';
				gearTape.style.width = '22px';
				gearTape.style.height = '22px';
				tape.append(gearTape);

				// 底部状态栏
				const statusbar = document.createElement('div');
				statusbar.className = 'mt-statusbar';
				const leftGroup = document.createElement('span');
				leftGroup.className = 'mt-statusbar-group';
				const sessionCells = new Map();
				const sessionLabels = [['aShare', 'A股'], ['hk', '港股'], ['us', '美股']];
				for (const [key, label] of sessionLabels) {
					const cell = document.createElement('span');
					cell.className = 'mt-cell';
					cell.textContent = `${label} 休市`;
					sessionCells.set(key, cell);
					leftGroup.append(cell);
				}
				const spacer = document.createElement('span');
				spacer.className = 'mt-statusbar-spacer';
				const indexGroup = document.createElement('span');
				indexGroup.className = 'mt-statusbar-group';
				const indexLabel = document.createElement('span');
				indexLabel.className = 'mt-statusbar-label';
				indexLabel.textContent = '指数';
				const indexCells = [];
				for (let i = 0; i < DEFAULTS.indexSymbols.length; i += 1) {
					const cell = document.createElement('span');
					cell.className = 'mt-cell';
					cell.textContent = '-- --';
					indexCells.push(cell);
					indexGroup.append(cell);
				}
				indexGroup.prepend(indexLabel);
				statusbar.append(leftGroup, spacer, indexGroup);
				const gearStatusbar = makeGearButton(false);
				statusbar.append(gearStatusbar);

				root.append(titlebar, tape, statusbar);

				/** 创建打开设置面板的齿轮按钮。 */
				function makeGearButton(alwaysVisible) {
					const btn = document.createElement('button');
					btn.type = 'button';
					btn.className = alwaysVisible ? 'mt-btn mt-gear always' : 'mt-btn mt-gear';
					btn.title = '行情条设置';
					btn.setAttribute('aria-label', '行情条设置');
					btn.innerHTML = GEAR_SVG;
					return btn;
				}

				body.append(root);

				// ── 渲染函数 ───────────────────────────────────────────────

				/** 渲染单个行情单元（chip 或 tape item）：名称 + 价格 + ▲/▼涨跌幅。 */
				function renderQuoteCell(container, quote, nameClass, priceClass) {
					container.textContent = '';
					const trend = trendOf(quote);
					const name = document.createElement('span');
					name.className = nameClass;
					name.textContent = quote.name;
					const price = document.createElement('span');
					price.className = priceClass;
					price.textContent = priceText(quote.price);
					const chg = document.createElement('span');
					chg.className = 'mt-chg';
					chg.textContent = `${trend === 'up' ? '▲' : trend === 'down' ? '▼' : ''}${pctText(trend, quote.changePct)}`;
					if (trend === 'flat') delete chg.dataset.trend;
					else chg.dataset.trend = trend;
					container.append(name, price, chg);
				}

				/** 重建跑马灯轨道：两份相同拷贝接尾循环，速度随内容长度缩放。 */
				function renderTape(quotes) {
					const items = quotes.length > 0 ? quotes : settings.tapeSymbols.map(placeholderQuote);
					track.textContent = '';
					for (let copy = 0; copy < 2; copy += 1) {
						for (const quote of items) {
							const item = document.createElement('span');
							item.className = 'mt-item';
							renderQuoteCell(item, quote, 'mt-item-name', 'mt-item-price');
							track.append(item);
						}
					}
					track.style.animationDuration = `${Math.max(30, items.length * 4)}s`;
				}

				/** 标题栏 chips：跑马灯前 N 个，紧凑展示。 */
				function renderChips(quotes) {
					chips.textContent = '';
					const shown = quotes.length > 0 ? quotes.slice(0, settings.chipCount) : settings.tapeSymbols.slice(0, Math.max(settings.chipCount, 1)).map(placeholderQuote);
					for (let i = 0; i < Math.min(shown.length, settings.chipCount); i += 1) {
						const chip = document.createElement('span');
						chip.className = 'mt-chip';
						renderQuoteCell(chip, shown[i], 'mt-chip-name', 'mt-chip-val');
						chips.append(chip);
					}
				}

				/** 状态栏指数格：数量跟随设置动态增减。 */
				function syncIndexCells() {
					while (indexCells.length < settings.indexSymbols.length) {
						const cell = document.createElement('span');
						cell.className = 'mt-cell';
						cell.textContent = '-- --';
						indexCells.push(cell);
						indexGroup.append(cell);
					}
					while (indexCells.length > settings.indexSymbols.length) {
						indexCells.pop().remove();
					}
				}

				/** 渲染指数格行情。 */
				function renderIndexCells(quotes) {
					for (let i = 0; i < indexCells.length; i += 1) {
						const cell = indexCells[i];
						const quote = quotes[i];
						cell.textContent = '';
						if (quote === undefined) {
							cell.textContent = '-- --';
							delete cell.dataset.trend;
							continue;
						}
						cell.textContent = `${quote.name} ${priceText(quote.price)}`;
						const trend = trendOf(quote);
						const chg = document.createElement('span');
						chg.textContent = `${trend === 'up' ? '▲' : trend === 'down' ? '▼' : ''}${pctText(trend, quote.changePct)}`;
						cell.append(' ', chg);
						if (trend === 'flat') delete cell.dataset.trend;
						else cell.dataset.trend = trend;
					}
				}

				/** 渲染三市场时段格（可整体隐藏）。 */
				function renderSessions(now) {
					if (!settings.showSessions) {
						leftGroup.classList.add('mt-hidden');
						return;
					}
					leftGroup.classList.remove('mt-hidden');
					const phases = marketSessions(now);
					for (const [key, cell] of sessionCells) {
						const phase = phases[key];
						cell.textContent = `${sessionLabels.find(([k]) => k === key)?.[1] ?? key} ${phaseLabel(phase)}`;
						cell.dataset.phase = phase;
					}
				}

				// ── 设置生效（区域显隐 / padding 补偿 / 标题钉住 / 变量方向） ──

				/** 主题色语义切换与显隐类名只跟 data 属性/class 相关，这里统一收敛。 */
				function applyChrome() {
					root.dataset.redup = settings.redUp ? 'true' : 'false';
					// 状态栏组内间距（时段格/指数格之间）由设置驱动，CSS 走变量
					root.style.setProperty('--mt-status-gap', `${settings.statusGap}px`);
					title.classList.toggle('mt-hidden', false);
					title.textContent = settings.titleText;
					titlebar.classList.toggle('mt-hidden', !settings.showTitlebar);
					tape.classList.toggle('mt-hidden', !settings.showTape);
					statusbar.classList.toggle('mt-hidden', !settings.showStatusbar);
					indexLabel.classList.toggle('mt-hidden', false);
					if (!settings.showSessions) leftGroup.classList.add('mt-hidden');

					// 页面让位补偿（v0.1.2）：padding 直接落到产品根容器 [id="root"] 上
					// 并配 box-sizing:border-box——与 trading 皮肤给 :root 加 padding 的
					// 机制同源，padding 计入容器高度，不产生文档流溢出。旧版写在 body
					// 上的 padding 是 content-box 额外叠加，会把 html 撑出滚动条。
					// 顶部 = 标题栏 34+1 + 跑马灯 30+1；底部 = 状态栏 26+1。
					const appRoot = document.getElementById('root');
					const padTop = (settings.showTitlebar ? 35 : 0) + (settings.showTape ? 31 : 0);
					if (appRoot) {
						if (padTop > 0 || settings.showStatusbar) {
							appRoot.style.boxSizing = 'border-box';
							appRoot.style.paddingTop = padTop > 0 ? `${padTop}px` : '';
							appRoot.style.paddingBottom = settings.showStatusbar ? '27px' : '';
						} else {
							// 三件全关：连 border-box 一起还原，做到零残留。
							appRoot.style.boxSizing = '';
							appRoot.style.paddingTop = '';
							appRoot.style.paddingBottom = '';
						}
					}
					// 清掉 v0.1.1 及之前写在 body 上的旧补偿（升级残留会让外层滚动）。
					body.style.paddingTop = '';
					body.style.paddingBottom = '';

					// 标签页标题/图标钉住：仅在三件里的标题栏开启时生效。
					if (settings.pinTitleAndFavicon && settings.showTitlebar) {
						document.title = settings.titleText;
						favicon.disabled = false;
					} else {
						if (document.title === lastPinnedTitle) document.title = originalTitle;
						favicon.disabled = true;
					}
					lastPinnedTitle = settings.pinTitleAndFavicon && settings.showTitlebar ? settings.titleText : null;
				}

				let lastPinnedTitle = null;
				const favicon = document.createElement('link');
				favicon.rel = 'icon';
				favicon.href = `data:image/svg+xml;utf8,${encodeURIComponent(FAVICON_SVG)}`;
				document.head.append(favicon);

				// ── 数据轮询 ───────────────────────────────────────────────

				let disposed = false;

				/** 一轮行情刷新：fun-ticker 自选优先，其次本插件自选直连公共源。 */
				const refreshQuotes = async () => {
					if (disposed) return;
					let quotes = [];
					const tickerSymbols = await fetchTickerSettings();
					if (tickerSymbols !== null) {
						const tickerQuotes = await fetchTickerQuotes(tickerSymbols);
						if (tickerQuotes !== null) quotes = tickerQuotes;
					}
					if (quotes.length === 0) quotes = await fetchDirectQuotes(settings.tapeSymbols, 8000, trackPending);
					if (disposed) return;
					renderTape(quotes);
					renderChips(quotes);
					if (quotes.length > 0) saveQuotesCache({ tape: quotes });
				};

				/** 一轮指数刷新：状态栏指数直连公共源。 */
				const refreshIndices = async () => {
					if (disposed) return;
					await Promise.resolve();
					const fallback = await fetchDirectQuotes(settings.indexSymbols, 8000, trackPending);
					if (disposed) return;
					renderIndexCells(fallback);
					if (fallback.length > 0) saveQuotesCache({ index: fallback });
				};

				// 首帧：有上次行情快照则先回放（stale-while-revalidate，双击启动秒显有价数据），
				// 否则渲染占位；随后立即首轮拉取（不再等第一个刷新周期），回来无缝替换。
				const cachedQuotes = loadQuotesCache();
				renderTape(cachedQuotes?.tape ?? []);
				renderChips(cachedQuotes?.tape ?? []);
				syncIndexCells();
				renderIndexCells(cachedQuotes?.index ?? []);
				renderSessions(new Date());
				void refreshQuotes();
				void refreshIndices();

				function buildScheduler() {
					const periodMs = settings.refreshSec * 1000;
					const s = createRefreshScheduler([
						{ periodMs, run: () => { void refreshQuotes(); void refreshIndices(); } },
						{ periodMs: 60_000, run: () => renderSessions(new Date()) },
					], Math.min(periodMs, 5000));
					s.start();
					return s;
				}

				let scheduler = buildScheduler();

				/** 保存新设置后的统一生效入口：换掉旧 scheduler、全量重画。 */
				function activate(next) {
					settings = next;
					disposed = false;
					scheduler.stop();
					scheduler = buildScheduler();
					applyChrome();
					syncIndexCells();
					const cached = loadQuotesCache();
					renderTape(cached?.tape ?? []);
					renderChips(cached?.tape ?? []);
					renderIndexCells(cached?.index ?? []);
					renderSessions(new Date());
					void refreshQuotes();
					void refreshIndices();
				}

				// ── 设置面板 ───────────────────────────────────────────────

				const openHandlers = [];
				function openSettingsPanel() {
					for (const handler of openHandlers) handler();
				}
				gearTitlebar.addEventListener('click', openSettingsPanel);
				gearTape.addEventListener('click', openSettingsPanel);
				gearStatusbar.addEventListener('click', openSettingsPanel);

				openHandlers.push(() => {
					// 幂等：已开着就不叠第二层
					if (document.getElementById('mt-mask')) return;

					/** 符号列表解析：按行/逗号/空格拆分 → 去重 → 过滤无法识别的语法。 */
					const parseList = (text) =>
						text.split(/[\n,，\s]+/).map((s) => s.trim()).filter((s) => s !== '')
							.filter((s, i, arr) => arr.indexOf(s) === i)
							.filter((s) => classifyDirectSymbol(s) !== null);

					const mask = document.createElement('div');
					mask.className = 'mt-mask';
					mask.id = 'mt-mask';
					const panel = document.createElement('form');
					panel.className = 'mt-panel';
					panel.id = 'mt-panel';
					panel.autocomplete = 'off';

					// ── 头部：品牌图标块 + 标题/副标题 + 关闭按钮 ──
					const head = document.createElement('div');
					head.className = 'mt-head';
					const headIcon = document.createElement('span');
					headIcon.className = 'mt-head-icon';
					headIcon.innerHTML = CANDLE_SVG;
					const headTitles = document.createElement('div');
					headTitles.className = 'mt-head-titles';
					const headTitle = document.createElement('div');
					headTitle.className = 'mt-head-title';
					headTitle.textContent = '行情条设置';
					const headSub = document.createElement('div');
					headSub.className = 'mt-head-sub';
					headSub.textContent = '保存即刻生效 · 配置存于浏览器本地，刷新不丢失';
					headTitles.append(headTitle, headSub);
					const headClose = document.createElement('button');
					headClose.type = 'button';
					headClose.className = 'mt-head-close';
					headClose.title = '关闭';
					headClose.setAttribute('aria-label', '关闭设置');
					headClose.textContent = '✕';
					head.append(headIcon, headTitles, headClose);

					// ── 主体滚动区：三张分组卡片 + 语法提示 ──
					const bodyEl = document.createElement('div');
					bodyEl.className = 'mt-body';

					// 卡片一：显示区域（6 个滑块开关，两列网格）
					const cardV = document.createElement('div');
					cardV.className = 'mt-card';
					const cardVTitle = document.createElement('div');
					cardVTitle.className = 'mt-card-title';
					cardVTitle.innerHTML = '<span class="mt-dot"></span>显示区域';
					const toggles = document.createElement('div');
					toggles.className = 'mt-toggles';
					const checks = {};
					for (const [key, label] of [
						['showTitlebar', '仿终端标题栏'],
						['showTape', '行情跑马灯'],
						['showStatusbar', '底部指数栏'],
						['showSessions', '市场时段'],
						['redUp', '红涨绿跌（A股习惯）'],
						['pinTitleAndFavicon', '钉住标签页标题/图标'],
					]) {
						const rowEl = document.createElement('label');
						rowEl.className = 'mt-toggle-row';
						const labelSpan = document.createElement('span');
						labelSpan.textContent = label;
						const input = document.createElement('input');
						input.type = 'checkbox';
						input.checked = settings[key];
						checks[key] = input;
						const slider = document.createElement('span');
						slider.className = 'mt-slider';
						rowEl.append(labelSpan, input, slider);
						toggles.append(rowEl);
					}
					cardV.append(cardVTitle, toggles);

					// 卡片二：标题栏与刷新
					const cardN = document.createElement('div');
					cardN.className = 'mt-card';
					const cardNTitle = document.createElement('div');
					cardNTitle.className = 'mt-card-title';
					cardNTitle.innerHTML = '<span class="mt-dot"></span>标题栏与刷新';
					const rowNum = document.createElement('div');
					rowNum.className = 'mt-row';
					const lbTitle = document.createElement('label');
					lbTitle.className = 'mt-label';
					lbTitle.append(document.createTextNode('标题文字'));
					const inTitle = document.createElement('input');
					inTitle.className = 'mt-input';
					inTitle.type = 'text';
					inTitle.value = settings.titleText;
					inTitle.style.width = '250px';
					lbTitle.append(inTitle);
					const lbChip = document.createElement('label');
					lbChip.className = 'mt-label';
					lbChip.append(document.createTextNode('chips 数量（0~8）'));
					const inChip = document.createElement('input');
					inChip.className = 'mt-input mt-num';
					inChip.type = 'number';
					inChip.min = '0';
					inChip.max = '8';
					inChip.value = String(settings.chipCount);
					lbChip.append(inChip);
					const lbSec = document.createElement('label');
					lbSec.className = 'mt-label';
					lbSec.append(document.createTextNode('刷新间隔（秒，5~600）'));
					const inSec = document.createElement('input');
					inSec.className = 'mt-input mt-num';
					inSec.type = 'number';
					inSec.min = '5';
					inSec.max = '600';
					inSec.value = String(settings.refreshSec);
					lbSec.append(inSec);
					const lbGap = document.createElement('label');
					lbGap.className = 'mt-label';
					lbGap.append(document.createTextNode('状态栏间距（px，0~40）'));
					const inGap = document.createElement('input');
					inGap.className = 'mt-input mt-num';
					inGap.type = 'number';
					inGap.min = '0';
					inGap.max = '40';
					inGap.value = String(settings.statusGap);
					lbGap.append(inGap);
					rowNum.append(lbTitle, lbChip, lbSec, lbGap);
					cardN.append(cardNTitle, rowNum);

					// 卡片三：自选标的（实时「有效/忽略」计数徽章）
					const cardL = document.createElement('div');
					cardL.className = 'mt-card';
					const cardLTitle = document.createElement('div');
					cardLTitle.className = 'mt-card-title';
					cardLTitle.innerHTML = '<span class="mt-dot"></span>自选标的（每行一个，逗号或空格分隔）';
					const lbTape = document.createElement('div');
					lbTape.className = 'mt-list-head';
					const lbTapeText = document.createElement('label');
					lbTapeText.className = 'mt-label';
					lbTapeText.textContent = '跑马灯自选';
					const pillTape = document.createElement('span');
					pillTape.className = 'mt-pill';
					lbTape.append(lbTapeText, pillTape);
					const taTape = document.createElement('textarea');
					taTape.className = 'mt-textarea';
					taTape.placeholder = '每行一个，如 sz300059 / hk00700 / usAAPL / BTCUSDT / USD/CNY';
					taTape.value = settings.tapeSymbols.join('\n');
					const lbIdx = document.createElement('div');
					lbIdx.className = 'mt-list-head';
					const lbIdxText = document.createElement('label');
					lbIdxText.className = 'mt-label';
					lbIdxText.textContent = '状态栏指数';
					const pillIdx = document.createElement('span');
					pillIdx.className = 'mt-pill';
					lbIdx.append(lbIdxText, pillIdx);
					const taIdx = document.createElement('textarea');
					taIdx.className = 'mt-textarea';
					taIdx.placeholder = '如 hkHSI / hkHSTECH / usDJI / usIXIC';
					taIdx.value = settings.indexSymbols.join('\n');
					/** 徽章实时刷新：统计有效符号数与被忽略的无效数。 */
					const updatePill = (ta, pill) => {
						const tokens = ta.value.split(/[\n,，\s]+/).filter((s) => s.trim() !== '');
						const valid = parseList(ta.value);
						const invalid = tokens.length - valid.length;
						pill.textContent = '';
						pill.append('有效 ');
						const b = document.createElement('b');
						b.textContent = String(valid.length);
						pill.append(b);
						if (invalid > 0) pill.append(` · 忽略 ${invalid}`);
					};
					taTape.addEventListener('input', () => updatePill(taTape, pillTape));
					taIdx.addEventListener('input', () => updatePill(taIdx, pillIdx));
					updatePill(taTape, pillTape);
					updatePill(taIdx, pillIdx);
					cardL.append(cardLTitle, lbTape, taTape, lbIdx, taIdx);

					// 语法提示信息块
					const hint = document.createElement('div');
					hint.className = 'mt-hint';
					hint.innerHTML =
						'A股/港股/美股/指数：<code>sh000001</code>、<code>sz300059</code>、<code>hk00700</code>、<code>usAAPL</code>、<code>usIXIC</code>' +
						'　加密货币：大写交易对如 <code>BTCUSDT</code>' +
						'　外汇：<code>USD/CNY</code>。<br>未识别的符号会被忽略；若安装了 dsh-fun-ticker 插件，跑马灯会优先跟随其自选。';

					bodyEl.append(cardV, cardN, cardL, hint);

					// ── 底部操作区（固定不随内容滚动） ──
					const actions = document.createElement('div');
					actions.className = 'mt-actions';
					const btnReset = document.createElement('button');
					btnReset.type = 'button';
					btnReset.className = 'mt-action';
					btnReset.textContent = '恢复默认';
					const actionSpacer = document.createElement('span');
					actionSpacer.className = 'mt-spacer';
					const btnCancel = document.createElement('button');
					btnCancel.type = 'button';
					btnCancel.className = 'mt-action';
					btnCancel.textContent = '取消';
					const btnSave = document.createElement('button');
					btnSave.type = 'submit';
					btnSave.className = 'mt-action primary';
					btnSave.textContent = '保存并应用';
					actions.append(btnReset, actionSpacer, btnCancel, btnSave);

					panel.append(head, bodyEl, actions);
					mask.append(panel);

					const close = () => mask.remove();
					mask.addEventListener('click', (ev) => { if (ev.target === mask) close(); });
					headClose.addEventListener('click', close);
					btnCancel.addEventListener('click', close);
					btnReset.addEventListener('click', () => {
						activate(DEFAULTS_REF());
						close();
					});

					panel.addEventListener('submit', (ev) => {
						ev.preventDefault();
						const next = {
							showTitlebar: checks.showTitlebar.checked,
							showTape: checks.showTape.checked,
							showStatusbar: checks.showStatusbar.checked,
							showSessions: checks.showSessions.checked,
							redUp: checks.redUp.checked,
							pinTitleAndFavicon: checks.pinTitleAndFavicon.checked,
							titleText: inTitle.value.trim() || DEFAULTS.titleText,
							chipCount: Math.min(8, Math.max(0, Math.round(Number(inChip.value) || 0))),
							refreshSec: Math.min(600, Math.max(5, Math.round(Number(inSec.value) || DEFAULTS.refreshSec))),
							statusGap: Math.min(40, Math.max(0, Math.round(Number(inGap.value) || DEFAULTS.statusGap))),
							tapeSymbols: parseList(taTape.value),
							indexSymbols: parseList(taIdx.value),
						};
						saveSettings(next);
						activate(next);
						close();
					});

					root.append(mask);
				});

				/** 结构化克隆默认值的便捷函数（避免外部改动污染常量）。 */
				function DEFAULTS_REF() {
					return JSON.parse(JSON.stringify(DEFAULTS));
				}

				applyChrome();
				// 兜底：产品 #root 可能晚于插件激活才由 React 渲染出来，
				// 延迟重设让位补偿，保证 padding 一定落到 #root 上。
				setTimeout(applyChrome, 300);
				setTimeout(applyChrome, 1200);
				console.log('[dsh-market-ticker] client half registered');
			} catch (err) {
				console.error('[dsh-market-ticker] apply failed:', err);
			}
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
