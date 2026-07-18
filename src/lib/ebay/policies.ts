import { createEbayClient } from './client'
import { describeEbayError } from './error'
import { withContext } from '@/lib/log'
import type { AxiosInstance } from 'axios'

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

/** eBay errorId returned when the seller isn't enrolled in the Business Policy program. */
const NOT_ELIGIBLE_FOR_BUSINESS_POLICY = 20403

/**
 * One-time enrollment in eBay's Selling Policy Management program. Required
 * before /sell/account/v1/* will return any policies. Idempotent — calling
 * twice is safe.
 *
 * eBay docs: https://developer.ebay.com/api-docs/sell/account/resources/program/methods/optInToProgram
 */
async function optInToBusinessPolicies(
  client: AxiosInstance,
  userId: string,
): Promise<void> {
  const log = withContext({ scope: 'ebay.policies.opt-in', user_id: userId })
  log.info('Opting seller into SELLING_POLICY_MANAGEMENT')
  try {
    await client.post('/sell/account/v1/program/opt_in', {
      programType: 'SELLING_POLICY_MANAGEMENT',
    })
    log.info('Opt-in succeeded')
  } catch (err) {
    const { summary, ctx } = describeEbayError(err)
    // eBay sometimes returns 400 with errorId=20401 when already opted in; treat as success.
    const alreadyOptedIn = ctx.errors?.some((e) => e.errorId === 20401)
    if (alreadyOptedIn) {
      log.info('Seller already opted in (eBay returned 20401)')
      return
    }
    log.error('Opt-in failed', { ...ctx, err: summary })
    throw new Error(`Failed to opt in to eBay Business Policies: ${summary}`)
  }
}

async function fetchPolicies(
  client: AxiosInstance,
  marketplace: string,
): Promise<{
  fulfillmentPolicies: EbayPolicy[]
  paymentPolicies: EbayPolicy[]
  returnPolicies: EbayPolicy[]
}> {
  const [fulfillmentRes, paymentRes, returnRes] = await Promise.all([
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
  return {
    fulfillmentPolicies: fulfillmentRes.data.fulfillmentPolicies ?? [],
    paymentPolicies: paymentRes.data.paymentPolicies ?? [],
    returnPolicies: returnRes.data.returnPolicies ?? [],
  }
}

/**
 * Chooses which policy to list under.
 *
 * A real selling account usually has several shipping policies. Taking
 * `[0]` and hoping meant the listing silently went out under whichever one
 * eBay happened to return first, which is not necessarily the one the seller
 * wants. `EBAY_{FULFILLMENT,PAYMENT,RETURN}_POLICY` pins the choice by policy
 * name or id; without it we keep the old behaviour but warn when the choice
 * was actually ambiguous.
 */
function pick(
  log: ReturnType<typeof withContext>,
  kind: string,
  list: EbayPolicy[],
  getId: (p: EbayPolicy) => string | undefined,
  preference?: string,
): string | undefined {
  const want = preference?.trim()
  if (want) {
    const match = list.find(
      (p) => getId(p) === want || p.name?.trim().toLowerCase() === want.toLowerCase(),
    )
    if (match) {
      log.info(`Pinned ${kind} policy from env`, { name: match.name, id: getId(match) })
      return getId(match)
    }
    log.warn(`No ${kind} policy matches the configured preference — falling back`, {
      preference: want,
      available: list.map((p) => p.name),
    })
  }

  if (list.length > 1) {
    log.warn(`Multiple ${kind} policies — defaulting to the first eBay returned`, {
      chosen: list[0]?.name,
      available: list.map((p) => p.name),
      hint: `Set EBAY_${kind.toUpperCase()}_POLICY to pin this.`,
    })
  }
  return list[0] ? getId(list[0]) : undefined
}

/**
 * Fetches the user's eBay business policies (fulfillment, payment, return).
 *
 * Self-heals the common 20403 "User is not eligible for Business Policy"
 * error by opting the seller into SELLING_POLICY_MANAGEMENT and retrying.
 *
 * After opt-in the seller still needs to have created at least one of each
 * policy in eBay Seller Hub — if any type is empty we throw a message that
 * tells the user exactly where to go.
 */
export async function getBusinessPolicies(userId: string): Promise<BusinessPolicies> {
  const log = withContext({ scope: 'ebay.policies', user_id: userId })
  const client = createEbayClient(userId)
  const marketplace = process.env.EBAY_MARKETPLACE_ID ?? 'EBAY_US'

  log.info('Fetching business policies', { marketplace })

  let policies
  try {
    policies = await fetchPolicies(client, marketplace)
  } catch (err) {
    const { summary, ctx } = describeEbayError(err)
    const isNotEligible = ctx.errors?.some(
      (e) => e.errorId === NOT_ELIGIBLE_FOR_BUSINESS_POLICY,
    )

    if (!isNotEligible) {
      log.error('Failed to fetch policies', { ...ctx, err: summary })
      throw new Error(`Failed to fetch eBay business policies: ${summary}`)
    }

    log.warn(
      'Seller not enrolled in Business Policies (errorId=20403) — auto-opting in and retrying',
      { ...ctx },
    )
    await optInToBusinessPolicies(client, userId)

    try {
      policies = await fetchPolicies(client, marketplace)
    } catch (retryErr) {
      const retry = describeEbayError(retryErr)
      log.error('Policy fetch still failing after opt-in', {
        ...retry.ctx,
        err: retry.summary,
      })
      throw new Error(
        `eBay Business Policies are unavailable even after auto-enrolling your account. ` +
          `Please open eBay Seller Hub → Business Policies, accept the terms, and create at least ` +
          `one shipping, payment, and return policy. Underlying error: ${retry.summary}`,
      )
    }
  }

  log.info('Policy lists fetched', {
    fulfillment_count: policies.fulfillmentPolicies.length,
    payment_count: policies.paymentPolicies.length,
    return_count: policies.returnPolicies.length,
  })

  const fulfillmentPolicyId = pick(
    log, 'fulfillment', policies.fulfillmentPolicies,
    (p) => p.fulfillmentPolicyId, process.env.EBAY_FULFILLMENT_POLICY,
  )
  const paymentPolicyId = pick(
    log, 'payment', policies.paymentPolicies,
    (p) => p.paymentPolicyId, process.env.EBAY_PAYMENT_POLICY,
  )
  const returnPolicyId = pick(
    log, 'return', policies.returnPolicies,
    (p) => p.returnPolicyId, process.env.EBAY_RETURN_POLICY,
  )

  if (!fulfillmentPolicyId || !paymentPolicyId || !returnPolicyId) {
    const missing: string[] = []
    if (!fulfillmentPolicyId) missing.push('fulfillment (shipping)')
    if (!paymentPolicyId) missing.push('payment')
    if (!returnPolicyId) missing.push('return')
    const msg =
      `Your eBay account is enrolled in Business Policies but is missing: ${missing.join(', ')}. ` +
      `Go to eBay Seller Hub → Account → Business Policies and create one ${missing.join(' / ')} policy, ` +
      `then click Retry.`
    log.error('Missing required policy types', { missing })
    throw new Error(msg)
  }

  log.info('All policies resolved', {
    fulfillment_policy_id: fulfillmentPolicyId,
    payment_policy_id: paymentPolicyId,
    return_policy_id: returnPolicyId,
  })
  return { fulfillmentPolicyId, paymentPolicyId, returnPolicyId }
}
