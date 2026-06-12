"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const netsuite_client_1 = require("../services/netsuite.client");
async function run() {
    try {
        console.log("Sending sync call to link PO 234430 to SO 73364...");
        const payload = {
            action: "update",
            po_number: 234430,
            otherrefnum: "234430",
            vendor_id: 131, // DLL
            distributor: "DLL",
            distributor_order_number: "234430",
            status: "Pending Receipt",
            invoice: "",
            tracking: "",
            order_items: [
                {
                    sku: "56F0Z00",
                    qty: 1,
                    cost: 64.86
                }
            ],
            website_order_number: "112-3267350-0643457",
            po_type: "Dropship",
            stocking_warehouse: "",
            created_at: "5/16/2026"
        };
        const response = await (0, netsuite_client_1.postToNetsuiteForPO)(payload);
        console.log("NetSuite RESTlet Response:", JSON.stringify(response, null, 2));
    }
    catch (e) {
        console.error("Error sending sync call:", e.message);
    }
}
run();
