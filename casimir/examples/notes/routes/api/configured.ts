import { defineHandler } from 'void';
import { env } from 'void/env';
export const GET = defineHandler(() => ({ configured: Boolean(env.SERVER_ONLY) }));
