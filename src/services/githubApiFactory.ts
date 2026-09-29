import { getEgressBaseUrl } from './egressAdapter';
import { GitHubApiService } from './githubApi';
import { GitHubListsApiService } from './githubListsApi';
import { shouldBypassBackend } from './routeMode';

/**
 * 为新建的 GitHub service 附加 egress 代理地址。
 *
 * 与多平台架构的关系：GitHub 出网必须经 Vercel Function（魔搭出口在阿里云
 * 华北 2，到 api.github.com 可达性不稳定），因此这里的 URL 来源是
 * `getEgressBaseUrl()`（默认与静态前端同源），而**不是**数据后端地址。
 *
 * 鉴权说明：egress 层只做同源校验（防跨站滥用），不使用 API_SECRET；GitHub
 * token 由请求体携带。因此这里刻意**不**注入 `backendApiSecret`——避免把魔搭
 * 的数据后端密钥泄露给 Vercel 侧日志。
 *
 * 每个 service 在构造时读取一次 routeMode 与 egress 地址；切换 routeMode 后
 * 已存在的 service 不会热重路由，新建的 service 才会按当前偏好决定。
 */
function attachEgressIfAvailable(api: GitHubApiService | GitHubListsApiService): void {
  const egressUrl = getEgressBaseUrl();
  // 上游测试用局部替身 mock 掉服务构造器（只实现被测方法），替身上没有
  // setBackendUrl。真实 service 始终具备该方法，因此这里的存在性判断
  // 不会改变生产路径，只保证「代理不可用时 attach 是空操作」这一语义。
  if (egressUrl && !shouldBypassBackend() && typeof api.setBackendUrl === 'function') {
    api.setBackendUrl(egressUrl);
  }
}

export interface CreateGitHubApiServiceOptions {
  /**
   * 即使 egress 层可用也直连 api.github.com。
   * 用于"身兼两职"的取数助手：在 browser 模式/无后端时是主路径，
   * 在代理请求失败后又是兜底路径——兜底再走刚失败的代理会失去意义
   * （与 githubListsApi 的 sticky 直连回退惯例一致）。
   */
  direct?: boolean;
}

export function createGitHubApiService(
  token: string,
  options: CreateGitHubApiServiceOptions = {},
): GitHubApiService {
  const api = new GitHubApiService(token);
  if (!options.direct) attachEgressIfAvailable(api);
  return api;
}

export function createGitHubListsApiService(token: string): GitHubListsApiService {
  const api = new GitHubListsApiService(token);
  attachEgressIfAvailable(api);
  return api;
}
