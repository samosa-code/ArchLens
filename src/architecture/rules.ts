/**
 * The type → architectural role table (Ticket A.2). This is DATA, not
 * logic: adding coverage means adding rows here, never editing the
 * classification pass. Transcribed from
 * `internal-docs/architecture-rules.ts` (the spec's drafted table), adapted
 * to the real types in `./types.ts` and to PO decisions 17–23; validated
 * structurally by `__test__/rules.test.ts` — the table's "compiler".
 *
 * The `connector` role is load-bearing: most real architectural edges
 * (API Gateway → Lambda, SQS → Lambda, ALB → ASG) exist in a template ONLY
 * as one of these resources. See `ARCHITECTURE-GENERATOR-SPEC.md` §1.
 */
import type { ArchLayer, TypeRule } from './types.js';

// Reusable owner lists ------------------------------------------------------

const COMPUTE_OWNERS = [
  'AWS::Lambda::Function',
  'AWS::Serverless::Function',
  'AWS::EC2::Instance',
  'AWS::ECS::Service',
  'AWS::AutoScaling::AutoScalingGroup',
  'AWS::Batch::JobDefinition',
  'AWS::AppRunner::Service',
];

const ANY_COMPONENT_OWNER = [
  ...COMPUTE_OWNERS,
  'AWS::ApiGateway::RestApi',
  'AWS::ApiGatewayV2::Api',
  'AWS::Serverless::Api',
  'AWS::ElasticLoadBalancingV2::LoadBalancer',
  'AWS::S3::Bucket',
  'AWS::DynamoDB::Table',
  'AWS::RDS::DBInstance',
  'AWS::RDS::DBCluster',
  'AWS::SQS::Queue',
  'AWS::SNS::Topic',
  'AWS::StepFunctions::StateMachine',
  // Added during Ticket A.11 (corpus validation): each of these is a real,
  // terminal component that commonly carries its own IAM role/log group/
  // alarm in the corpus, but wasn't a valid absorption target for them.
  'AWS::AmazonMQ::Broker',
  'AWS::CodePipeline::Pipeline',
  'AWS::DataPipeline::Pipeline',
  'AWS::DMS::ReplicationInstance',
  'AWS::DMS::ReplicationTask',
  'AWS::IoT::Thing',
  'AWS::IoT::TopicRule',
  'AWS::IoTAnalytics::Channel',
  'AWS::IoTAnalytics::Pipeline',
  'AWS::IoTAnalytics::Datastore',
  'AWS::IoTAnalytics::Dataset',
  'AWS::Neptune::DBInstance',
  'AWS::Neptune::DBCluster',
  'AWS::Config::ConfigurationRecorder',
  'AWS::ServiceCatalog::Portfolio',
  'AWS::CloudFormation::StackSet',
];

const NETWORK_OWNERS = ['AWS::EC2::VPC', 'AWS::EC2::Subnet'];

