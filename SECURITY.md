# Security policy

## Supported version

Security fixes are applied to the current `main` branch. This repository does
not currently maintain separate supported release lines.

## Reporting a vulnerability

Do not open a public issue containing credentials, session material, private
prompts, terminal output, or a working exploit. Use GitHub's private
**Security advisories → Report a vulnerability** flow for this repository. If
private reporting is unavailable, open a minimal issue asking the maintainer
for a private contact channel without including sensitive details.

Include the affected revision, deployment shape, reproduction prerequisites,
impact, and any proposed mitigation. Remove real tokens, cookies, tmux paths,
hostnames, prompt contents, and repository data from the report.

## Deployment boundary

Remote Agent Console is a single-trusted-operator tool. A controlled browser
can send terminal input and execute configured commands with the privileges of
the Unix account running the server.

- Keep the application bound to loopback.
- Expose it only through HTTPS with the configured canonical Host and Origin.
- Do not publish port `8787` directly to an untrusted network.
- Use a long unique password, an independently generated session secret, and
  owner-readable configuration and persistence files.
- Treat Cloudflare Tunnel, reverse-proxy, GitHub CLI, Codex, and host tmux
  credentials as production secrets.
- Run the console under a dedicated, least-privileged account when practical.
- Review every configured worktree command and bind mount as trusted code.

The console is not designed for untrusted users, shared hosting, arbitrary
shell access, or isolation between multiple operators.
