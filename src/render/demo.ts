#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { loadTemplates } from '../parser/loader.js';
import { mergeGraphs } from '../graph/merge.js';
import { graphModelToRenderGraph } from './fromGraphModel.js';
import { writeHtml } from './build.js';

/**
 * Ticket 3.1/3.2's manual-verification entry point — `npm run render:demo`
 * writes a real, openable `index.html`. Runs a real, fairly complex,
 * multi-service set of *unmodified* example templates through the actual
 * Sprint 1 + 2 pipeline (`loadTemplates` → `mergeGraphs`) rather than a
 * hand-written synthetic graph, so what you see is the real renderer
 * exercised against real Lambda/API Gateway/DynamoDB/RDS/security-group/
 * VPC resources — not yet the full CLI (`--out`, arg parsing, surfaced
 * load/merge warnings) that's Ticket 3.4's job.
 *
 * The five files are independent of each other (no cross-stack references
 * between them) — merged purely for demo variety, the same "point
 * ArchLens at a big glob of unrelated templates" scenario
 * `graph/__test__/diverseCorpus.test.ts` already validates at much larger
 * scale.
 */
const EXAMPLE_FILES = [
  '09-sam-apigw-lambda-dynamodb/template.yaml', // API Gateway, Lambda, DynamoDB
  '14-diverse-corpus/apigateway-lambda-integration.yaml', // a second API Gateway + Lambda pattern
  '14-diverse-corpus/rds-mysql-with-read-replica.yaml', // RDS + its security group
  '14-diverse-corpus/sam-apigw-fifo-sqs-lambda-sns.yaml', // SQS/SNS + Lambda + API Gateway
  '02-complex-vpc-nat/template.yaml', // VPC networking: subnets, NAT, route tables, ACLs
].map((relativePath) => fileURLToPath(new URL(`../../examples/${relativePath}`, import.meta.url)));

const { templates, warnings: loadWarnings } = loadTemplates(EXAMPLE_FILES);
for (const warning of loadWarnings) {
  console.error(`Failed to load ${warning.file}: ${warning.message}`);
}

const graph = mergeGraphs(templates);
const renderGraph = graphModelToRenderGraph(graph);

const outPath = fileURLToPath(new URL('../../archlens-output/index.html', import.meta.url));
writeHtml(renderGraph, outPath);

console.log(`Wrote ${outPath}`);
console.log('Open it directly in a browser — disconnect from the network first to confirm nothing external is requested.');
console.log(
  `Real-fixture graph: ${templates.length} templates, ${renderGraph.nodes.length} nodes, ${renderGraph.edges.length} edges — try dragging to pan and scrolling to zoom.`,
);
