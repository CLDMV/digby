/*
 * Digby — the ONE app definition, shared by every platform.
 *
 * Both entries import this and hand it to launch(): src/app.mjs (which Electron
 * loads as the main process AND index.html loads as the renderer/web/mobile
 * module). launch() reads the slice for wherever it runs — main-side keys
 * (storage / deps / secrets) in the main process; renderer keys (brand / menus
 * / iconBar / splash + the lazy `app` extensions) in any web view.
 * `rummage build --target web|ios|android|desktop` reads the SAME file.
 *
 * RULE: no top-level node-only code here (the renderer imports this too). Use
 * `import.meta.url` for path refs (it exists in node AND the browser).
 * Renderer-only extension modules (DOM code) go in the lazy `app()` function
 * so the main process — which imports this file — never evaluates them.
 */
export default {
	name: "digby",
	title: "Digby",

	// OS window/taskbar icon. Point it at an .svg and rummage rasterizes a PNG
	// (cached); point it at a .png/.ico to use your own as-is. (Packaging with
	// electron-builder also wants `build.icon` — a 512+ PNG works for both.)
	// icon: new URL("./assets/icon.svg", import.meta.url),

	// ── ONE splash config for every platform ─────────────────────────────
	// Per-device overrides go in targets (mobile / web / ios / android /
	// desktop / phone / tablet / "ios.phone"-style exact keys) — every field
	// incl. profile + logo is overridable per target. See docs/splash.md.
	splash: {
		profile: "default"
		// logo: "./assets/logo.svg",
		// targets: { mobile: { padding: 8, progressPosition: [2, 3], progressEdge: true } }
	},

	// ── main-side services (ignored by launch() in a web view) ───────────
	// App-level sqlite migrations (sql/schema.mjs workflow — see sql/ docs).
	storage: { migrationsFolderUrl: new URL("./sql/migrations/", import.meta.url) },
	// secrets: true,                       // safeStorage-backed secrets service
	// deps: [{ name: "git", probeArgs: ["--version"] }],
	// extensions: { searchPaths: [new URL("./node_modules", import.meta.url).pathname] }, // node ext-host

	// ── renderer config (everything runApp accepts) ──────────────────────
	brand: { text: "Digby" /*, iconId: "ui.grid" */ },

	// Top-bar menus. The function-of-runtime form lets action callbacks
	// reach context.extensions via the api() helper passed in.
	menus: ({ api }) => [
		{ id: "file", label: "File", items: [
			{ items: [{ icon: "✕", text: "Exit", action: () => window.host?.window?.close?.() }] }
		] },
		{ id: "view", label: "View", items: [{ items: [
			{ icon: "↺", text: "Reload window",   action: () => window.host?.window?.reload?.() ?? location.reload() },
			{ icon: "⚙", text: "Toggle DevTools", action: () => window.host?.window?.toggleDevTools?.() },
			{ icon: "⚙", text: "Settings",        action: () => api("settings-pages")?.openContent?.({ scope: "full" }) }
		] }] },
		{ id: "help", label: "Help", items: [{ items: [
			{ icon: "ⓘ", builtin: "about" }
		] }] }
	],

	// Extra left-icon-bar entries (settings-pages already ships its own).
	iconBar: [
		// { id: "myapp.icon.featureA", title: "Feature A", icon: "ui.tree", order: 1, linkTo: "feature-a.main" }
	]

	// Your feature extensions' renderer entries — use the lazy `app` form so
	// renderer-only DOM modules are imported ONLY in a web view (the main
	// process imports this file but never calls app()):
	// , app: async () => ({ extensions: [await import("@cldmv/my-ext/src/view.mjs")] })
};
