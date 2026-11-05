export function loadConfig(env: Record<string, string | undefined>) {
  const { DATABASE_URL: databaseUrl, CASIMIR_TOKEN: token, CASIMIR_OPERATOR_ID: operatorId } = env;
  const port = Number(env.PORT ?? '4281');
  try {
    if (!databaseUrl) throw 0;
    const parsed = new URL(databaseUrl);
    if (
      !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
      !parsed.hostname ||
      parsed.pathname.length <= 1 ||
      parsed.hash
    )
      throw 0;
    if (
      !token?.trim() ||
      !operatorId?.trim() ||
      !/^\d+$/.test(env.PORT ?? '4281') ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535
    )
      throw 0;
  } catch {
    throw new Error('Casimir configuration invalid');
  }
  return { databaseUrl: databaseUrl!, token: token!, operatorId: operatorId!, port };
}
