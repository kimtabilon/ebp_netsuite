"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.withConcurrency = withConcurrency;
exports.getConcurrencyStats = getConcurrencyStats;
exports.drainQueue = drainQueue;
const logger_config_1 = __importDefault(require("./logger.config"));
// ─────────────────────────────────────────────────────────────────────────────
// Shared concurrency semaphore for NetSuite API calls
//
// Account concurrency limit: 5
// Reserve 1 slot for UI / other integrations → usable slots: 4
//
// Both SO sync and PO sync acquire from this shared pool.
// If SO is using 3 slots, PO can only use 1 — and vice versa.
// Workers stay high (5 each) but actual HTTP concurrency is capped here.
// ─────────────────────────────────────────────────────────────────────────────
const MAX_CONCURRENT = parseInt(process.env.NS_MAX_CONCURRENT || "2", 10);
// Max time (ms) a worker will wait in the queue before giving up.
// Prevents infinite blocking when all slots are held by hung connections.
const ACQUIRE_TIMEOUT_MS = 60000; // 60s
let active = 0;
const queue = [];
function acquire(label) {
    if (active < MAX_CONCURRENT) {
        active++;
        return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            // Remove this entry from the queue so release() won't invoke it
            const idx = queue.findIndex(e => e.resolve === wrappedResolve);
            if (idx !== -1)
                queue.splice(idx, 1);
            reject(new Error(`[Concurrency] Timed out waiting for slot after ${ACQUIRE_TIMEOUT_MS}ms — ${label || "unknown"}`));
        }, ACQUIRE_TIMEOUT_MS);
        const wrappedResolve = () => { clearTimeout(timer); active++; resolve(); };
        queue.push({ resolve: wrappedResolve, reject, timer });
    });
}
function release() {
    active--;
    if (queue.length > 0) {
        const next = queue.shift();
        next.resolve();
    }
}
/**
 * Wraps a NetSuite API call with the shared concurrency limiter.
 * Usage: `const result = await withConcurrency(() => postToNetsuite(payload));`
 */
async function withConcurrency(fn, label) {
    const wasQueued = active >= MAX_CONCURRENT;
    const t0 = wasQueued ? Date.now() : 0;
    if (wasQueued) {
        logger_config_1.default.warn(`[Concurrency] QUEUED — all ${MAX_CONCURRENT} slots busy, ${queue.length + 1} waiting — ${label || "unknown"}`);
    }
    await acquire(label);
    if (wasQueued) {
        const waited = Date.now() - t0;
        logger_config_1.default.warn(`[Concurrency] RESUMED after ${waited}ms wait (${active}/${MAX_CONCURRENT}) — ${label || "unknown"}`);
    }
    try {
        return await fn();
    }
    finally {
        release();
    }
}
/** Current usage stats — useful for diagnostics */
function getConcurrencyStats() {
    return { active, queued: queue.length, max: MAX_CONCURRENT };
}
/**
 * Drain all queued waiters with an error — used during graceful shutdown
 * to unblock any workers waiting for a concurrency slot.
 */
function drainQueue() {
    while (queue.length > 0) {
        const entry = queue.shift();
        clearTimeout(entry.timer);
        entry.reject(new Error("[Concurrency] Server shutting down — slot acquisition cancelled"));
    }
}
