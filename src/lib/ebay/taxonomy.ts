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

/**
 * eBay Motors Parts & Accessories categories live on a separate category tree
 * (tree ID 100 / marketplace EBAY_MOTORS_US). The main EBAY_US tree (ID 0)
 * does NOT contain these categories, so taxonomy lookups with the wrong tree
 * always fail — causing `ensureLeafCategoryId` to return null and the
 * subsequent publish to send a parent-level ID that eBay rejects (error 25005).
 *
 * Known eBay Motors Parts & Accessories top-level category IDs:
 *   6000  Parts & Accessories (root)
 *   10063 Car & Truck Parts & Accessories
 *   6750  Motorcycle Parts
 *   57929 Boats Parts & Accessories
 *   ...and many sub-categories including 33694 (Interior Parts & Accessories)
 *
 * Rather than maintaining an exhaustive allowlist, we detect Motors categories
 * by querying BOTH trees when the EBAY_US tree lookup fails. This is the
 * simplest approach that doesn't require us to keep a hardcoded category list.
 */
export function isMotorsCategoryId(categoryId: string): boolean {
  // Well-known Motors Parts & Accessories category IDs that are commonly used.
  // This list is a fast-path check; the full fallback happens in ensureLeafCategoryId.
  const KNOWN_MOTORS_ROOTS = new Set([
    '6000',   // Parts & Accessories
    '10063',  // Car & Truck Parts & Accessories  
    '33694',  // Interior Parts & Accessories
    '33696',  // Door Panels
    '33697',  // Hoods, Fenders & Bumpers
    '33698',  // Headlights & Lighting
    '33699',  // Mirrors
    '33700',  // Wheels, Tires & Parts
    '33705',  // Engine & Engine Parts
    '33741',  // Cooling Systems
    '262187', // Center, Overhead Consoles & Parts
    '262190', // Dashboard Panels & Glove Boxes
    '262191', // Dash Parts
    '64200',  // Exterior Parts & Accessories
    '6028',   // Brakes & Brake Parts
    '33743',  // Fuel System
    '33742',  // Suspension & Steering
    '50458',  // A/C & Heating
    '33741',  // Cooling System
    '33740',  // Transmission & Drivetrain
  ])
  return KNOWN_MOTORS_ROOTS.has(categoryId)
}

/** Category tree ID for eBay Motors US. */
const MOTORS_TREE_ID = '100'

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

/**
 * Returns the correct category tree ID for a given category. Motors categories
 * live on tree 100; all others live on the default marketplace tree.
 */
async function getTreeIdForCategory(userId: string, categoryId: string): Promise<string> {
  if (isMotorsCategoryId(categoryId)) return MOTORS_TREE_ID
  return getDefaultCategoryTreeId(userId)
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
 *
 * For automotive titles, also queries the Motors tree (100) to get
 * Motors-specific category suggestions alongside the default tree suggestions.
 */
export async function suggestLeafCategoryIds(
  userId: string,
  query: string,
  limit = 5,
): Promise<SuggestionRow[]> {
  if (!query || !query.trim()) return []
  const log = withContext({ scope: 'ebay.taxonomy.suggest', user_id: userId })

  const treesToQuery: string[] = []
  try {
    const defaultTree = await getDefaultCategoryTreeId(userId)
    treesToQuery.push(defaultTree)
  } catch {
    return []
  }

  // For automotive titles, also query the Motors tree so we get Motors-specific
  // leaf categories in the suggestions (they don't appear in the EBAY_US tree).
  const looksAutomotive = /\b(mercedes|benz|bmw|audi|ford|honda|toyota|chevrolet|vw|volkswagen|nissan|porsche|lexus|jeep|ram|gmc|hyundai|kia|tesla|subaru|mazda|dodge|chrysler|cadillac|buick|infiniti|acura|volvo|dashboard|bumper|fender|headlight|taillight|engine|interior|exterior|door panel|hood|trunk|mirror|wheel|brake|suspension|transmission|exhaust|cooling|fuel|oem|part|trim)\b/i.test(query)
  if (looksAutomotive && !treesToQuery.includes(MOTORS_TREE_ID)) {
    treesToQuery.unshift(MOTORS_TREE_ID) // Try Motors tree first for automotive queries
  }

  const client = createEbayClient(userId)
  const allRows: SuggestionRow[] = []
  const seen = new Set<string>()

  for (const treeId of treesToQuery) {
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
        .filter((r): r is SuggestionRow => !!r.categoryId && !seen.has(r.categoryId))
      for (const r of rows) seen.add(r.categoryId)
      allRows.push(...rows)
    } catch (err) {
      const { summary } = describeEbayError(err)
      log.warn('get_category_suggestions failed for tree', { tree_id: treeId, err: summary })
    }
  }

  const result = allRows.slice(0, limit)
  log.info('Taxonomy suggestions resolved', {
    count: result.length,
    top: result[0]?.categoryId,
    trees_queried: treesToQuery,
  })
  return result
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

  // Use the correct tree: Motors categories live on tree 100, not tree 0.
  // Querying the wrong tree returns null, which causes the caller to publish
  // with a parent-level category ID and eBay rejects it (error 25005).
  const treeIdsByPriority: string[] = []
  try {
    treeIdsByPriority.push(await getTreeIdForCategory(userId, categoryId))
    // Also try the default tree as a fallback in case our Motors detection misses something.
    const defaultTree = await getDefaultCategoryTreeId(userId)
    if (!treeIdsByPriority.includes(defaultTree)) treeIdsByPriority.push(defaultTree)
    // Always try tree 100 (Motors) as a final fallback.
    if (!treeIdsByPriority.includes(MOTORS_TREE_ID)) treeIdsByPriority.push(MOTORS_TREE_ID)
  } catch {
    return categoryId // best effort — fall back to what we have
  }

  const client = createEbayClient(userId)

  for (const treeId of treeIdsByPriority) {
    try {
      const res = await client.get<{ categorySubtreeNode: CategoryTreeNode }>(
        `/commerce/taxonomy/v1/category_tree/${encodeURIComponent(treeId)}/get_category_subtree`,
        { params: { category_id: categoryId } },
      )
      const node = res.data.categorySubtreeNode
      if (!node) continue

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
              tree_id: treeId,
              depth,
            })
          }
          return current.category.categoryId
        }
        current = current.childCategoryTreeNodes![0]
        depth++
        if (depth > 12) break // safety: eBay trees rarely exceed 8 levels
      }
    } catch (err) {
      const { summary, ctx } = describeEbayError(err)
      // 11003 = "The category specified does not exist" — try next tree.
      log.warn('get_category_subtree failed, trying next tree', { ...ctx, err: summary, category_id: categoryId, tree_id: treeId })
    }
  }

  log.warn('ensureLeafCategoryId: could not resolve leaf in any tree', { category_id: categoryId })
  return null
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
