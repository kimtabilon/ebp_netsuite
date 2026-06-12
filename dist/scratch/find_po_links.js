"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const netsuite_client_1 = require("../services/netsuite.client");
async function run() {
    try {
        console.log("Inspecting Purchase Order 500505 (PO234430)...");
        const poAudit = await (0, netsuite_client_1.callDiagnostic)({
            sections: ["record_inspect"],
            recordType: "purchaseorder",
            id: 500505
        });
        if (poAudit.record_inspect.error) {
            console.error("Error finding PO:", poAudit.record_inspect.error);
        }
        else {
            console.log("PO Headers:", JSON.stringify(poAudit.record_inspect.fields, null, 2));
            console.log("PO Related Records:", JSON.stringify(poAudit.record_inspect.related_records, null, 2));
        }
        console.log("\nInspecting Sales Order 500205 (SO73364)...");
        const soAudit = await (0, netsuite_client_1.callDiagnostic)({
            sections: ["record_inspect"],
            recordType: "salesorder",
            id: 500205
        });
        if (soAudit.record_inspect.error) {
            console.error("Error finding SO:", soAudit.record_inspect.error);
        }
        else {
            console.log("SO Headers:", JSON.stringify(soAudit.record_inspect.fields, null, 2));
            console.log("SO Related Records:", JSON.stringify(soAudit.record_inspect.related_records, null, 2));
        }
    }
    catch (e) {
        console.error("Error:", e.message);
    }
}
run();
