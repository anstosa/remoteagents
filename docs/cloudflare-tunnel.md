# Existing Cloudflare Tunnel

Create or keep an existing HTTPS hostname and route it to `http://127.0.0.1:8787`. Set `publicOrigin` to that exact `https://host` origin. Configure the tunnel/proxy to preserve that Host and the browser HTTPS Origin. Do **not** configure the application with Cloudflare credentials and do not expose a public listener.

Example existing tunnel ingress (illustrative only):

```yaml
ingress:
  - hostname: agents.example.com
    service: http://127.0.0.1:8787
  - service: http_status:404
```

The application does not call the Cloudflare API. Its secure `__Host-rac` cookie requires HTTPS at the browser-facing origin.
