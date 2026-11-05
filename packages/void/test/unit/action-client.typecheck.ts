import { expectTypeOf } from 'vite-plus/test';
import { createActionClient, type ActionResult } from '../../src/pages/client.ts';

const { action } = createActionClient();

expectTypeOf(action('/__action-test/static')).toEqualTypeOf<Promise<ActionResult>>();
action('/__action-test/static', { data: { name: 'Alice' }, method: 'DELETE' });
action('/__action-test/users/:id?save', { params: { id: '1' }, data: { name: 'Alice' } });

// @ts-expect-error Dynamic actions require parameters.
action('/__action-test/users/:id?save');
// @ts-expect-error Parameterless actions do not accept parameters.
action('/__action-test/static', { params: { id: '1' } });
// @ts-expect-error Action bodies retain their generated types.
action('/__action-test/static', { data: { name: 1 } });
// @ts-expect-error Named actions retain their generated body types.
action('/__action-test/users/:id?save', { params: { id: '1' }, data: { name: 1 } });
// @ts-expect-error Actions only accept mutation methods.
action('/__action-test/static', { method: 'GET' });
// @ts-expect-error Only known named actions are accepted.
action('/__action-test/users/:id?missing', { params: { id: '1' } });
