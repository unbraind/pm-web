# Public package and private deployment legal boundary

This document is an engineering boundary, not legal advice. The public
`@unbrained/pm-web` package cannot provide a valid legal notice, privacy notice,
cookie disclosure, or hosted-service agreement for an unknown operator. Obtain
qualified review for each real deployment.

## Public package contract

The four HTML files in `public/` are intentionally generic, disabled-by-default
legal placeholders. They explain that operator action is required but do not
identify a controller or operator and do not promise facts about a particular
service.

Public source and npm artifacts must not contain deployment-specific:

- operator names, postal addresses, personal contact details, or support inboxes;
- hosted-service domains, tenant identifiers, internal hosts, or network layout;
- jurisdiction-specific statutes, regulators, governing law, or contractual terms;
- log contents, retention/deletion schedules, backup policy, or data locations;
- processors, subprocessors, identity providers, recipients, or transfer claims;
- secrets, tokens, credentials, database contents, user data, production logs,
  backups, exports, screenshots, fixtures derived from production, or agreements.

Descriptions of package capabilities may remain generic. They must not imply
that an optional integration or deployment-specific data flow is enabled on a
hosted service.

## Private legal-page overlay

Set `PM_WEB_LEGAL_DIR` to an absolute path owned by the deployment. That
directory must contain exactly named, operator-reviewed versions of all four
served pages:

```text
/srv/example-private/legal/
├── legal-notice.html
├── privacy-policy.html
├── terms.html
└── cookie-settings.html
```

The server validates the directory during application creation. The path must
resolve to a readable directory; all four entries must be real regular files;
file symlinks and paths escaping the directory are rejected. Missing or invalid
content stops startup instead of silently mixing private notices with public
package templates. The canonical routes are served with `Cache-Control:
no-store`.

Mount the directory read-only in a container and set the variable only in the
private deployment configuration, for example:

```yaml
services:
  web:
    environment:
      PM_WEB_LEGAL_DIR: /run/pm-web-legal
    volumes:
      - ./private/legal:/run/pm-web-legal:ro
```

The example names are generic. Do not copy real operator information into this
repository, examples, tests, issue text, pm items, build logs, or package files.

## Deployment review checklist

Before launch and after every material configuration change, inventory and have
the deployment notices reviewed for:

- operator/controller and a monitored contact channel;
- account, project, collaboration, sharing, and administrator data;
- password and enabled federated identity flows;
- session cookies, temporary login-flow cookies, browser storage, and PWA state;
- enabled Git hosting, graph, search, email, analytics, embed, proxy, security,
  observability, storage, and backup services;
- purposes, legal bases where applicable, recipients, processors/subprocessors,
  transfers, data locations, retention, deletion, export, and user rights;
- security controls, incident contacts, service availability, acceptable use,
  payment, termination, liability, and governing terms where applicable.

Verify the deployed pages themselves, not only the source files. A reverse
proxy, identity provider, CDN, or observability layer can add data flows that
the base package cannot detect.

## Contributor and release checks

For every legal-page or packaging change:

1. Keep the bundled pages visibly marked with `data-package-legal-template`.
2. Run `npm test`, `npm run typecheck`, and `npm run build`.
3. Run `npm run pack:dry-run` and inspect the publish list.
4. Search the publishable files for hosted domains, personal contacts,
   credentials, jurisdiction-specific claims, and production-derived data.
5. Keep deployment overlays and operational records in their private repository;
   do not add that repository as package content, a fixture, or a build input.

Source-repository URLs in npm metadata are allowed because they identify the
public package source, not a hosted service. Placeholder credentials in docs
must remain unmistakably fake and must never be usable values.
