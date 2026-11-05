import { defineHandler } from 'void';
import { ai } from 'void/ai';
import { UsageLimit } from 'void/limits';

function textInputForModel(model: string, prompt: string) {
  if (model.startsWith('google/')) {
    return {
      contents: [
        {
          role: 'user',
          parts: [{ text: prompt }],
        },
      ],
      generationConfig: {
        maxOutputTokens: 512,
      },
    };
  }

  return {
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 512,
  };
}

export const POST = defineHandler(async (c) => {
  const { prompt, model } = await c.req.json<{
    prompt: string;
    model: string;
  }>();

  try {
    const inputs = textInputForModel(model, prompt);
    if (model.startsWith('google/')) {
      return c.json(await ai.run(model, inputs));
    }

    return await ai.stream(model, inputs);
  } catch (err) {
    if (err instanceof UsageLimit) {
      return err.response({ message: 'AI is temporarily unavailable. Your prompt has been kept.' });
    }
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 400);
  }
});
