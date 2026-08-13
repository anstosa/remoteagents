# Existing Cloudflare Tunnel

Create or keep existing HTTPS hostnames for the console and configured project previews. Route both the console and project hostnames to `http://127.0.0.1:8787`, and preserve each browser-facing Host header. The console proxies configured project hosts to their fixed loopback ports and injects the navigation bridge used by its browser toolbar. Set `publicOrigin` to the console's exact `https://host` origin. Do **not** configure the application with Cloudflare credentials and do not expose a public listener.

Example existing tunnel ingress (illustrative only):

```yaml
ingress:
  - hostname: my-project.example.com
    service: http://127.0.0.1:8787
    originRequest:
      httpHostHeader: my-project.example.com
  - hostname: agents.example.com
    service: http://127.0.0.1:8787
  - service: http_status:404
```

The application does not call the Cloudflare API. Its secure `__Host-rac` cookie requires HTTPS at the browser-facing origin.
