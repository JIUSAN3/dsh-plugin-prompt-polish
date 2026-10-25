/**
 * dsh-plugin-prompt-polish / lib/index.js （host 侧）
 *
 * 桌面 Electron 端的 Web UI 不跑 dsh-client-modules 的运行时组合（__DSH_BOOT__ 只在
 * `dsh web` 注入），所以 package.json 的 dsh.client 在桌面端无效。桌面端唯一生效的
 * 第三方 UI 通道是 dsh-whale-widget 走的那条：
 *
 *   ① 同步注册 webserver/index-inject 处理函数（不依赖任何服务）
 *   ② ctx.inject(["webServer"]) 后注册 /prompt-polish/client.js 与 /prompt-polish/status
 *   ③ 页面侧脚本自检 composer 后挂按钮
 *
 * 两个必须守住的不变量：
 *   · 注入行只能同步注册。桌面端的注入表由宿主启动时收集一次、无刷新路径；订阅晚于
 *     那次收集，这一行就永远进不了表（whale-widget issue #152/#153 的竞态）。
 *   · 注入行必须是内联 `script` 行，不能用 `script-src` 行。桌面页面侧解释器对两种行
 *     处理不对称：`script` 行是 createElement + textContent + append（无 await，不可能失败），
 *     `script-src` 行是 await loadScript(src)，失败会 reject 掉 __DSH_BOOT_READY__ 让整个应用
 *     起不来。所以自己建 <script> 并吞掉 onerror，宿主永远不会因为本插件起不来。
 *
 * 不设信任栅栏（与 whale-widget 不同）：本插件只提供自己的前端脚本（已在 GitHub 公开）
 * 和一个计数器端点，不读凭据、不写文件、不暴露本机路径；而 dsh 的 webServer 默认只绑回环。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_FILE = path.join(HERE, "client-dom.js");
const ROUTE = "/prompt-polish/client.js";
const STATUS_ROUTE = "/prompt-polish/status";
const MARK = "prompt-polish/client.js";

/**
 * 页面注入串：自己建 <script>、自己吞 onerror、带 3 次重试。
 * 重试的存在理由：注入表在宿主启动时收集一次且没有刷新路径，若那次收集早于本插件注册
 * 路由（两个动作都在启动期），首次加载会 404；重试能在路由就绪后补上，失败只静默。
 */
const INDEX_ROW_TEXT =
	"(function(){var n=0;function go(){try{var d=document.body||document.head||document.documentElement;" +
	"if(!d){if(++n<3)setTimeout(go,400);return}" +
	`var s=document.createElement("script");s.src="${ROUTE}";s.async=true;` +
	"s.onerror=function(){if(++n<3)setTimeout(go,400)};d.appendChild(s)}catch(e){}}go()})()";

export const inject = [];

const diag = {
	hookCalls: 0,
	rowsPushed: 0,
	routes: 0,
	routeErrors: [],
	lastError: null,
	startedAt: new Date().toISOString(),
};

/** 同一个 webServer 实例只注册一次：重复注册会抛 "duplicate exact route"。 */
const registeredServers = new WeakSet();

/** 读取前端脚本。每次请求重读，因此改完 client-dom.js 刷新页面即生效，不必重启宿主。 */
function readClientCode() {
	return fs.readFileSync(CLIENT_FILE, "utf8");
}

function send(res, status, headers, body) {
	res.writeHead(status, headers);
	res.end(body);
}

function registerRoutes(server) {
	if (registeredServers.has(server)) return;
	registeredServers.add(server);

	server.register({
		kind: "exact",
		path: ROUTE,
		handler: (req, res) => {
			try {
				const code = readClientCode();
				send(res, 200, {
					"Content-Type": "application/javascript; charset=utf-8",
					"Content-Length": String(Buffer.byteLength(code)),
					"Cache-Control": "no-store",
					"X-Content-Type-Options": "nosniff",
				}, code);
			} catch (error) {
				const message = String((error && error.message) || error);
				diag.lastError = "read client: " + message;
				send(res, 500, {
					"Content-Type": "text/plain; charset=utf-8",
					"Cache-Control": "no-store",
				}, message);
			}
		},
	});
	diag.routes++;

	server.register({
		kind: "exact",
		path: STATUS_ROUTE,
		handler: (req, res) => {
			let clientBytes = null;
			let clientError = null;
			try {
				clientBytes = fs.statSync(CLIENT_FILE).size;
			} catch (error) {
				clientError = String((error && error.message) || error);
			}
			const payload = JSON.stringify({
				plugin: "dsh-plugin-prompt-polish",
				host: diag,
				clientBytes,
				clientError,
			}, null, 2);
			send(res, 200, {
				"Content-Type": "application/json; charset=utf-8",
				"Content-Length": String(Buffer.byteLength(payload)),
				"Cache-Control": "no-store",
			}, payload);
		},
	});
	diag.routes++;
}

export function apply(ctx) {
	// ① 注入行：必须同步注册，不能放进 inject 回调里等 webServer。
	try {
		ctx.on("webserver/index-inject", (table) => {
			diag.hookCalls++;
			try {
				if (!Array.isArray(table)) {
					diag.lastError = "index-inject table is not an array";
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
				diag.lastError = "push row: " + String((error && error.message) || error);
			}
		});
	} catch (error) {
		diag.lastError = "hook: " + String((error && error.message) || error);
		console.warn("[prompt-polish] index-inject hook skipped:", error);
	}

	// ② 路由：webServer 就绪后注册。
	try {
		ctx.inject(["webServer"], (scope) => {
			const server = scope.webServer || (typeof scope.get === "function" ? scope.get("webServer") : null);
			if (!server || typeof server.register !== "function") {
				diag.lastError = "webServer.register unavailable";
				console.warn("[prompt-polish] webServer.register unavailable");
				return;
			}
			try {
				registerRoutes(server);
			} catch (error) {
				const message = String((error && error.message) || error);
				diag.routeErrors.push(message);
				diag.lastError = "register routes: " + message;
				console.warn("[prompt-polish] route registration failed:", error);
			}
		});
	} catch (error) {
		diag.lastError = "inject: " + String((error && error.message) || error);
		console.warn("[prompt-polish] webServer inject skipped:", error);
	}
}
