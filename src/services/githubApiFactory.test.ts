import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteMode } from '../types';

const mocks = vi.hoisted(() => ({
  setBackendUrl: vi.fn(),
  setBackendAuthToken: vi.fn(),
  egressBaseUrl: vi.fn<() => string | null>(() => null),
  routeMode: 'auto' as RouteMode,
}));

vi.mock('./githubApi', () => ({
  GitHubApiService: class {
    setBackendUrl = mocks.setBackendUrl;
    setBackendAuthToken = mocks.setBackendAuthToken;
  },
}));

vi.mock('./githubListsApi', () => ({
  GitHubListsApiService: class {
    setBackendUrl = mocks.setBackendUrl;
    setBackendAuthToken = mocks.setBackendAuthToken;
  },
}));

vi.mock('./egressAdapter', () => ({
  getEgressBaseUrl: () => mocks.egressBaseUrl(),
}));

vi.mock('../store/useAppStore', () => ({
  useAppStore: {
    getState: () => ({ routeMode: mocks.routeMode, backendApiSecret: 'secret-value' }),
  },
}));

import { createGitHubApiService, createGitHubListsApiService } from './githubApiFactory';

/**
 * GitHub 出网走 egress 层（Vercel Function），不是数据后端（魔搭）。
 * 因此这里的 URL 来源是 getEgressBaseUrl()，与 backendAdapter.backendUrl 无关。
 */
describe('githubApiFactory egress routing', () => {
  beforeEach(() => {
    mocks.setBackendUrl.mockClear();
    mocks.setBackendAuthToken.mockClear();
    mocks.routeMode = 'auto';
    mocks.egressBaseUrl.mockReturnValue(null);
  });

  it('does not set egress URL when egress is unavailable (auto)', () => {
    mocks.egressBaseUrl.mockReturnValue(null);
    createGitHubApiService('token');
    expect(mocks.setBackendUrl).not.toHaveBeenCalled();
  });

  it('sets egress URL when available in auto mode', () => {
    mocks.egressBaseUrl.mockReturnValue('http://localhost/api');
    createGitHubApiService('token');
    expect(mocks.setBackendUrl).toHaveBeenCalledWith('http://localhost/api');
  });

  it('never forwards the data-backend API secret to the egress layer', () => {
    // egress 层不使用 API_SECRET 鉴权；传入该值只会把魔搭密钥泄露到 Vercel 日志。
    mocks.egressBaseUrl.mockReturnValue('http://localhost/api');
    createGitHubApiService('token');
    expect(mocks.setBackendAuthToken).not.toHaveBeenCalled();
  });

  it('skips egress URL when routeMode is browser', () => {
    mocks.routeMode = 'browser';
    mocks.egressBaseUrl.mockReturnValue('http://localhost/api');
    createGitHubApiService('token');
    expect(mocks.setBackendUrl).not.toHaveBeenCalled();
  });

  it('applies egress routing to the lists factory in auto mode', () => {
    mocks.egressBaseUrl.mockReturnValue('http://localhost/api');
    createGitHubListsApiService('token');
    expect(mocks.setBackendUrl).toHaveBeenCalledWith('http://localhost/api');
  });

  it('skips egress URL for the lists factory in browser mode', () => {
    mocks.routeMode = 'browser';
    mocks.egressBaseUrl.mockReturnValue('http://localhost/api');
    createGitHubListsApiService('token');
    expect(mocks.setBackendUrl).not.toHaveBeenCalled();
  });
});
