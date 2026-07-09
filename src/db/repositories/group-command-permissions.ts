import type pg from "pg";

/** Stable identifier for the catch-up summary command. NOT the trigger text — the
 *  trigger will be user-editable and must never be part of a key, or renaming it would
 *  orphan every permission row. */
export const SUMMARY_COMMAND_KEY = "summary";

export type GroupCommandPermission = {
  groupId: number;
  command: string;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type GroupCommandPermissionRow = {
  group_id: number;
  command: string;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
};

function mapRow(r: GroupCommandPermissionRow): GroupCommandPermission {
  return {
    groupId: r.group_id,
    command: r.command,
    enabled: r.enabled,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * List all command permissions for the current tenant, optionally filtered
 * by command type. Returns an empty array when none are configured.
 */
export async function listCommandPermissions(
  client: pg.Pool | pg.PoolClient,
  command = SUMMARY_COMMAND_KEY,
): Promise<GroupCommandPermission[]> {
  const { rows } = await client.query<GroupCommandPermissionRow>(
    `SELECT group_id, command, enabled, created_at, updated_at
       FROM group_command_permissions
      WHERE command = $1
      ORDER BY group_id`,
    [command],
  );
  return rows.map(mapRow);
}

/**
 * Get enabled group JIDs for a command. Returns the group's whatsapp_id so
 * the allowlist can be populated from DB at startup and on hot-reload.
 */
export async function getEnabledGroupJids(
  client: pg.Pool | pg.PoolClient,
  command = SUMMARY_COMMAND_KEY,
): Promise<string[]> {
  const { rows } = await client.query<{ whatsapp_id: string }>(
    `SELECT g.whatsapp_id
       FROM group_command_permissions p
       JOIN groups g ON g.id = p.group_id
      WHERE p.command = $1 AND p.enabled = true`,
    [command],
  );
  return rows.map((r) => r.whatsapp_id);
}

/**
 * Upsert a group's command permission. Returns the resulting row.
 */
export async function upsertCommandPermission(
  client: pg.Pool | pg.PoolClient,
  input: { groupId: number; command?: string; enabled: boolean },
): Promise<GroupCommandPermission> {
  const command = input.command ?? SUMMARY_COMMAND_KEY;
  const { rows } = await client.query<GroupCommandPermissionRow>(
    `INSERT INTO group_command_permissions (group_id, command, enabled)
     VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, group_id, command)
     DO UPDATE SET enabled = $3, updated_at = now()
     RETURNING group_id, command, enabled, created_at, updated_at`,
    [input.groupId, command, input.enabled],
  );
  return mapRow(rows[0]!);
}

/**
 * Returns the full group list with their permission state for a command.
 * Each group in the tenant gets a row: left-joined so missing permissions
 * default to enabled = false.
 */
export async function listGroupsWithPermission(
  client: pg.Pool | pg.PoolClient,
  command = SUMMARY_COMMAND_KEY,
): Promise<Array<{ groupId: number; name: string; whatsappId: string; enabled: boolean }>> {
  const { rows } = await client.query<{
    id: number;
    name: string;
    whatsapp_id: string;
    enabled: boolean | null;
  }>(
    `SELECT g.id, g.name, g.whatsapp_id, p.enabled
       FROM groups g
       LEFT JOIN group_command_permissions p
         ON p.group_id = g.id AND p.command = $1
      ORDER BY g.name`,
    [command],
  );
  return rows.map((r) => ({
    groupId: r.id,
    name: r.name,
    whatsappId: r.whatsapp_id,
    enabled: r.enabled ?? false,
  }));
}
