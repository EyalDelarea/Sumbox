import type pg from "pg";

type ImportStatus = "pending" | "completed" | "failed";

type CreateImportInput = {
  groupId: number;
  sourcePath: string;
  sourceHash: string;
  originalFilePath: string;
  status: ImportStatus;
};

/**
 * Create a new import record and return its id.
 */
export async function createImport(
  client: pg.Pool | pg.PoolClient,
  input: CreateImportInput,
): Promise<number> {
  const result = await client.query<{ id: string }>(
    `
    INSERT INTO imports (group_id, source_path, source_hash, original_file_path, status)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING id
    `,
    [input.groupId, input.sourcePath, input.sourceHash, input.originalFilePath, input.status],
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error(`createImport: no row returned`);
  }
  return Number(row.id);
}

/**
 * Mark an import as completed.
 */
export async function markImportCompleted(
  client: pg.Pool | pg.PoolClient,
  importId: number,
): Promise<void> {
  await client.query(`UPDATE imports SET status = 'completed' WHERE id = $1`, [importId]);
}

/**
 * Update the original_file_path for an import record.
 * Used after the import id is known and the file has been written to disk.
 */
export async function updateImportFilePath(
  client: pg.Pool | pg.PoolClient,
  importId: number,
  originalFilePath: string,
): Promise<void> {
  await client.query(`UPDATE imports SET original_file_path = $2 WHERE id = $1`, [
    importId,
    originalFilePath,
  ]);
}

/**
 * Mark an import as failed, optionally recording the error message.
 */
export async function markImportFailed(
  client: pg.Pool | pg.PoolClient,
  importId: number,
  errorMessage?: string,
): Promise<void> {
  await client.query(`UPDATE imports SET status = 'failed', error_message = $2 WHERE id = $1`, [
    importId,
    errorMessage ?? null,
  ]);
}
