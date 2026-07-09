import type pg from "pg";

/** A chat-scope category (system-seeded or user-created), tenant-scoped via RLS. */
export type ScopeCategory = {
  id: number;
  name: string;
  isSystem: boolean;
  sortOrder: number;
};

const SYSTEM_CATEGORIES = ["עבודה", "אישי", "לקוחות"];

function mapRow(r: {
  id: string;
  name: string;
  is_system: boolean;
  sort_order: number;
}): ScopeCategory {
  return { id: Number(r.id), name: r.name, isSystem: r.is_system, sortOrder: r.sort_order };
}

/** List the tenant's categories, ordered by (sort_order, name). */
export async function listCategories(client: pg.Pool | pg.PoolClient): Promise<ScopeCategory[]> {
  const { rows } = await client.query<{
    id: string;
    name: string;
    is_system: boolean;
    sort_order: number;
  }>(
    `SELECT id, name, is_system, sort_order
     FROM scope_categories
     ORDER BY sort_order ASC, name ASC`,
  );
  return rows.map(mapRow);
}

/**
 * Create a user category (sort_order = max+1, is_system=false). Idempotent on
 * (tenant_id, name): a duplicate returns the existing row instead of erroring.
 */
export async function createCategory(
  client: pg.Pool | pg.PoolClient,
  name: string,
): Promise<ScopeCategory> {
  const inserted = await client.query<{
    id: string;
    name: string;
    is_system: boolean;
    sort_order: number;
  }>(
    `INSERT INTO scope_categories (name, sort_order, is_system)
     VALUES ($1, COALESCE((SELECT max(sort_order) + 1 FROM scope_categories), 0), false)
     ON CONFLICT (tenant_id, name) DO NOTHING
     RETURNING id, name, is_system, sort_order`,
    [name],
  );
  if (inserted.rows[0]) return mapRow(inserted.rows[0]);

  const existing = await client.query<{
    id: string;
    name: string;
    is_system: boolean;
    sort_order: number;
  }>(`SELECT id, name, is_system, sort_order FROM scope_categories WHERE name = $1`, [name]);
  return mapRow(existing.rows[0]!);
}

/**
 * Idempotently seed the system categories (עבודה/אישי/לקוחות) for the current
 * tenant. Reused when a new tenant registers; the default tenant is seeded in the
 * create_chat_scopes migration.
 */
export async function seedSystemCategories(client: pg.Pool | pg.PoolClient): Promise<void> {
  for (let i = 0; i < SYSTEM_CATEGORIES.length; i++) {
    await client.query(
      `INSERT INTO scope_categories (name, sort_order, is_system)
       VALUES ($1, $2, true)
       ON CONFLICT (tenant_id, name) DO NOTHING`,
      [SYSTEM_CATEGORIES[i], i],
    );
  }
}
