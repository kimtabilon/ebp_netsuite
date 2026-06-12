"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const netsuite_client_1 = require("../services/netsuite.client");
async function run() {
    try {
        const poToSearch = "111-0960645-3422662";
        console.log(`Auditing Sales Order for PO: ${poToSearch}...`);
        // First find the ID of the SO
        const searchResult = await (0, netsuite_client_1.callDiagnostic)({
            sections: ["so_lookup"],
            po: poToSearch
        });
        const so = searchResult.so_lookup.sales_orders[0];
        if (!so) {
            console.log("Could not find Sales Order in NetSuite for that website order number!");
            return;
        }
        console.log(`Found SO ID: ${so.id} (${so.soNumber})`);
        // Now inspect the lines deeply
        const audit = await (0, netsuite_client_1.callDiagnostic)({
            sections: ["record_inspect"],
            recordType: "salesorder",
            id: so.id
        });
        const fields = audit.record_inspect.fields;
        const sublists = audit.record_inspect.sublists;
        console.log("SO Status:", fields.status);
        console.log("PO# Field on SO:", fields.otherrefnum || fields.poastext || "EMPTY");
        if (sublists && sublists.item) {
            console.log("Items on SO:");
            sublists.item.forEach((line) => {
                console.log(`Line ${line._line}: ItemID ${line.item}, Qty: ${line.quantity}, Fulfilled: ${line.quantityfulfilled}, Backordered: ${line.quantitybackordered}, Closed: ${line.isclosed}, DS Line: ${line.isdropshipline}, PO: ${line.poorderno}`);
            });
        }
    }
    catch (e) {
        console.error("Error:", e.message);
    }
}
run();
