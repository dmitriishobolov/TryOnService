import type {
  CatalogGarmentDraft,
  CatalogProvider,
  CatalogProviderName,
} from "../types.js";
import { catalogProviderNames } from "../types.js";
import { createCustomProvider } from "./custom/index.js";

export function createCatalogProviders(
  names: CatalogProviderName[],
): CatalogProvider[] {
  const knownEntries: [CatalogProviderName, CatalogProvider][] =
    catalogProviderNames.map((name) => [
      name,
      name === "custom" ? createCustomProvider() : createStubProvider(name),
    ]);
  const known = new Map<CatalogProviderName, CatalogProvider>(knownEntries);

  return names.map((name) => {
    const provider = known.get(name);

    if (!provider) {
      throw new Error(`Unknown catalog provider: ${name}`);
    }

    return provider;
  });
}

function createStubProvider(name: CatalogProviderName): CatalogProvider {
  return {
    name,
    collect: async (): Promise<CatalogGarmentDraft[]> => {
      return [];
    },
  };
}
