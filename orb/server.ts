import express from "express";
import { ReadOnlyInterface } from "./readOnlyInterface";
import { getOrbState } from "./stateEngine";
export function createOrbServer(db: any) {
  const app = express(); const ro = new ReadOnlyInterface(db);
  app.get("/state", (req,res)=>{ const count=ro.getMemoryCount(); res.json({state:getOrbState(count,null),count}); });
  return app;
}
