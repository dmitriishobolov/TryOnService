import type { CatalogProvider } from "../../types.js";
import { collectTsumCatalog } from "./parser.js";

export function createTsumProvider(): CatalogProvider {
  return {
    name: "tsum",
    collect: collectTsumCatalog,
  };
}
