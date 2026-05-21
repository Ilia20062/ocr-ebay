import { createEbayClient } from './client'
import { describeEbayError } from './error'
import { withContext } from '@/lib/log'

/**
 * eBay Taxonomy API helpers.
 *
 * Why this exists: the Browse API returns a `categories` array ordered
 * root → leaf. Listing in anything but a leaf returns errorId=25005
 * "invalid category ID". When a leaf is missing or has been retired, we fall
 * back to `get_category_suggestions` which always returns currently-listable
 * leaves keyed off the listing title.
 *
 * Docs:
 *   - https://developer.ebay.com/api-docs/commerce/taxonomy/resources/category_tree/methods/getDefaultCategoryTreeId
 *   - https://developer.ebay.com/api-docs/commerce/taxonomy/resources/category_tree/methods/getCategorySuggestions
 */

// Tree IDs are per-marketplace and stable, so we cache them globally.
const treeIdCache = new Map<string, string>()

export async function getDefaultCategoryTreeId(userId: string): Promise<string> {
  const marketplace = process.env.EBAY_MARKETPLACE_ID ?? 'EBAY_US'
  const cached = treeIdCache.get(marketplace)
  if (cached) return cached

  const log = withContext({ scope: 'ebay.taxonomy.tree-id', user_id: userId, marketplace })
  const client = createEbayClient(userId)
  try {
    const res = await client.get<{ categoryTreeId: string }>(
      '/commerce/taxonomy/v1/get_default_category_tree_id',
      { params: { marketplace_id: marketplace } },
    )
    const treeId = res.data.categoryTreeId
    treeIdCache.set(marketplace, treeId)
    log.info('Resolved category tree id', { category_tree_id: treeId })
    return treeId
  } catch (err) {
    const { summary, ctx } = describeEbayError(err)
    log.error('Failed to resolve category tree id', { ...ctx, err: summary })
    throw new Error(`Failed to resolve eBay category tree id: ${summary}`)
  }
}

interface CategorySuggestion {
  category: { categoryId: string; categoryName: string }
  categoryTreeNodeAncestors?: Array<{ categoryId: string; categoryName: string }>
  categoryTreeNodeLevel?: number
}

interface CategoryTreeNode {
  category: { categoryId: string; categoryName: string }
  childCategoryTreeNodes?: CategoryTreeNode[]
  leafCategoryTreeNode?: boolean
}

interface SuggestionRow {
  categoryId: string
  categoryName: string
}

/**
 * Returns up to `limit` leaf-category suggestions from eBay's Taxonomy API
 * keyed off the query (usually the listing title). Used both at draft
 * creation and as the auto-heal source on errorId=25005.
 */
export async function suggestLeafCategoryIds(
  userId: string,
  query: string,
  limit = 5,
): Promise<SuggestionRow[]> {
  if (!query || !query.trim()) return []
  const log = withContext({ scope: 'ebay.taxonomy.suggest', user_id: userId })

  let treeId: string
  try {
    treeId = await getDefaultCategoryTreeId(userId)
  } catch {
    return []
  }

  const client = createEbayClient(userId)
  try {
    const res = await client.get<{ categorySuggestions?: CategorySuggestion[] }>(
      `/commerce/taxonomy/v1/category_tree/${encodeURIComponent(treeId)}/get_category_suggestions`,
      { params: { q: query.slice(0, 350) } },
    )
    const rows = (res.data.categorySuggestions ?? [])
      .map((s) => ({
        categoryId: s.category?.categoryId,
        categoryName: s.category?.categoryName,
      }))
      .filter((r): r is SuggestionRow => !!r.categoryId)
      .slice(0, limit)
    log.info('Taxonomy suggestions resolved', {
      count: rows.length,
      top: rows[0]?.categoryId,
    })
    return rows
  } catch (err) {
    const { summary, ctx } = describeEbayError(err)
    log.error('get_category_suggestions failed', { ...ctx, err: summary })
    return []
  }
}

/** Back-compat wrapper used during draft creation. */
export async function suggestLeafCategoryId(
  userId: string,
  query: string,
): Promise<string | null> {
  const rows = await suggestLeafCategoryIds(userId, query, 1)
  return rows[0]?.categoryId ?? null
}

/**
 * Verifies that a categoryId is a *leaf* — eBay rejects listings under any
 * parent category (errorId=25005). Returns the same id when it's a leaf, the
 * first descendant leaf when it isn't, or null when the lookup fails.
 *
 * This is the safety net for stale/retired/parent categories that slip
 * through Browse-API responses or Taxonomy suggestions.
 */
export async function ensureLeafCategoryId(
  userId: string,
  categoryId: string | null | undefined,
): Promise<string | null> {
  if (!categoryId) return null
  const log = withContext({ scope: 'ebay.taxonomy.ensure-leaf', user_id: userId })

  let treeId: string
  try {
    treeId = await getDefaultCategoryTreeId(userId)
  } catch {
    return categoryId // best effort — fall back to what we have
  }

  const client = createEbayClient(userId)
  try {
    const res = await client.get<{ categorySubtreeNode: CategoryTreeNode }>(
      `/commerce/taxonomy/v1/category_tree/${encodeURIComponent(treeId)}/get_category_subtree`,
      { params: { category_id: categoryId } },
    )
    const node = res.data.categorySubtreeNode
    if (!node) return null

    // Walk down until we find a leaf. Prefer the official `leafCategoryTreeNode`
    // flag, fall back to "no children".
    let current: CategoryTreeNode | undefined = node
    let depth = 0
    while (current) {
      const isLeaf =
        current.leafCategoryTreeNode === true ||
        !current.childCategoryTreeNodes ||
        current.childCategoryTreeNodes.length === 0
      if (isLeaf) {
        if (current.category.categoryId !== categoryId) {
          log.info('Walked to descendant leaf', {
            from: categoryId,
            to: current.category.categoryId,
            depth,
          })
        }
        return current.category.categoryId
      }
      current = current.childCategoryTreeNodes![0]
      depth++
      if (depth > 12) break // safety: eBay trees rarely exceed 8 levels
    }
    return null
  } catch (err) {
    const { summary, ctx } = describeEbayError(err)
    // 11003 = "The category specified does not exist" — common for retired IDs.
    log.warn('get_category_subtree failed', { ...ctx, err: summary, category_id: categoryId })
    return null
  }
}

/**
 * Picks the leaf categoryId from a Browse-API `categories` array. eBay
 * orders this array root → leaf, so the last entry is the listable leaf.
 * Returns null when the array is empty/missing.
 */
export function pickLeafFromCategories(
  categories: Array<{ categoryId: string; categoryName?: string }> | undefined,
): string | null {
  if (!categories || categories.length === 0) return null
  return categories[categories.length - 1]?.categoryId ?? null
}
