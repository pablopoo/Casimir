import { Form, useForm } from '@void/react';
import type { Props } from './index.server';
export default function HomePage({ messages }: Props) {
  const form = useForm('/', { text: '' });
  return (
    <main>
      <h1>Casimir notes</h1>
      <ul>
        {messages.map((message) => (
          <li key={message.id}>{message.text}</li>
        ))}
      </ul>
      <Form form={form}>
        <label>
          Message{' '}
          <input value={form.data.text} onChange={(e) => form.setData('text', e.target.value)} />
        </label>
        <button type="submit">Save</button>
      </Form>
    </main>
  );
}
