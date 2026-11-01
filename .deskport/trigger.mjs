#!/usr/bin/env node
/*
 * DeskPort trigger — run ON THE REMOTE (e.g. via an npm script) to ask the local
 * DeskPort VSCode extension to mirror this folder and launch a target:
 *   node .deskport/trigger.mjs <target-name>
 * Names match keys under "targets" in .deskport/config.json. Needs Node >= 20.11.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const target = process.argv[2];
if (!target) { process.stderr.write("trigger: node .deskport/trigger.mjs <target-name>\n"); process.exit(1); }
writeFileSync(join(import.meta.dirname, "trigger.json"), JSON.stringify({ target, nonce: Date.now() }) + "\n");
process.stdout.write("DeskPort: requested " + JSON.stringify(target) + " — the local extension will sync + launch it.\n");
