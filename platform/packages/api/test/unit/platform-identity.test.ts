import { describe, expect, it } from 'vite-plus/test';
import {
  formatPlatformPageTitle,
  getPlatformPageTitle,
  platformConnectCommand,
} from '../../src/platform-identity.ts';

describe('Casimir platform identity', () => {
  it('uses Casimir titles only for the explicit brand profile', () => {
    expect(
      getPlatformPageTitle('Dashboard', {
        PLATFORM_DISPLAY_NAME: 'Casimir',
        PLATFORM_BRANDING: 'casimir',
      }),
    ).toBe('Dashboard · Casimir');
    expect(formatPlatformPageTitle('Dashboard', 'Example Platform')).toBe(
      'Dashboard · Example Platform · Void',
    );
  });
});

describe('platformConnectCommand', () => {
  it.each([
    ['https://api.example.com', "void connect 'api.example.com'"],
    ['https://api.example.com:8443', "void connect 'api.example.com:8443'"],
    ['http://localhost:8787', "void connect 'localhost:8787'"],
    ['http://127.0.0.1:8787', "void connect '127.0.0.1:8787'"],
    ['http://[::1]:8787', "void connect '[::1]:8787'"],
    ['https://localhost:8787', "void connect 'https://localhost:8787'"],
    ["https://a'b.example.com", "void connect 'a'\\''b.example.com'"],
  ])('generates a copyable command for %s', (url, command) => {
    expect(platformConnectCommand(url)).toBe(command);
  });
});
