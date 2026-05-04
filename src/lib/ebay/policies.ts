import { createEbayClient } from './client'

interface EbayPolicy {
  fulfillmentPolicyId?: string
  paymentPolicyId?: string
  returnPolicyId?: string
  name: string
}

interface PolicyResponse {
  total: number
  fulfillmentPolicies?: EbayPolicy[]
  paymentPolicies?: EbayPolicy[]
  returnPolicies?: EbayPolicy[]
}

export interface BusinessPolicies {
  fulfillmentPolicyId: string
  paymentPolicyId: string
  returnPolicyId: string
}

/**
 * Fetches the user's eBay business policies (fulfillment, payment, return).
 * Returns the first available policy of each type.
 * If any policy type is missing, throws an error.
 */
export async function getBusinessPolicies(userId: string): Promise<BusinessPolicies> {
  const client = createEbayClient(userId)
  const marketplace = process.env.EBAY_MARKETPLACE_ID ?? 'EBAY_US'

  console.log(`[policies] Fetching business policies for marketplace=${marketplace}`)

  let fulfillmentRes, paymentRes, returnRes
  try {
    [fulfillmentRes, paymentRes, returnRes] = await Promise.all([
      client.get<PolicyResponse>('/sell/account/v1/fulfillment_policy', {
        params: { marketplace_id: marketplace },
      }),
      client.get<PolicyResponse>('/sell/account/v1/payment_policy', {
        params: { marketplace_id: marketplace },
      }),
      client.get<PolicyResponse>('/sell/account/v1/return_policy', {
        params: { marketplace_id: marketplace },
      }),
    ])
  } catch (err) {
    // Extract full eBay API error details
    let detail = String(err)
    if (err && typeof err === 'object' && 'response' in err) {
      const axiosErr = err as { response?: { status?: number; data?: unknown } }
      detail = `HTTP ${axiosErr.response?.status}: ${JSON.stringify(axiosErr.response?.data)}`
    }
    console.error(`[policies] ❌ Failed to fetch policies: ${detail}`)
    throw new Error(`Failed to fetch eBay business policies: ${detail}`)
  }

  console.log(`[policies] Fulfillment policies: ${JSON.stringify(fulfillmentRes.data.fulfillmentPolicies?.map(p => ({ id: p.fulfillmentPolicyId, name: p.name })) ?? [])}`)
  console.log(`[policies] Payment policies: ${JSON.stringify(paymentRes.data.paymentPolicies?.map(p => ({ id: p.paymentPolicyId, name: p.name })) ?? [])}`)
  console.log(`[policies] Return policies: ${JSON.stringify(returnRes.data.returnPolicies?.map(p => ({ id: p.returnPolicyId, name: p.name })) ?? [])}`)

  const fulfillmentPolicyId = fulfillmentRes.data.fulfillmentPolicies?.[0]?.fulfillmentPolicyId
  const paymentPolicyId = paymentRes.data.paymentPolicies?.[0]?.paymentPolicyId
  const returnPolicyId = returnRes.data.returnPolicies?.[0]?.returnPolicyId

  if (!fulfillmentPolicyId || !paymentPolicyId || !returnPolicyId) {
    const missing: string[] = []
    if (!fulfillmentPolicyId) missing.push('fulfillment (shipping)')
    if (!paymentPolicyId) missing.push('payment')
    if (!returnPolicyId) missing.push('return')
    const msg = `Missing eBay business policies: ${missing.join(', ')}. Please create these policies in your eBay Seller Hub → Business Policies before listings can be created automatically.`
    console.error(`[policies] ❌ ${msg}`)
    throw new Error(msg)
  }

  console.log(`[policies] ✅ All policies found`)
  return { fulfillmentPolicyId, paymentPolicyId, returnPolicyId }
}
