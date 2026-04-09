"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sales_order = void 0;
const sales_order_stage_1 = require("../services/sales_order.stage");
const sales_order = async (req, res) => {
    try {
        const result = await (0, sales_order_stage_1.stageSalesOrders)();
        return res.json({ success: true, ...result });
    }
    catch (e) {
        console.error("Sales Order Error:", e);
        return res.status(500).json({ success: false, message: "Internal Server Error", error: e.message });
    }
};
exports.sales_order = sales_order;
