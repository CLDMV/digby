/**
 * Drizzle table declarations for @cldmv/digby's OWN app-level data.
 * Distinct from extension tables (each extension owns its own sql/schema.mjs
 * in its own package). This file is for tables the app itself needs.
 *
 * Workflow — the ONLY way to add a migration. Never hand-write a migration.sql:
 * drizzle-kit needs the snapshot.json it emits alongside to diff the next change.
 * `npm run generate:check` fails CI if schema and migrations ever drift.
 *   1. Edit this file (add tables, columns).
 *   2. Run `npm run generate` (→ rummage generate) → writes
 *      sql/migrations/<ts>_<name>/ (migration.sql + snapshot.json).
 *   3. Commit BOTH the schema change AND the generated migration folder.
 *   4. Migrations auto-apply on the next app boot via installStorageService.
 *
 * Drop this file entirely if your app doesn't need its own tables —
 * extensions own all your data in that case.
 */

// Example — uncomment the import and the table, then rename, or replace with your own tables.
//
// import { table, integer, text } from "@cldmv/rummage/storage";
//
// export const appState = table("app__state", {
// 	key: text("key").primaryKey(),
// 	value: text("value").notNull(),
// 	updated: integer("updated").notNull()
// });
