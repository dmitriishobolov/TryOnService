import type { CatalogProvider } from "../../types.js";
import { collectCustomCatalog } from "./parser.js";

export function createCustomProvider(): CatalogProvider {
  return {
    name: "custom",
    collect: collectCustomCatalog,
  };
}
