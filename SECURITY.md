# Security policy

## Supported code

Security fixes target the current `main` branch. This template does not currently publish a maintained multi-version release line, so older commits and downstream forks are not guaranteed to receive backports.

## Reporting a vulnerability

Please do not report vulnerabilities, leaked credentials, exploit details, or sensitive reproduction data in a public issue, pull request, discussion, or commit.

Use GitHub's private vulnerability reporting / security advisory flow for this repository when it is available. Include enough information to reproduce and assess the issue safely:

- affected component or path;
- impact and realistic attack preconditions;
- minimal reproduction steps or proof of concept;
- affected versions or commits if known;
- suggested remediation, if you have one.

Avoid including real production credentials, personal data, or unrelated secrets in the report. Redact tokens and use synthetic test data whenever possible.

If GitHub's private reporting option is not available, do not publish the vulnerability details. Use the maintainer's GitHub profile contact methods to request a private reporting channel; a public issue, if absolutely necessary, should contain only a request for private contact and no technical exploit details.

## Handling reports

The maintainer will assess reports on a best-effort basis, confirm whether the issue is in scope, and coordinate remediation and disclosure when appropriate. Please allow time for a fix to be prepared and distributed before public disclosure.

## Security-sensitive areas

Changes touching the following areas deserve explicit security review:

- authentication, authorization, principals, roles, scopes, and tenant boundaries;
- request parsing, URL construction, outbound HTTP, redirects, and SSRF controls;
- secrets, environment variables, structured logging, trace attributes, and error responses;
- PostgreSQL queries, migrations, transaction boundaries, and database credentials;
- dependency, lockfile, CI, GitHub Actions, Renovate, and supply-chain configuration;
- telemetry/export configuration where request data or credentials could be exposed.

Never intentionally log or export authorization headers, cookies, passwords, API keys, raw database bind values, or other secrets.
