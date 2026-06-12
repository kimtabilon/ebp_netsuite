"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
// ─────────────────────────────────────────────────────────────────────────────
// RESET FULFILLMENTS BY PO NUMBERS RUNNER SCRIPT
//
// Usage:
//   npx tsx netsuite/scratch/reset_fulfillments_by_po.ts 224801 224701 224699
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
    const args = process.argv.slice(2);
    if (args.length === 0) {
        console.error("Usage: npx tsx netsuite/scratch/reset_fulfillments_by_po.ts <po_num1> <po_num2> ...");
        process.exit(1);
    }
    // Parse all space-separated or comma-separated PO numbers
    const poNumbers = [];
    for (const arg of args) {
        const parts = arg.split(/[\s,]+/);
        for (const part of parts) {
            const num = parseInt(part.trim(), 10);
            if (!isNaN(num)) {
                poNumbers.push(num);
            }
        }
    }
    if (poNumbers.length === 0) {
        console.error("No valid PO numbers found in the arguments.");
        process.exit(1);
    }
    console.log(`Resetting fulfillments for ${poNumbers.length} POs:`, poNumbers);
    // await resetFulfillmentsByPoNumbers(poNumbers);
    process.exit(0);
}
main().catch(err => {
    console.error("Error running reset script:", err);
    process.exit(1);
});
