"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NS_REST_DUMP_EXPAND_ITEM = void 0;
exports.nsRestDumpCronTimeoutMs = nsRestDumpCronTimeoutMs;
exports.nsRestDumpCronsEnabled = nsRestDumpCronsEnabled;
/** Per-id GET `expandSubResources` for line-level detail where NetSuite supports it */
exports.NS_REST_DUMP_EXPAND_ITEM = "item";
/** Cron guard timeout (ms). Large untilExhausted runs can exceed 10m. */
function nsRestDumpCronTimeoutMs() {
    const n = parseInt(process.env.NS_REST_DUMP_CRON_TIMEOUT_MS || "", 10);
    return Number.isFinite(n) && n >= 60000 ? n : 90 * 60 * 1000;
}
/** When not `"false"`, NetSuite REST dump crons are scheduled (default on). */
function nsRestDumpCronsEnabled() {
    return process.env.NS_REST_DUMP_CRONS_ENABLED !== "false";
}
