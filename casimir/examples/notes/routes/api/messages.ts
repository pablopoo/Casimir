import { messages } from '@schema';
import { defineHandler } from 'void';
import { db } from 'void/db';
import { createInsertSchema } from 'void/drizzle-zod';
export const GET = defineHandler(async () => ({ messages: await db.select().from(messages) }));
export const POST = defineHandler.withValidator({
  body: createInsertSchema(messages, { text: (s) => s.trim().min(1).max(1000) }).pick({
    text: true,
  }),
})(async (_context, { body }) => ({ rows: await db.insert(messages).values(body).returning() }));
