/**
 * Foreign-key relationship registry used to emulate PostgREST "resource
 * embedding" (e.g. `.select('*, images(id, status)')`) against raw Postgres.
 *
 * Supabase/PostgREST infers these from FK metadata at runtime. We only need the
 * handful of relationships the app actually embeds, so we declare them
 * explicitly. This keeps the SQL generation deterministic and reviewable.
 *
 * `type`:
 *   - 'many': base row is the PARENT; embed an array of children where
 *             child.fk === base.pk. Result key holds an array.
 *   - 'one' : base row is the CHILD; embed the single parent where
 *             parent.pk === base.localKey. Result key holds an object (or null).
 */
export type EmbedType = 'many' | 'one'

export interface Relationship {
  /** Embedded table name. */
  table: string
  type: EmbedType
  /** For 'many': column on the child table that references base.pk. */
  fk?: string
  /** For 'many': primary key column on the base table (default 'id'). */
  pk?: string
  /** For 'one': column on the base table that references parent.pk. */
  localKey?: string
  /** For 'one': primary key column on the parent table (default 'id'). */
  parentPk?: string
}

/** baseTable -> embedName -> relationship */
export const RELATIONSHIPS: Record<string, Record<string, Relationship>> = {
  upload_batches: {
    images: { table: 'images', type: 'many', fk: 'batch_id', pk: 'id' },
  },
  images: {
    ocr_results: { table: 'ocr_results', type: 'many', fk: 'image_id', pk: 'id' },
  },
  product_searches: {
    upload_batches: {
      table: 'upload_batches',
      type: 'one',
      localKey: 'batch_id',
      parentPk: 'id',
    },
  },
}

export function getRelationship(base: string, embed: string): Relationship | undefined {
  return RELATIONSHIPS[base]?.[embed]
}
