import { SetMetadata, type CustomDecorator } from '@nestjs/common';

import { IS_PUBLIC_KEY } from '../auth.constants';

/**
 * Marks a route handler (or an entire controller) as public so the global
 * {@link AccessTokenGuard} lets the request through without a bearer token.
 */
export const Public = (): CustomDecorator<string> =>
  SetMetadata(IS_PUBLIC_KEY, true);
