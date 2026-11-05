/** Restore the exact retained value even when an assertion fails. Test-only. */
export async function withOperatorSuspension(client, operatorId, suspension, work) {
  const previous = await client.query('SELECT suspended_reason FROM users WHERE id=$1', [
    operatorId,
  ]);
  if (previous.rowCount !== 1) throw new Error('test operator missing');
  try {
    await client.query('UPDATE users SET suspended_reason=$2 WHERE id=$1', [
      operatorId,
      suspension,
    ]);
    return await work();
  } finally {
    await client.query('UPDATE users SET suspended_reason=$2 WHERE id=$1', [
      operatorId,
      previous.rows[0].suspended_reason,
    ]);
  }
}
