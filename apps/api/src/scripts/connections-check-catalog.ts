// Entry point, owner-run (A-8): checks the Composio catalog's slugs and versions. See ../connections/check-catalog.ts.
import process from "node:process";
import { runCatalogCheck } from "../connections/check-catalog.js";

process.exitCode = await runCatalogCheck({ env: process.env, write: (line) => console.log(line) });
