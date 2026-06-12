"use strict";
// ─────────────────────────────────────────────────────────────────────────────
// NETSUITE SYNC MODE SWITCH (per transaction type)
//
// "skip"   → Only CREATE new records. Skip if already synced.
// "update" → CREATE new + UPDATE existing records.
//
// HOW TO TOGGLE: Change the values below and restart the server.
// ─────────────────────────────────────────────────────────────────────────────
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_RETRIES = exports.STOP_ON_ERROR = exports.TEST_MODE = exports.SYNC_MODE_BILL = exports.SYNC_MODE_PO = exports.SYNC_MODE_SO = void 0;
exports.SYNC_MODE_SO = "update"; // SO needs update for status changes
exports.SYNC_MODE_PO = "update"; // PO: update — corrects existing zero-dollar or mismatched POs
exports.SYNC_MODE_BILL = "skip"; // Bill: skip — one-time creation
// ⚠️ TEST_MODE: When true, stops after the first real insert/update (skips don't count).
// Set to false for full production sync.
exports.TEST_MODE = false;
// ─────────────────────────────────────────────────────────────────────────────
// STOP_ON_ERROR: Controls what happens when one order fails.
//
// true  → Stop the entire sync batch. Safe for debugging — prevents cascading issues.
// false → Log the error, mark the order as failed, continue with remaining orders.
//         Failed orders can be retried via GET /retry-failed-so
// ─────────────────────────────────────────────────────────────────────────────
exports.STOP_ON_ERROR = false;
// MAX_RETRIES: How many times a failed order can be retried before being permanently skipped.
exports.MAX_RETRIES = 3;
