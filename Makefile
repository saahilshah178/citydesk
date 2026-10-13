# CityDesk: install, build, test, deploy and tear down.
#
# Deploy settings are read from the environment, or from .env at the repo root (see .env.example).
# Variables that are already exported win over .env.
#
#   BEDROCK_MODEL_ID   required by synth and deploy: the model or inference profile the assistant calls
#   AWS_REGION         where to deploy, default us-east-1
#   AWS credentials    any standard source: AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY, AWS_PROFILE, SSO
#
# Optional: POLLY_VOICE_ID, POLLY_ENGINE, DEMO_DAILY_REQUEST_CAP, CITYDESK_TABLE, LOCATION_PLACE_INDEX,
# BOSTON_OPEN311_API_KEY, SEECLICKFIX_API_KEY. docs/aws.md explains each service and its cost.

SHELL := /bin/bash
.DEFAULT_GOAL := help
# Targets list their steps as ordered prerequisites, so they must not run in parallel.
.NOTPARALLEL:

# Runs a command inside infra/ after loading .env and pinning AWS_REGION / AWS_DEFAULT_REGION.
IN_INFRA := cd infra && node scripts/with-env.mjs
# The infra package's own TypeScript runner and CDK CLI (dev dependencies, nothing global).
TSX := node --import tsx
CDK := node_modules/.bin/cdk
OUTPUTS := results/deploy-outputs.json
# Extra arguments for the CDK CLI, for example CDK_ARGS="-c clientDist=/some/dir".
CDK_ARGS ?=

.PHONY: help install build test synth deploy destroy check-tools check-model check-aws

help:
	@echo "CityDesk make targets"
	@echo "  make install   install workspace dependencies with pnpm"
	@echo "  make build     build every workspace package, including the web client"
	@echo "  make test      run every workspace test suite"
	@echo "  make synth     synthesize the CloudFormation template into infra/cdk.out (no AWS calls)"
	@echo "  make deploy    create SSM secrets, bootstrap CDK if needed, deploy; outputs go to $(OUTPUTS)"
	@echo "  make destroy   delete the stack and the SSM secrets created by make deploy"
	@echo ""
	@echo "synth and deploy need BEDROCK_MODEL_ID. deploy and destroy need AWS credentials."
	@echo "Region: AWS_REGION, default us-east-1. Settings may also live in .env at the repo root."

check-tools:
	@command -v node >/dev/null 2>&1 || { echo "CityDesk: node is not installed. Install Node.js 22 or newer."; exit 1; }
	@command -v pnpm >/dev/null 2>&1 || { echo "CityDesk: pnpm is not installed. Run 'corepack enable' or see https://pnpm.io/installation."; exit 1; }

install: check-tools
	pnpm install

build: install
	pnpm -r --if-present build

test: install
	pnpm -r --if-present test

# Fails with one readable sentence when BEDROCK_MODEL_ID (or another deploy setting) is missing or invalid.
check-model: install
	@$(IN_INFRA) $(TSX) scripts/preflight.ts model

# Fails with a readable message when no AWS credentials resolve. Makes one STS call.
check-aws: install
	@$(IN_INFRA) $(TSX) scripts/preflight.ts aws

synth: install check-model build
	$(IN_INFRA) $(CDK) synth --quiet $(CDK_ARGS)
	@echo "Template: infra/cdk.out/CityDesk.template.json"

deploy: install check-model check-aws build
	$(IN_INFRA) $(TSX) scripts/ensure-params.ts
	$(IN_INFRA) $(TSX) scripts/bootstrap.ts
	@mkdir -p $(dir $(OUTPUTS))
	$(IN_INFRA) $(CDK) deploy --require-approval never --outputs-file ../$(OUTPUTS) $(CDK_ARGS)
	@echo "Stack outputs written to $(OUTPUTS)"

# Tears down from the assembly the last synth or deploy left in infra/cdk.out when there is one, so
# neither BEDROCK_MODEL_ID nor a fresh build is needed just to delete things. Without it the app has
# to be synthesized again, which needs both.
#
# This recipe must never contain $(MAKE): make runs any recipe line that mentions it even under
# `make -n`, and the line would take the real `cdk destroy` with it.
destroy: install check-aws
	@if [ -f infra/cdk.out/manifest.json ]; then \
		echo "Destroying the stack recorded in infra/cdk.out"; \
		( $(IN_INFRA) $(CDK) destroy --force --app cdk.out ); \
	else \
		echo "No assembly in infra/cdk.out: checking settings and building so the app can be synthesized"; \
		( $(IN_INFRA) $(TSX) scripts/preflight.ts model ) \
			&& pnpm -r --if-present build \
			&& ( $(IN_INFRA) $(CDK) destroy --force $(CDK_ARGS) ); \
	fi
	$(IN_INFRA) $(TSX) scripts/delete-params.ts
	@echo "Done. The CDK bootstrap stack (CDKToolkit) is left in place; see docs/aws.md to remove it."