/** The type → role table. Keys are CloudFormation resource types; a type with no entry falls through to the structural heuristic ({@link PLUMBING_SUFFIXES}), then to the visible `kept-unknown` fallback. */
export const RULES: Record<string, TypeRule> = {
  // ===================================================================
  // CONTAINERS — boundaries, not boxes
  // ===================================================================
  'AWS::EC2::VPC': { role: 'container', layer: 'network', service: 'vpc', containerKind: 'vpc' },
  'AWS::EC2::Subnet': { role: 'container', layer: 'network', service: 'subnet', containerKind: 'subnet' },
  'AWS::ECS::Cluster': { role: 'container', layer: 'compute', service: 'ecs-cluster', containerKind: 'cluster' },
  'AWS::EKS::Cluster': { role: 'container', layer: 'compute', service: 'eks', containerKind: 'cluster' },
  'AWS::CloudFormation::Stack': { role: 'container', layer: 'unassigned', service: 'stack', containerKind: 'stack' },

  // ===================================================================
  // COMPONENTS — edge / ingress
  // ===================================================================
  'AWS::CloudFront::Distribution': { role: 'component', layer: 'edge', service: 'cloudfront' },
  'AWS::WAFv2::WebACL': { role: 'component', layer: 'edge', service: 'waf' },
  'AWS::WAF::WebACL': { role: 'component', layer: 'edge', service: 'waf' },
  'AWS::GlobalAccelerator::Accelerator': { role: 'component', layer: 'edge', service: 'global-accelerator' },

  // ===================================================================
  // COMPONENTS — presentation
  // ===================================================================
  // NOTE: S3 defaults to 'data'. Promotion to 'presentation' when the
  // bucket has WebsiteConfiguration or is a CloudFront origin is a runtime
  // refinement (per PO Question 18), not a table entry.
  'AWS::Amplify::App': { role: 'component', layer: 'presentation', service: 'amplify' },

  // ===================================================================
  // COMPONENTS — auth
  // ===================================================================
  'AWS::Cognito::UserPool': { role: 'component', layer: 'auth', service: 'cognito' },
  'AWS::Cognito::IdentityPool': { role: 'component', layer: 'auth', service: 'cognito' },
  'AWS::DirectoryService::MicrosoftAD': { role: 'component', layer: 'auth', service: 'directory-service' },

  // ===================================================================
  // COMPONENTS — api / routing
  // ===================================================================
  'AWS::ApiGateway::RestApi': { role: 'component', layer: 'api', service: 'apigateway' },
  'AWS::ApiGatewayV2::Api': { role: 'component', layer: 'api', service: 'apigateway' },
  'AWS::Serverless::Api': { role: 'component', layer: 'api', service: 'apigateway' },
  'AWS::Serverless::HttpApi': { role: 'component', layer: 'api', service: 'apigateway' },
  'AWS::AppSync::GraphQLApi': { role: 'component', layer: 'api', service: 'appsync' },
  'AWS::ElasticLoadBalancingV2::LoadBalancer': { role: 'component', layer: 'api', service: 'elb' },
  'AWS::ElasticLoadBalancing::LoadBalancer': { role: 'component', layer: 'api', service: 'elb' },

  // ===================================================================
  // COMPONENTS — compute
  // ===================================================================
  'AWS::Lambda::Function': { role: 'component', layer: 'compute', service: 'lambda' },
  'AWS::Serverless::Function': { role: 'component', layer: 'compute', service: 'lambda' },
  'AWS::EC2::Instance': { role: 'component', layer: 'compute', service: 'ec2' },
  'AWS::AutoScaling::AutoScalingGroup': { role: 'component', layer: 'compute', service: 'asg' },
  'AWS::ECS::Service': { role: 'component', layer: 'compute', service: 'ecs' },
  'AWS::Batch::JobDefinition': { role: 'component', layer: 'compute', service: 'batch' },
  'AWS::Serverless::StateMachine': { role: 'component', layer: 'integration', service: 'stepfunctions' },
  'AWS::AppRunner::Service': { role: 'component', layer: 'compute', service: 'apprunner' },
  'AWS::EMR::Cluster': { role: 'component', layer: 'compute', service: 'emr' },

  // ===================================================================
  // COMPONENTS — integration / messaging
  // ===================================================================
  'AWS::SQS::Queue': { role: 'component', layer: 'integration', service: 'sqs' },
  'AWS::SNS::Topic': { role: 'component', layer: 'integration', service: 'sns' },
  'AWS::Events::EventBus': { role: 'component', layer: 'integration', service: 'eventbridge' },
  'AWS::Events::Rule': { role: 'component', layer: 'integration', service: 'eventbridge' },
  'AWS::Kinesis::Stream': { role: 'component', layer: 'integration', service: 'kinesis' },
  'AWS::KinesisFirehose::DeliveryStream': { role: 'component', layer: 'integration', service: 'firehose' },
  'AWS::StepFunctions::StateMachine': { role: 'component', layer: 'integration', service: 'stepfunctions' },
  'AWS::MSK::Cluster': { role: 'component', layer: 'integration', service: 'msk' },
  'AWS::AmazonMQ::Broker': { role: 'component', layer: 'integration', service: 'amazonmq' },
  'AWS::CodePipeline::Pipeline': { role: 'component', layer: 'integration', service: 'codepipeline' },
  'AWS::DataPipeline::Pipeline': { role: 'component', layer: 'integration', service: 'datapipeline' },
  'AWS::SSM::Document': { role: 'component', layer: 'integration', service: 'ssm' },
  // DMS: the instance runs the migration; the task is a distinct, visible
  // migration job definition on it (not absorbed — a human wants to see
  // "there's a replication task running here", the same reasoning that
  // keeps RDS::DBInstance and RDS::DBCluster both visible).
  'AWS::DMS::ReplicationInstance': { role: 'component', layer: 'integration', service: 'dms' },
  'AWS::DMS::ReplicationTask': { role: 'component', layer: 'integration', service: 'dms' },
  // IoT: Thing is the device/fleet concept; TopicRule is kept as its own
  // visible box rather than modeled as a connector (it fans out to
  // arbitrary action targets, not a single clean source/target pair).
  'AWS::IoT::Thing': { role: 'component', layer: 'integration', service: 'iot' },
  'AWS::IoT::TopicRule': { role: 'component', layer: 'integration', service: 'iot' },
  // IoT Analytics: Channel -> Pipeline -> Datastore -> Dataset is the
  // actual product, not plumbing — all four stay visible.
  'AWS::IoTAnalytics::Channel': { role: 'component', layer: 'integration', service: 'iotanalytics' },
  'AWS::IoTAnalytics::Pipeline': { role: 'component', layer: 'integration', service: 'iotanalytics' },

  // ===================================================================
  // COMPONENTS — data
  // ===================================================================
  'AWS::DynamoDB::Table': { role: 'component', layer: 'data', service: 'dynamodb' },
  'AWS::DynamoDB::GlobalTable': { role: 'component', layer: 'data', service: 'dynamodb' },
  'AWS::RDS::DBInstance': { role: 'component', layer: 'data', service: 'rds' },
  'AWS::RDS::DBCluster': { role: 'component', layer: 'data', service: 'rds' },
  'AWS::S3::Bucket': { role: 'component', layer: 'data', service: 's3' },
  'AWS::ElastiCache::CacheCluster': { role: 'component', layer: 'data', service: 'elasticache' },
  'AWS::ElastiCache::ReplicationGroup': { role: 'component', layer: 'data', service: 'elasticache' },
  'AWS::OpenSearchService::Domain': { role: 'component', layer: 'data', service: 'opensearch' },
  'AWS::Elasticsearch::Domain': { role: 'component', layer: 'data', service: 'opensearch' },
  'AWS::Redshift::Cluster': { role: 'component', layer: 'data', service: 'redshift' },
  'AWS::EFS::FileSystem': { role: 'component', layer: 'data', service: 'efs' },
  'AWS::Neptune::DBCluster': { role: 'component', layer: 'data', service: 'neptune' },
  'AWS::Neptune::DBInstance': { role: 'component', layer: 'data', service: 'neptune' },
  'AWS::DocDB::DBCluster': { role: 'component', layer: 'data', service: 'documentdb' },
  'AWS::SecretsManager::Secret': { role: 'component', layer: 'data', service: 'secretsmanager' },
  'AWS::KMS::Key': { role: 'component', layer: 'data', service: 'kms' },
  'AWS::IoTAnalytics::Datastore': { role: 'component', layer: 'data', service: 'iotanalytics' },
  'AWS::IoTAnalytics::Dataset': { role: 'component', layer: 'data', service: 'iotanalytics' },

  // ===================================================================
  // COMPONENTS — monitoring (always visible per PO Question 17;
  // hidden only by the explicit --hide-monitoring opt-out)
  // ===================================================================
  'AWS::CloudWatch::Dashboard': { role: 'component', layer: 'monitoring', service: 'cloudwatch' },
  'AWS::Config::ConfigurationRecorder': { role: 'component', layer: 'monitoring', service: 'config' },

  // ===================================================================
  // COMPONENTS — unassigned (governance/deployment tooling with no clean
  // architectural layer — still real, still worth a box, never guessed
  // into a layer that doesn't fit)
  // ===================================================================
  'AWS::CloudFormation::StackSet': { role: 'component', layer: 'unassigned', service: 'cloudformation' },
  'AWS::ServiceCatalog::Portfolio': { role: 'component', layer: 'unassigned', service: 'servicecatalog' },

  // ===================================================================
  // CONNECTORS — hidden, but emit the edges that carry the architecture
  // ===================================================================

  // API Gateway / EventBridge / S3 -> Lambda. Without this rule the single
  // most important edge in a serverless diagram does not exist. `delivery`
  // omitted: it depends on the invoking principal (API Gateway = sync;
  // S3/SNS/Events = async), inferred at extraction time (Ticket A.6).
  'AWS::Lambda::Permission': {
    role: 'connector',
    group: 'permissions',
    absorbInto: ['AWS::Lambda::Function', 'AWS::Serverless::Function'],
    connector: {
      source: { from: 'prop', path: 'SourceArn' }, // fall back to Principal
      target: { from: 'prop', path: 'FunctionName' },
      kind: 'invocation',
      label: 'invokes',
    },
  },

  // SQS / Kinesis / DynamoDB Streams -> Lambda: poll-based, always async.
  'AWS::Lambda::EventSourceMapping': {
    role: 'connector',
    group: 'plumbing',
    absorbInto: ['AWS::Lambda::Function', 'AWS::Serverless::Function'],
    connector: {
      source: { from: 'prop', path: 'EventSourceArn' },
      target: { from: 'prop', path: 'FunctionName' },
      kind: 'invocation',
      label: 'triggers',
      delivery: 'async',
    },
  },

  // The integration URI is the other half of API Gateway -> Lambda.
  'AWS::ApiGateway::Method': {
    role: 'connector',
    group: 'plumbing',
    absorbInto: ['AWS::ApiGateway::RestApi'],
    connector: {
      source: { from: 'owner' },
      target: { from: 'prop', path: 'Integration.Uri' },
      kind: 'invocation',
      label: 'routes to',
      delivery: 'sync',
    },
  },
  'AWS::ApiGatewayV2::Integration': {
    role: 'connector',
    group: 'plumbing',
    absorbInto: ['AWS::ApiGatewayV2::Api'],
    connector: {
      source: { from: 'owner' },
      target: { from: 'prop', path: 'IntegrationUri' },
      kind: 'invocation',
      label: 'routes to',
      delivery: 'sync',
    },
  },

  // API Gateway -> Cognito
  'AWS::ApiGateway::Authorizer': {
    role: 'connector',
    group: 'permissions',
    absorbInto: ['AWS::ApiGateway::RestApi'],
    connector: {
      source: { from: 'owner' },
      target: { from: 'prop', path: 'ProviderARNs' },
      kind: 'invocation',
      label: 'authenticates via',
      delivery: 'sync',
      fanOut: 'ProviderARNs',
    },
  },

  // ALB -> target group -> ASG/ECS/instances
  'AWS::ElasticLoadBalancingV2::Listener': {
    role: 'connector',
    group: 'plumbing',
    absorbInto: ['AWS::ElasticLoadBalancingV2::LoadBalancer'],
    connector: {
      source: { from: 'owner' },
      target: { from: 'prop', path: 'DefaultActions.TargetGroupArn' },
      kind: 'invocation',
      label: 'forwards to',
      delivery: 'sync',
      fanOut: 'DefaultActions',
    },
  },
  // absorbInto goes through the Listener first: in real multi-stack
  // fixtures (examples/03) the rule's only path to its LB is via the
  // listener it attaches to — a direct LB neighbour rarely exists.
  'AWS::ElasticLoadBalancingV2::ListenerRule': {
    role: 'connector',
    group: 'plumbing',
    absorbInto: ['AWS::ElasticLoadBalancingV2::Listener', 'AWS::ElasticLoadBalancingV2::LoadBalancer'],
    connector: {
      source: { from: 'owner' },
      target: { from: 'prop', path: 'Actions.TargetGroupArn' },
      kind: 'invocation',
      label: 'forwards to',
      delivery: 'sync',
      fanOut: 'Actions',
    },
  },
  // TargetGroup is a pass-through hop: absorbed, but its Targets still
  // matter. It absorbs into the TARGET side (the service/ASG/instance the
  // traffic lands on), deliberately not the LB: a listener's forward edge
  // resolves through the TG to its owner, so LB → TG → Service becomes
  // LB → Service — absorbing into the LB would collapse that to a
  // self-edge and delete the chain's whole point. LB stays as a last
  // resort for a TG with no attached target at all.
  'AWS::ElasticLoadBalancingV2::TargetGroup': {
    role: 'connector',
    group: 'plumbing',
    absorbInto: ['AWS::ECS::Service', 'AWS::AutoScaling::AutoScalingGroup', 'AWS::EC2::Instance', 'AWS::ElasticLoadBalancingV2::LoadBalancer'],
    connector: {
      source: { from: 'owner' },
      target: { from: 'prop', path: 'Targets.Id' },
      kind: 'invocation',
      label: 'forwards to',
      delivery: 'sync',
      fanOut: 'Targets',
    },
  },

  // Resource policies: grant edges (only when the ARN resolves to a
  // component). Bucket access is a direct API call (sync); queue/topic
  // policies grant message delivery (async).
  'AWS::S3::BucketPolicy': {
    role: 'connector',
    group: 'permissions',
    absorbInto: ['AWS::S3::Bucket'],
    connector: {
      source: { from: 'principal', path: 'PolicyDocument.Statement.Principal' },
      target: { from: 'owner' },
      kind: 'dataAccess',
      label: 'accesses',
      delivery: 'sync',
    },
  },
  'AWS::SQS::QueuePolicy': {
    role: 'connector',
    group: 'permissions',
    absorbInto: ['AWS::SQS::Queue'],
    connector: {
      source: { from: 'principal', path: 'PolicyDocument.Statement.Principal' },
      target: { from: 'owner' },
      kind: 'dataAccess',
      label: 'publishes to',
      delivery: 'async',
    },
  },
  'AWS::SNS::TopicPolicy': {
    role: 'connector',
    group: 'permissions',
    absorbInto: ['AWS::SNS::Topic'],
    connector: {
      source: { from: 'principal', path: 'PolicyDocument.Statement.Principal' },
      target: { from: 'owner' },
      kind: 'dataAccess',
      label: 'publishes to',
      delivery: 'async',
    },
  },

  // SNS -> SQS / Lambda / HTTP
  'AWS::SNS::Subscription': {
    role: 'connector',
    group: 'plumbing',
    absorbInto: ['AWS::SNS::Topic'],
    connector: {
      source: { from: 'prop', path: 'TopicArn' },
      target: { from: 'prop', path: 'Endpoint' },
      kind: 'invocation',
      label: 'notifies',
      delivery: 'async',
    },
  },

  // IAM data-access grants. HIGH VALUE, HIGH RISK: a wildcard Resource
  // would connect one compute node to everything. Per PO Question 19: emit
  // ONLY when the statement's Resource resolves to a specific ARN matching
  // a known component — never on '*'. The policy is still absorbed and
  // visible in the owner's detail panel either way.
  'AWS::IAM::Policy': {
    role: 'connector',
    group: 'permissions',
    absorbInto: [...COMPUTE_OWNERS, 'AWS::IAM::Role'],
    connector: {
      source: { from: 'owner' },
      target: { from: 'prop', path: 'PolicyDocument.Statement.Resource' },
      kind: 'dataAccess',
      label: 'reads/writes',
      delivery: 'sync',
      fanOut: 'PolicyDocument.Statement',
    },
  },
  'AWS::IAM::ManagedPolicy': {
    role: 'connector',
    group: 'permissions',
    absorbInto: [...COMPUTE_OWNERS, 'AWS::IAM::Role'],
    connector: {
      source: { from: 'owner' },
      target: { from: 'prop', path: 'PolicyDocument.Statement.Resource' },
      kind: 'dataAccess',
      label: 'reads/writes',
      delivery: 'sync',
      fanOut: 'PolicyDocument.Statement',
    },
  },

  // Network reachability. 0.0.0.0/0 ingress is what creates the synthetic
  // Internet node and answers "how does traffic enter the system".
  // `delivery` omitted: network edges are reachability, not calls — styled
  // by their `network` kind, not by sync/async.
  'AWS::EC2::SecurityGroupIngress': {
    role: 'connector',
    group: 'networking',
    absorbInto: ['AWS::EC2::SecurityGroup'],
    connector: {
      source: { from: 'prop', path: 'SourceSecurityGroupId' }, // or CidrIp -> internet
      target: { from: 'owner' },
      kind: 'network',
      label: 'can reach',
    },
  },
  'AWS::EC2::SecurityGroupEgress': {
    role: 'connector',
    group: 'networking',
    absorbInto: ['AWS::EC2::SecurityGroup'],
    connector: {
      source: { from: 'owner' },
      target: { from: 'prop', path: 'DestinationSecurityGroupId' },
      kind: 'network',
      label: 'can reach',
    },
  },

  // ===================================================================
  // DETAILS — permissions
  // ===================================================================
  'AWS::IAM::Role': { role: 'detail', group: 'permissions', absorbInto: ANY_COMPONENT_OWNER },
  'AWS::IAM::InstanceProfile': { role: 'detail', group: 'permissions', absorbInto: ['AWS::IAM::Role', 'AWS::EC2::Instance'] },
  'AWS::IAM::User': { role: 'detail', group: 'permissions', absorbInto: ANY_COMPONENT_OWNER },
  'AWS::IAM::Group': { role: 'detail', group: 'permissions', absorbInto: ANY_COMPONENT_OWNER },
  'AWS::IAM::RolePolicy': { role: 'detail', group: 'permissions', absorbInto: ['AWS::IAM::Role'] },
  'AWS::KMS::Alias': { role: 'detail', group: 'permissions', absorbInto: ['AWS::KMS::Key'] },
  'AWS::Cognito::UserPoolClient': { role: 'detail', group: 'permissions', absorbInto: ['AWS::Cognito::UserPool'] },
  'AWS::CloudFront::OriginAccessControl': { role: 'detail', group: 'permissions', absorbInto: ['AWS::CloudFront::Distribution'] },
  'AWS::ServiceCatalog::PortfolioShare': { role: 'detail', group: 'permissions', absorbInto: ['AWS::ServiceCatalog::Portfolio'] },
  // IoT device identity/authorization plumbing around a Thing.
  'AWS::IoT::Policy': { role: 'detail', group: 'permissions', absorbInto: ['AWS::IoT::Thing'] },
  'AWS::IoT::PolicyPrincipalAttachment': { role: 'detail', group: 'permissions', absorbInto: ['AWS::IoT::Policy', 'AWS::IoT::Thing'] },
  'AWS::IoT::ThingPrincipalAttachment': { role: 'detail', group: 'permissions', absorbInto: ['AWS::IoT::Thing'] },

  // ===================================================================
  // DETAILS — observability
  // ===================================================================
  'AWS::Logs::LogGroup': {
    role: 'detail',
    group: 'observability',
    absorbInto: ANY_COMPONENT_OWNER,
    // Log groups frequently have NO edge to their owner; matched by convention.
    ownerByNamePattern: '/aws/{service}/{name}',
  },
  'AWS::Logs::LogStream': { role: 'detail', group: 'observability', absorbInto: ['AWS::Logs::LogGroup'] },
  'AWS::Logs::SubscriptionFilter': { role: 'detail', group: 'observability', absorbInto: ['AWS::Logs::LogGroup'] },
  'AWS::Logs::MetricFilter': { role: 'detail', group: 'observability', absorbInto: ['AWS::Logs::LogGroup'] },
  'AWS::CloudWatch::Alarm': { role: 'detail', group: 'observability', absorbInto: ANY_COMPONENT_OWNER },
  'AWS::EC2::FlowLog': { role: 'detail', group: 'observability', absorbInto: NETWORK_OWNERS },
  // AWS Config compliance plumbing — many rules typically hang off one
  // recorder; treated like IAM::Policy's many-per-role pattern, not as
  // individually visible boxes.
  'AWS::Config::ConfigRule': { role: 'detail', group: 'observability', absorbInto: ['AWS::Config::ConfigurationRecorder'] },
  'AWS::Config::DeliveryChannel': { role: 'detail', group: 'observability', absorbInto: ['AWS::Config::ConfigurationRecorder'] },

  // ===================================================================
  // DETAILS — lifecycle
  // ===================================================================
  'AWS::Lambda::Version': { role: 'detail', group: 'lifecycle', absorbInto: ['AWS::Lambda::Function', 'AWS::Serverless::Function'] },
  'AWS::Lambda::Alias': { role: 'detail', group: 'lifecycle', absorbInto: ['AWS::Lambda::Function', 'AWS::Serverless::Function'] },
  'AWS::Lambda::LayerVersion': { role: 'detail', group: 'lifecycle', absorbInto: ['AWS::Lambda::Function', 'AWS::Serverless::Function'] },
  'AWS::Lambda::EventInvokeConfig': { role: 'detail', group: 'lifecycle', absorbInto: ['AWS::Lambda::Function', 'AWS::Serverless::Function'] },
  'AWS::ApiGateway::Deployment': { role: 'detail', group: 'lifecycle', absorbInto: ['AWS::ApiGateway::RestApi'] },
  'AWS::ApiGateway::Stage': { role: 'detail', group: 'lifecycle', absorbInto: ['AWS::ApiGateway::RestApi'] },
  'AWS::ApiGatewayV2::Stage': { role: 'detail', group: 'lifecycle', absorbInto: ['AWS::ApiGatewayV2::Api'] },
  'AWS::ApiGatewayV2::Deployment': { role: 'detail', group: 'lifecycle', absorbInto: ['AWS::ApiGatewayV2::Api'] },

  // ===================================================================
  // DETAILS — plumbing
  // ===================================================================
  'AWS::ApiGateway::Resource': { role: 'detail', group: 'plumbing', absorbInto: ['AWS::ApiGateway::RestApi'] },
  'AWS::ApiGateway::Model': { role: 'detail', group: 'plumbing', absorbInto: ['AWS::ApiGateway::RestApi'] },
  'AWS::ApiGateway::RequestValidator': { role: 'detail', group: 'plumbing', absorbInto: ['AWS::ApiGateway::RestApi'] },
  'AWS::ApiGateway::UsagePlan': { role: 'detail', group: 'plumbing', absorbInto: ['AWS::ApiGateway::RestApi'] },
  'AWS::ApiGateway::ApiKey': { role: 'detail', group: 'plumbing', absorbInto: ['AWS::ApiGateway::RestApi'] },
  'AWS::ApiGateway::Account': { role: 'detail', group: 'plumbing', absorbInto: ['AWS::ApiGateway::RestApi'] },
  'AWS::ApiGatewayV2::Route': { role: 'detail', group: 'plumbing', absorbInto: ['AWS::ApiGatewayV2::Api'] },
  'AWS::ECS::TaskDefinition': { role: 'detail', group: 'plumbing', absorbInto: ['AWS::ECS::Service'] },
  'AWS::AutoScaling::LaunchConfiguration': { role: 'detail', group: 'plumbing', absorbInto: ['AWS::AutoScaling::AutoScalingGroup'] },
  'AWS::EC2::LaunchTemplate': { role: 'detail', group: 'plumbing', absorbInto: ['AWS::AutoScaling::AutoScalingGroup', 'AWS::EC2::Instance'] },
  'AWS::AutoScaling::ScalingPolicy': { role: 'detail', group: 'plumbing', absorbInto: ['AWS::AutoScaling::AutoScalingGroup'] },
  'AWS::ApplicationAutoScaling::ScalableTarget': { role: 'detail', group: 'plumbing', absorbInto: ANY_COMPONENT_OWNER },
  'AWS::ApplicationAutoScaling::ScalingPolicy': { role: 'detail', group: 'plumbing', absorbInto: ANY_COMPONENT_OWNER },
  'AWS::RDS::DBSubnetGroup': { role: 'detail', group: 'networking', absorbInto: ['AWS::RDS::DBInstance', 'AWS::RDS::DBCluster'] },
  'AWS::RDS::DBParameterGroup': { role: 'detail', group: 'plumbing', absorbInto: ['AWS::RDS::DBInstance', 'AWS::RDS::DBCluster'] },
  'AWS::ElastiCache::SubnetGroup': { role: 'detail', group: 'networking', absorbInto: ['AWS::ElastiCache::CacheCluster', 'AWS::ElastiCache::ReplicationGroup'] },
  'AWS::ElastiCache::ParameterGroup': { role: 'detail', group: 'plumbing', absorbInto: ['AWS::ElastiCache::CacheCluster', 'AWS::ElastiCache::ReplicationGroup'] },
  'AWS::EFS::MountTarget': { role: 'detail', group: 'networking', absorbInto: ['AWS::EFS::FileSystem'] },
  'AWS::EFS::AccessPoint': { role: 'detail', group: 'plumbing', absorbInto: ['AWS::EFS::FileSystem'] },
  'AWS::SecretsManager::SecretTargetAttachment': { role: 'detail', group: 'plumbing', absorbInto: ['AWS::SecretsManager::Secret'] },
  'AWS::CloudFormation::WaitCondition': { role: 'detail', group: 'plumbing', absorbInto: ANY_COMPONENT_OWNER },
  'AWS::CloudFormation::WaitConditionHandle': { role: 'detail', group: 'plumbing', absorbInto: ANY_COMPONENT_OWNER },
  // A macro's only architectural meaning is "there's a Lambda backing this
  // transform" — nobody diagrams the macro registration as its own box.
  'AWS::CloudFormation::Macro': { role: 'detail', group: 'plumbing', absorbInto: ['AWS::Lambda::Function', 'AWS::Serverless::Function'] },
  'AWS::Cognito::UserPoolDomain': { role: 'detail', group: 'plumbing', absorbInto: ['AWS::Cognito::UserPool'] },
  'AWS::ServiceCatalog::TagOption': { role: 'detail', group: 'plumbing', absorbInto: ['AWS::ServiceCatalog::Portfolio'] },
  'AWS::EC2::Volume': { role: 'detail', group: 'plumbing', absorbInto: ['AWS::EC2::Instance'] },
  // A container-role absorbInto target (EKS::Cluster is a container, not a
  // component) — the same pattern SecurityGroup already uses for
  // NETWORK_OWNERS (VPC/Subnet, also containers).
  'AWS::EKS::Nodegroup': { role: 'detail', group: 'plumbing', absorbInto: ['AWS::EKS::Cluster'] },
  'AWS::DMS::Endpoint': { role: 'detail', group: 'plumbing', absorbInto: ['AWS::DMS::ReplicationTask', 'AWS::DMS::ReplicationInstance'] },
  'AWS::Neptune::DBClusterParameterGroup': { role: 'detail', group: 'plumbing', absorbInto: ['AWS::Neptune::DBCluster'] },
  'AWS::Neptune::DBParameterGroup': { role: 'detail', group: 'plumbing', absorbInto: ['AWS::Neptune::DBInstance', 'AWS::Neptune::DBCluster'] },

  // ===================================================================
  // DETAILS — networking (absorbed into the VPC/Subnet container)
  // ===================================================================
  'AWS::EC2::RouteTable': { role: 'detail', group: 'networking', absorbInto: NETWORK_OWNERS },
  'AWS::EC2::Route': { role: 'detail', group: 'networking', absorbInto: ['AWS::EC2::RouteTable', ...NETWORK_OWNERS] },
  'AWS::EC2::SubnetRouteTableAssociation': { role: 'detail', group: 'networking', absorbInto: ['AWS::EC2::RouteTable', ...NETWORK_OWNERS] },
  'AWS::EC2::NetworkAcl': { role: 'detail', group: 'networking', absorbInto: NETWORK_OWNERS },
  'AWS::EC2::NetworkAclEntry': { role: 'detail', group: 'networking', absorbInto: ['AWS::EC2::NetworkAcl', ...NETWORK_OWNERS] },
  'AWS::EC2::SubnetNetworkAclAssociation': { role: 'detail', group: 'networking', absorbInto: ['AWS::EC2::NetworkAcl', ...NETWORK_OWNERS] },
  'AWS::EC2::InternetGateway': { role: 'detail', group: 'networking', absorbInto: NETWORK_OWNERS },
  'AWS::EC2::VPCGatewayAttachment': { role: 'detail', group: 'networking', absorbInto: NETWORK_OWNERS },
  'AWS::EC2::EIP': { role: 'detail', group: 'networking', absorbInto: ['AWS::EC2::NatGateway', 'AWS::EC2::Instance', ...NETWORK_OWNERS] },
  'AWS::EC2::EIPAssociation': { role: 'detail', group: 'networking', absorbInto: ['AWS::EC2::EIP', ...NETWORK_OWNERS] },
  'AWS::EC2::VPCEndpoint': { role: 'detail', group: 'networking', absorbInto: NETWORK_OWNERS },
  'AWS::EC2::VPCPeeringConnection': { role: 'detail', group: 'networking', absorbInto: NETWORK_OWNERS },
  'AWS::EC2::NetworkInterface': { role: 'detail', group: 'networking', absorbInto: ['AWS::EC2::Instance', ...NETWORK_OWNERS] },
  'AWS::EC2::DHCPOptions': { role: 'detail', group: 'networking', absorbInto: NETWORK_OWNERS },
  'AWS::EC2::VPCDHCPOptionsAssociation': { role: 'detail', group: 'networking', absorbInto: NETWORK_OWNERS },
  'AWS::EC2::SecurityGroup': { role: 'detail', group: 'networking', absorbInto: [...ANY_COMPONENT_OWNER, ...NETWORK_OWNERS] },

  // NAT Gateway: absorbed for readability, but it is one of the top cost
  // drivers in a typical VPC — its cost badge must survive onto the VPC.
  'AWS::EC2::NatGateway': {
    role: 'detail',
    group: 'networking',
    absorbInto: NETWORK_OWNERS,
    propagateBadges: true,
  },

  // Route 53 records are routing detail, not architecture — but a record
  // pointing at a CloudFront/ALB is how the system is reached.
  'AWS::Neptune::DBSubnetGroup': { role: 'detail', group: 'networking', absorbInto: ['AWS::Neptune::DBInstance', 'AWS::Neptune::DBCluster'] },
  'AWS::DMS::ReplicationSubnetGroup': { role: 'detail', group: 'networking', absorbInto: ['AWS::DMS::ReplicationInstance'] },
  'AWS::Route53::RecordSet': { role: 'detail', group: 'networking', absorbInto: ['AWS::CloudFront::Distribution', 'AWS::ElasticLoadBalancingV2::LoadBalancer', 'AWS::ApiGateway::RestApi'] },
  'AWS::Route53::RecordSetGroup': { role: 'detail', group: 'networking', absorbInto: ['AWS::CloudFront::Distribution', 'AWS::ElasticLoadBalancingV2::LoadBalancer'] },
  'AWS::Route53::HostedZone': { role: 'detail', group: 'networking', absorbInto: ['AWS::CloudFront::Distribution', 'AWS::ElasticLoadBalancingV2::LoadBalancer'] },
  'AWS::CertificateManager::Certificate': { role: 'detail', group: 'networking', absorbInto: ['AWS::CloudFront::Distribution', 'AWS::ElasticLoadBalancingV2::LoadBalancer', 'AWS::ApiGateway::RestApi'] },
};

