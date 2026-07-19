# Source

Both files are the **same upstream path**, at two different real commits —
a genuine before/after pair, not a synthesized diff.

| File | Upstream repo | Path | Commit (pinned) | Permalink |
|---|---|---|---|---|
| `before.yaml` | [`widdix/aws-cf-templates`](https://github.com/widdix/aws-cf-templates) | `wordpress/wordpress-ha-aurora.yaml` | `f8c402fcf44b85a9bba412660dbebbec7f022891` | https://github.com/widdix/aws-cf-templates/blob/f8c402fcf44b85a9bba412660dbebbec7f022891/wordpress/wordpress-ha-aurora.yaml |
| `after.yaml` | [`widdix/aws-cf-templates`](https://github.com/widdix/aws-cf-templates) | `wordpress/wordpress-ha-aurora.yaml` | `1a9f04f934179975a3a56c2496d2ed2b27598bd8` | https://github.com/widdix/aws-cf-templates/blob/1a9f04f934179975a3a56c2496d2ed2b27598bd8/wordpress/wordpress-ha-aurora.yaml |

Commit `1a9f04f934...` ("fix: Upgrade CloudFront TLS config to
TLSv1.2_2021", [#758](https://github.com/widdix/aws-cf-templates/pull/758))
is the direct child of `f8c402fcf4...` in this file's history — no
intervening commits touched this path. Fetched 2026-07-19. Unmodified from
upstream; `diff before.yaml after.yaml` reproduces exactly the
`MinimumProtocolVersion` change documented in `../README.md`.
