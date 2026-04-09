import express, { Application, Request, Response } from "express";

const app: Application = express();
app.use(express.json({ limit: "100mb" }));
app.use(express.urlencoded({ extended: true }));

export default app;
