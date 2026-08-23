import { randomUUID } from "node:crypto";
import "./chunk.js";
import "../shared/util.js";
import "@fixture/dependency-clean/subpath";
import "peer-lib";

const legacy = require("./legacy.cjs");

export function build() {
  return { id: randomUUID(), legacy };
}