/**
 * Suffixes used by the structural fallback heuristic (Ticket A.3) for types
 * with no {@link RULES} entry. A node is absorbed ONLY if its type's last
 * segment ends with one of these AND it has exactly one non-detail
 * neighbour AND nothing else references it. Anything else stays VISIBLE and
 * is reported via `--explain`.
 *
 * Failure policy is deliberately asymmetric: a missing rule yields a
 * slightly noisy diagram (visible, fixable); an over-eager heuristic
 * silently deletes a real component (invisible, destroys trust). Err noisy.
 *
 * Every entry must be exercised by at least one unruled type in a real
 * fixture (enforced by `__test__/rules.test.ts`) — a dead entry guards
 * nothing real and gets removed until a fixture motivates it. The spec's
 * draft listed 19 suffixes; 16 were dead against the corpus (`Permission`,
 * `Entry`, `Version`, `Alias`, `Deployment`, `Stage`, `Method`, `Model`,
 * `Record`, `Route`, `Binding`, `Membership`, `Config`, `Configuration`,
 * `Setting`, `Subscription`) because every common type with those suffixes
 * already has an explicit rule above — pruned, to be resurrected
 * individually if/when A.11's corpus growth produces an unruled type that
 * motivates one. Exercised by (at time of writing): `Policy` —
 * `AWS::Events::EventBusPolicy` (`AWS::IoT::Policy` got an explicit rule in
 * Ticket A.11); `Association` — `AWS::WAFv2::WebACLAssociation`;
 * `Attachment` — `AWS::EC2::VolumeAttachment` (the two
 * `AWS::IoT::*PrincipalAttachment` types also got explicit rules in
 * Ticket A.11).
 */
export const PLUMBING_SUFFIXES = ['Policy', 'Association', 'Attachment'];

/** Layer ordering, used only for flow-direction inference (spec §6) — never for layer *assignment*, which is rule-declared. */
export const LAYER_ORDER: Record<ArchLayer, number> = {
  edge: 0,
  presentation: 1,
  auth: 2,
  api: 3,
  compute: 4,
  integration: 5,
  data: 6,
  monitoring: 7,
  network: 8, // containers; never participates in flow ordering
  unassigned: 9,
};
