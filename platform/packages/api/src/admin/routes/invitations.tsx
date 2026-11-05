import { Hono } from 'hono';
import type { ApiEnv } from '../../env.ts';
import {
  parseAccessList,
  revokeOperatorInvitation,
  sendOperatorInvitations,
} from '../../operator/access-service.ts';
import { executeAuditedMutation, operatorAuditIntent } from '../../operator/audit.ts';
import { OperatorError } from '../../operator/common.ts';
import { renderFateListPage } from '../fate/render.ts';
import { renderOperationError } from '../operation-error.tsx';

const app = new Hono<ApiEnv>();
app.onError(renderOperationError);

app.get('/', async (context) =>
  context.req.header('X-VoidPages') === 'true'
    ? renderFateListPage(context, 'invitations')
    : context.redirect('/admin/signup-control'),
);

app.post('/send', async (context) => {
  const body = await context.req.parseBody();
  const emails = parseAccessList(String(body.email ?? ''));
  return executeAuditedMutation(
    context,
    operatorAuditIntent('invitations/send', { emails }),
    async () => {
      await sendOperatorInvitations(context, emails);
      return {
        response: context.redirect('/admin/signup-control?result=invited'),
        succeeded: true,
      };
    },
  );
});

app.post('/revoke', async (context) => {
  const body = await context.req.parseBody();
  if (!body.id) {
    throw new OperatorError(400, 'Missing invitation ID');
  }
  const invitationId = String(body.id);
  return executeAuditedMutation(
    context,
    operatorAuditIntent(`invitations/${invitationId}/revoke`),
    async () => {
      try {
        await revokeOperatorInvitation(context, invitationId);
      } catch (error) {
        if (error instanceof OperatorError && (error.status === 404 || error.status === 409)) {
          throw new OperatorError(400, 'Invitation not found or not pending');
        }
        throw error;
      }
      return { response: context.redirect('/admin/signup-control'), succeeded: true };
    },
  );
});

export default app;
