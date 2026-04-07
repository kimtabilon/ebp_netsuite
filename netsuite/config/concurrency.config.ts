import log from "./logger.config";

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

const MAX_CONCURRENT = parseInt(process.env.NS_MAX_CONCURRENT || "4", 10);

// Max time (ms) a worker will wait in the queue before giving up.
// Prevents infinite blocking when all slots are held by hung connections.
const ACQUIRE_TIMEOUT_MS = 60_000; // 60s

let active = 0;
const queue: Array<{ resolve: () => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];

function acquire(label?: string): Promise<void> {
    if (active < MAX_CONCURRENT) {
        active++;
        return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
            // Remove this entry from the queue so release() won't invoke it
            const idx = queue.findIndex(e => e.resolve === wrappedResolve);
            if (idx !== -1) queue.splice(idx, 1);
            reject(new Error(`[Concurrency] Timed out waiting for slot after ${ACQUIRE_TIMEOUT_MS}ms — ${label || "unknown"}`));
        }, ACQUIRE_TIMEOUT_MS);

        const wrappedResolve = () => { clearTimeout(timer); active++; resolve(); };
        queue.push({ resolve: wrappedResolve, reject, timer });
    });
}

function release(): void {
    active--;
    if (queue.length > 0) {
        const next = queue.shift()!;
        next.resolve();
    }
}

/**
 * Wraps a NetSuite API call with the shared concurrency limiter.
 * Usage: `const result = await withConcurrency(() => postToNetsuite(payload));`
 */
export async function withConcurrency<T>(fn: () => Promise<T>, label?: string): Promise<T> {
    const wasQueued = active >= MAX_CONCURRENT;
    const t0 = wasQueued ? Date.now() : 0;

    if (wasQueued) {
        log.warn(`[Concurrency] QUEUED — all ${MAX_CONCURRENT} slots busy, ${queue.length + 1} waiting — ${label || "unknown"}`);
    }

    await acquire(label);

    if (wasQueued) {
        const waited = Date.now() - t0;
        log.warn(`[Concurrency] RESUMED after ${waited}ms wait (${active}/${MAX_CONCURRENT}) — ${label || "unknown"}`);
    }

    try {
        return await fn();
    } finally {
        release();
    }
}

/** Current usage stats — useful for diagnostics */
export function getConcurrencyStats() {
    return { active, queued: queue.length, max: MAX_CONCURRENT };
}

/**
 * Drain all queued waiters with an error — used during graceful shutdown
 * to unblock any workers waiting for a concurrency slot.
 */
export function drainQueue(): void {
    while (queue.length > 0) {
        const entry = queue.shift()!;
        clearTimeout(entry.timer);
        entry.reject(new Error("[Concurrency] Server shutting down — slot acquisition cancelled"));
    }
}
