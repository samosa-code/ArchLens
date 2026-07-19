# Source

| File | Upstream repo | Path | Commit (pinned) | Permalink |
|---|---|---|---|---|
| `template.yaml` | [`aws-cloudformation/aws-cloudformation-templates`](https://github.com/aws-cloudformation/aws-cloudformation-templates) | `ECS/FargateLaunchType/services/public-service.yaml` | `d92ae9b9a579db627c58e3c1c630440f42ca69b9` | https://github.com/aws-cloudformation/aws-cloudformation-templates/blob/d92ae9b9a579db627c58e3c1c630440f42ca69b9/ECS/FargateLaunchType/services/public-service.yaml |

Same upstream source and commit as `03-multi-stack-ecs-fargate/service-stack/template.yaml`
— copied here standalone, deliberately *without* its matching
`network-stack` file, so every `Fn::ImportValue` in it is genuinely
unresolvable. Unmodified from upstream; the "brokenness" comes from
omission, not editing.
