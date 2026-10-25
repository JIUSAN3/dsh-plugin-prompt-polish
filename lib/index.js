/**
 * dsh-plugin-prompt-polish / lib/index.js （host 侧）
 *
 * 客户端入口由 dsh-client-modules 依据 package.json 的 `dsh.client` 自动加载并注入，
 * 不需要 host 侧注册任何路由或 index-inject 钩子。宿主侧保持空实现：
 * 本插件不注册工具、不占 RPC、不改任何请求。
 *
 * 加载链路（已在本机 dsh 0.2.1-rc 上核对）：
 *   profile bundles → ctx.loader.entries()
 *     → dsh-client-modules 扫描 dsh.client 声明 + exports["./client"]
 *     → 注入 <script>，浏览器以 window.__ModuleLoader__.load({ id, factory }) 执行
 *     → factory 内 apply(ctx) 拿到完整 ctx，可 ctx.slots.register(...)
 */
export const inject = [];

export function apply() {
	// 空实现：全部行为在 client/client.js。
}
