/**
 * dsh-market-ticker — 宿主半区（Node）
 *
 * 本插件是纯浏览器 UI 插件，宿主侧没有行为。这个入口只为 cordis.patch.yml
 * 的 insert 行提供可激活的惰性条目：profile 启动时宿主会 import 包根导出并
 * 等待其 inject 声明的服务，若根导出指向浏览器代码，宿主树里永远等不到对应
 * 服务，启动断言直接失败（`plugin tree failed to load`）。
 * 因此根导出必须是这个无依赖 no-op；浏览器半区经 "./client" 由 web GUI 从
 * /plugins/dsh-market-ticker/client.js 加载。
 * 兼容 DSH >= 0.1.0-rc.8。
 */

/** 稳定 cordis 插件名（与 cordis.patch.yml 的 insert id 一致）。 */
const name = 'dsh-market-ticker';

/** 惰性入口不需要任何服务。 */
const inject = [];

/** 无行为宿主入口：让加载器判定该行已激活即可。 */
function apply(_ctx) {}

export { apply, inject, name };
