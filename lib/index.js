/**
 * dsh-plugin-prompt-polish / lib/index.js （host 侧）
 *
 * 桌面 Electron 端的 Web UI 不跑 dsh-client-modules 的运行时组合（__DSH_BOOT__ 只在
 * `dsh web` 注入），所以 package.json 的 dsh.client 在桌面端无效——v0.3 的教训。
 * 桌面端被验证有效的第三方 UI 路径只有一条：dsh-whale-widget 的做法。
 *
 *   ① ctx.webServer.register 提供 /prompt-polish/client.js（纯 DOM 脚本）
 *   ② 监听 webserver/index-inject，往每个 index 页面注入 <script src>
 *   ③ 浏览器脚本自检 composer 后挂按钮
 *
 * 自检：GET /prompt-polish/status 返回 host 计数（hookCalls / rowsPushed / lastError），
 * 用来区分"事件没触发"和"注入了但浏览器端没挂上"。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_FILE = path.join(HERE, "client-dom.js");
const ROUTE = "/prompt-polish/client.js";
const MARK = "prompt-polish/client.js";

/** 页面注入串：只建 <script>，吞掉 onerror，不给页面留可见副作用。 */
const INDEX_ROW_TEXT =
	"(function(){try{var d=document.body||document.head||document.documentElement;if(!d)return;" +
	`var s=document.createElement("script");s.src="${ROUTE}";s.async=true;` +
	"s.onerror=function(){};d.appendChild(s)}catch(e){}})()";

export const inject = [];

const diag = { hookCalls: 0, rowsPushed: 0, routes: 0, lastError: null, startedAt: new Date().toISOString() };

export function apply(ctx) {
	try {
		ctx.on("webserver/index-inject", (table) => {
			diag.hookCalls++;
			try {
				if (!Array.isArray(table)) {
					diag.lastError = "table is not an array";
					return;
				}
				const exists = table.some((row) => {
					if (!row) return false;
					if (row.kind === "script-src" && row.src === ROUTE) return true;
					if (row.kind === "script" && typeof row.text === "string" && row.text.includes(MARK)) return true;
					return false;
				});
				if (exists) return;
				table.push({ kind: "script", placement: "body", text: INDEX_ROW_TEXT });
				diag.rowsPushed++;
			} catch (error) {
				diag.lastError = String((error && error.message) || error);
			}
		});
	} catch (error) {
		diag.lastError = "hook: " + String((error && error.message) || error);
		console.warn("[prompt-polish] index-inject hook skipped:", error);
	}

	try {
		ctx.inject(["webServer"], (scope) => {
			const server = scope.webServer || (typeof scope.get === "function" ? scope.get("webServer") : null);
			if (!server || typeof server.register !== "function") {
				diag.lastError = "webServer.register unavailable";
				console.warn("[prompt-polish] webServer.register unavailable");
				return;
			}

			server.register({
				kind: "exact",
				path: ROUTE,
				handler: (req, res) => {
					try {
						const code = fs.readFileSync(CLIENT_FILE, "utf8");
						res.writeHead(200, {
							"Content-Type": "application/javascript; charset=utf-8",
							"Cache-Control": "no-store",
						});
						res.end(code);
					} catch (error) {
						res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
						res.end(String((error && error.message) || error));
					}
				},
			});
			diag.routes++;

			server.register({
				kind: "exact",
				path: "/prompt-polish/status",
				handler: (req, res) => {
					let bytes = null;
					try { bytes = fs.statSync(CLIENT_FILE).size; } catch { bytes = null; }
					res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
					res.end(JSON.stringify({ plugin: "dsh-plugin-prompt-polish", host: diag, clientBytes: bytes }, null, 2));
				},
			});
			diag.routes++;
		});
	} catch (error) {
		diag.lastError = "inject: " + String((error && error.message) || error);
		console.warn("[prompt-polish] webServer registration skipped:", error);
	}
}
