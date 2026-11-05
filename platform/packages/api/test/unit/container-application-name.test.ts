import { describe, it, expect } from 'vite-plus/test';
import { perDeployContainerApplicationName } from '../../src/provisioning/containers.ts';

describe('perDeployContainerApplicationName', () => {
  it('lowercases and converts underscores to dashes', () => {
    expect(perDeployContainerApplicationName('proj_ABC', 'dpl_XYZ', 'My_Sandbox')).toBe(
      'proj-abc-dpl-xyz-my-sandbox',
    );
  });

  it('produces unique-per-deploy names', () => {
    const a = perDeployContainerApplicationName('proj_x', 'dpl_1', 'sb');
    const b = perDeployContainerApplicationName('proj_x', 'dpl_2', 'sb');
    expect(a).not.toBe(b);
  });
});
