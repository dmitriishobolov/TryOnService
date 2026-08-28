import type {
  CatalogGarmentDraft,
  CatalogProvider,
  CatalogProviderName,
} from "../types.js";
import { catalogProviderNames } from "../types.js";

export function createCatalogProviders(
  names: CatalogProviderName[],
): CatalogProvider[] {
  const known = new Map<CatalogProviderName, CatalogProvider>(
    catalogProviderNames.map((name) => [name, createStubProvider(name)]),
  );

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