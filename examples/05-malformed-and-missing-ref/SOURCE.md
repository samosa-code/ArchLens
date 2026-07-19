# Source

**Not copied from upstream as-is.** Both files are hand-derived from
`01-simple-lambda/template.yaml` (itself sourced from
`aws-cloudformation/aws-cloudformation-templates` @
`046f6dac619898a7b3445f94acecb1ca341a5520`, `Lambda/LambdaSample.yaml` —
see `../01-simple-lambda/SOURCE.md`), then deliberately broken:

| File | Change made from the `01-simple-lambda` base |
|---|---|
| `invalid-yaml.yaml` | Introduced inconsistent indentation under the `LambdaHandlerPath` parameter (line 14) so the file fails to parse as YAML. |
| `missing-resource-ref.yaml` | Changed `LambdaFunction.Properties.Role` from `!GetAtt LambdaRole.Arn` to `!GetAtt LambdaExecutionRole.Arn` — `LambdaExecutionRole` does not exist anywhere in the template. |

Authored 2026-07-19 specifically to exercise Sprint 1's graceful-degradation
requirements (Ticket 1.6) — no other source to cite.
