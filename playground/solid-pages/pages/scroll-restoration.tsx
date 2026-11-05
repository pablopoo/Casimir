import { Link } from '@void/solid';
import { For } from 'solid-js';

export default function ScrollRestorationPage() {
  const rows = Array.from({ length: 80 }, (_, index) => index + 1);

  return (
    <div>
      <h1>Scroll restoration</h1>
      <p>Scroll down, follow a link, then use the browser Back button.</p>
      <For each={rows}>
        {(row) => (
          <section data-testid={`scroll-row-${row}`} style={{ height: '120px' }}>
            <h2 style={{ margin: 0 }}>Row {row}</h2>
            <a href="/users">Go to Users</a>
            <Link href="/users">Visit Users</Link>
          </section>
        )}
      </For>
    </div>
  );
}
