import { messages } from '@schema';
import { defineHandler, type InferProps } from 'void';
import { db, desc } from 'void/db';
import { createInsertSchema } from 'void/drizzle-zod';
export type Props = InferProps<typeof loader>;
export const loader = defineHandler(async () => ({
  messages: await db.select().from(messages).orderBy(desc(messages.id)),
}));
export const action = defineHandler.withValidator({
  body: createInsertSchema(messages, { text: (s) => s.trim().min(1).max(1000) }).pick({
    text: true,
  }),
})(async (_context, { body }) => {
  await db.insert(messages).values(body);
});
