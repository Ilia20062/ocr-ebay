export interface EbayTokenResponse {
  access_token: string
  refresh_token: string
  expires_in: number
  token_type: string
}

export interface EbayItemSummary {
  itemId: string
  title: string
  price: { value: string; currency: string }
  condition: string
  itemWebUrl: string
  image?: { imageUrl: string }
  categories?: Array<{ categoryId: string; categoryName: string }>
  seller?: { username: string; feedbackScore: number }
}

export interface EbaySearchResponse {
  itemSummaries?: EbayItemSummary[]
  total: number
  href: string
}

export interface EbayInventoryItem {
  sku: string
  product: {
    title: string
    description: string
    aspects?: Record<string, string[]>
  }
  condition: string
  availability: {
    shipToLocationAvailability: { quantity: number }
  }
}

export interface EbayOffer {
  sku: string
  marketplaceId: string
  format: 'FIXED_PRICE'
  availableQuantity: number
  categoryId: string
  listingPolicies: {
    fulfillmentPolicyId: string
    paymentPolicyId: string
    returnPolicyId: string
  }
  pricingSummary: {
    price: { value: string; currency: string }
  }
}

export interface EbayApiError {
  errors?: Array<{
    errorId: number
    domain: string
    category: string
    message: string
    longMessage: string
  }>
}
