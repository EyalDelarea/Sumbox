import type pg from "pg";

export type ServiceStatusRow = {
  id: number;
  collector_connected: boolean;
  last_heartbeat_at: Date | null;
  last_qr_at: Date | null;
  updated_at: Date;
};

/** Read the singleton service_status row (id = 1). */
export async function getServiceStatus(
  client: pg.Pool | pg.PoolClient,
): Promise<ServiceStatusRow | null> {
  const { rows } = await client.query<ServiceStatusRow>(
    `SELECT id, collector_connected, last_heartbeat_at, last_qr_at, updated_at
     FROM service_status
     WHERE id = 1`,
  );
  return rows[0] ?? null;
}

/** Set collector_connected on the singleton row; touches updated_at. */
export async function setCollectorConnected(
  client: pg.Pool | pg.PoolClient,
  connected: boolean,
): Promise<void> {
  await client.query(
    `UPDATE service_status
     SET collector_connected = $1, updated_at = now()
     WHERE id = 1`,
    [connected],
  );
}

/** Record a heartbeat — sets last_heartbeat_at = now() and touches updated_at. */
export async function recordHeartbeat(client: pg.Pool | pg.PoolClient): Promise<void> {
  await client.query(
    `UPDATE service_status
     SET last_heartbeat_at = now(), updated_at = now()
     WHERE id = 1`,
  );
}

/** Record a QR presentation — sets last_qr_at = now() and touches updated_at. */
export async function recordQr(client: pg.Pool | pg.PoolClient): Promise<void> {
  await client.query(
    `UPDATE service_status
     SET last_qr_at = now(), updated_at = now()
     WHERE id = 1`,
  );
}

/**
 * Pure helper — returns true if the singleton row is considered stale.
 * Stale means: last_heartbeat_at is null OR older than windowMs milliseconds ago.
 */
export function isStale(
  row: Pick<ServiceStatusRow, "last_heartbeat_at">,
  windowMs: number,
): boolean {
  if (row.last_heartbeat_at === null) return true;
  return Date.now() - row.last_heartbeat_at.getTime() > windowMs;
}
