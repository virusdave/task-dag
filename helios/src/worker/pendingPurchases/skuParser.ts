/**
 * SKU Parser for Pending Purchases
 * Implements waterfall parsing: Manifest → Cache → LLM
 */

export interface ParsedTaxonomy {
  brand: string
  category: string
  subcategory: string
  variantName: string
  strainName?: string
  packSize?: string
  packCount?: number
  distributorSku?: string
}

export interface ManifestItem {
  distributorProductName: string
  brand: string
  category: string
  subcategory?: string
  variantName: string
  strainName?: string
  packSize?: string
  packCount?: number
  metrcTag?: string
}

export class SKUParser {
  private manifestOverrides: Map<string, ManifestItem> = new Map()
  private llmCache: Map<string, ParsedTaxonomy> = new Map()

  constructor(
    private manifestPath?: string,
    private llmCachePath?: string
  ) {}

  async initialize(): Promise<void> {
    // Load manifest overrides if provided
    if (this.manifestPath) {
      // TODO: Load manifest JSON from file
      // For now, empty map
    }

    // Load LLM cache if provided
    if (this.llmCachePath) {
      // TODO: Load cache JSON from file
      // For now, empty map
    }
  }

  /**
   * Parse distributor product name using waterfall approach
   */
  async parse(distributorProductName: string): Promise<ParsedTaxonomy> {
    // Priority 1: Manifest override
    const manifestItem = this.manifestOverrides.get(distributorProductName)
    if (manifestItem) {
      return this.manifestItemToTaxonomy(manifestItem)
    }

    // Priority 2: LLM cache
    const cachedParse = this.llmCache.get(distributorProductName)
    if (cachedParse) {
      return cachedParse
    }

    // Priority 3: LLM parse (fallback)
    return this.llmParse(distributorProductName)
  }

  private manifestItemToTaxonomy(item: ManifestItem): ParsedTaxonomy {
    return {
      brand: item.brand,
      category: item.category,
      subcategory: item.subcategory || '',
      variantName: item.variantName,
      strainName: item.strainName,
      packSize: item.packSize,
      packCount: item.packCount,
      distributorSku: item.distributorProductName,
    }
  }

  private async llmParse(distributorProductName: string): Promise<ParsedTaxonomy> {
    // TODO: Call Bedrock Mantle LLM for parsing
    // For now, return basic parse
    return {
      brand: 'Unknown',
      category: 'Unknown',
      subcategory: '',
      variantName: distributorProductName,
    }
  }

  /**
   * Add manifest override
   */
  addManifestOverride(distributorProductName: string, item: ManifestItem): void {
    this.manifestOverrides.set(distributorProductName, item)
  }

  /**
   * Add to LLM cache
   */
  addToCache(distributorProductName: string, taxonomy: ParsedTaxonomy): void {
    this.llmCache.set(distributorProductName, taxonomy)
  }
}
