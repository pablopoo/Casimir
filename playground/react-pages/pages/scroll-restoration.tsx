import { Link } from '@void/react';

export default function ScrollRestorationPage() {
  return (
    <div>
      <h1>Scroll restoration</h1>
      <p>Scroll down, follow a link, then use the browser Back button.</p>
      {Array.from({ length: 80 }, (_, index) => {
        const row = index + 1;
        return (
          <section key={row} data-testid={`scroll-row-${row}`} style={{ height: '120px' }}>
            <h2 style={{ margin: 0 }}>Row {row}</h2>
            <a href="/users">Go to Users</a>
            <Link href="/users">Visit Users</Link>
          </section>
        );
      })}
    </div>
  );
}
