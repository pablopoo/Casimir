import type { ErrorHandler } from 'hono';
import type { ApiEnv } from '../env.ts';
import { OperatorError } from '../operator/common.ts';
import { getPlatformDisplayName } from '../platform-identity.ts';
import { renderAdminPage } from './react/server.ts';

/** Browser and JSON clients share operations, while keeping their own rendering. */
export const renderOperationError: ErrorHandler<ApiEnv> = (error, context) => {
  if (!(error instanceof OperatorError)) {
    throw error;
  }
  return renderAdminPage(
    context,
    'adminError',
    'Admin error',
    {
      message: error.message,
      status: error.status,
      platformName: getPlatformDisplayName(context.env, context.req.url),
    },
    { status: error.status },
  );
};
