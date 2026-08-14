import { supportedIntegrationScopes, type OAuthAuthorizationServerMetadata, type OAuthProtectedResourceMetadata } from './types.js';

// join one OAuth endpoint to a validated issuer
function endpoint(issuer: string, path: string): string {
  return new URL(path, `${issuer}/`).toString();
}

// describe the MCP protected resource
export function protectedResourceMetadata(issuer: string, resource: string): OAuthProtectedResourceMetadata {
  return {
    resource,
    authorization_servers: [issuer],
    bearer_methods_supported: ['header'],
    scopes_supported: supportedIntegrationScopes,
    resource_name: 'Remote Agent Console MCP'
  };
}

// describe the OAuth 2.1 authorization server
export function authorizationServerMetadata(issuer: string): OAuthAuthorizationServerMetadata {
  return {
    issuer,
    authorization_endpoint: endpoint(issuer, 'oauth/authorize'),
    token_endpoint: endpoint(issuer, 'oauth/token'),
    registration_endpoint: endpoint(issuer, 'oauth/register'),
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: supportedIntegrationScopes
  };
}
