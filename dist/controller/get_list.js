"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.get_all_sales_orders = void 0;
const mongdodb_config_1 = require("../config/mongdodb.config");
const get_all_sales_orders = async (req, res) => {
    try {
        const db = await (0, mongdodb_config_1.getDb)("netsuite");
        const collection = db.collection("suite_sales_order");
        const data = await collection.find({}).toArray();
        return res.json({
            success: true,
            count: data.length,
            data
        });
    }
    catch (e) {
        console.error("Read Sales Orders Error:", e);
        return res.status(500).json({
            success: false,
            message: "Internal Server Error",
            error: e.message
        });
    }
};
exports.get_all_sales_orders = get_all_sales_orders;
