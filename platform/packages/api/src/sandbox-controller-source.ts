// oxlint-disable-next-line typescript/triple-slash-reference -- dependent workspace projects need the virtual build module declaration.
/// <reference path="./sandbox-controller-modules.d.ts" />

import controllerSource from 'void:sandbox-controller-source';

/** The API build embeds the fixed controller; uploaded application code is never used. */
export function getSandboxControllerSource(): string {
  if (!controllerSource) {
    throw new Error('The platform runtime is missing its Sandbox controller bundle.');
  }
  return controllerSource;
}
