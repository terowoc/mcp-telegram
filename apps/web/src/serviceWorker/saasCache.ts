const PRIVATE_ROUTES = ['/api/saas', '/oauth', '/interaction', '/mcp', '/.well-known'];

export function shouldBypassSaasCache(pathname: string) {
  return PRIVATE_ROUTES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}
