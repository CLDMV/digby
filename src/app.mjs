/*
 * Digby — the ONE entry, every platform. Electron loads this as the
 * main process (package.json "main") and index.html loads it as the
 * renderer/web/mobile module. launch() detects where it's running and performs
 * that platform's boot from the shared config — you write the config once
 * (rummage.config.mjs) and rummage handles the rest.
 *
 * The bare specifier resolves via package.json exports in main and via the
 * importmap in src/index.html in web contexts.
 */
import { launch } from "@cldmv/rummage/launch";
import config from "./rummage.config.mjs";

await launch(config);
