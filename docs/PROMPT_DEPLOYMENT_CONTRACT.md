# Prompt deployment contract

Existing `prompt_versions` and `agent_configurations` remain the Studio registry. Published versions are immutable, and every run freezes agent ID, version ID, body, SHA-256 prompt hash, model, workflow, configuration/tool allowlist and logical correlation. Editing another draft or client profile does not change an already queued run's dispatch snapshot.

Lifecycle metadata: `LOCAL_DRAFT`, `TEST_VERSION`, `STUDIO_PUBLISHED`, `N8N_DEPLOYMENT_PENDING`, `N8N_DEPLOYED`, `DEPLOYMENT_FAILED`, `ROLLED_BACK`. Legacy draft/published records render as Local Draft/Studio Published without destructive conversion.

`POST /api/prompts/:id/publish` only activates the Studio registry. It returns `sync=NOT_CONNECTED` and `STUDIO_PUBLISHED`. `POST /api/prompts/:id/test-version` freezes an immutable test version; conversation promptVersionId selects it without publishing the Studio registry. `POST /api/prompts/:id/deploy` requests sandbox deployment; with the default disconnected publisher it records `N8N_DEPLOYMENT_PENDING` and `WORKFLOW_NOT_DEPLOYED`, never a false deployed state. `POST /api/prompts/:id/rollback-deployment` requires an already verified deployment and publisher. All routes require Studio admin and workspace ownership; external deployment is test/sandbox only.

Server-only `PromptPublisher` contract:

```ts
metadata(workflowId) -> {workflowId, activeDeploymentId?, activeHash?}
publish({workflowId,versionId,body,expectedHash,environment})
  -> {deploymentId,readBackHash}
active(workflowId) -> {deploymentId,versionId,readBackHash}
rollback({workflowId,deploymentId,expectedHash}) -> {deploymentId,readBackHash}
```

The platform accepts deployed status only after both publish receipt and independent active-version read-back match the immutable body hash/version/deployment. Mismatch records `DEPLOYMENT_FAILED` and preserves the Studio active version. Prior deployment metadata is captured before publish; receipts remain in `integration_configuration`. Rollback also verifies active version/hash before recording `ROLLED_BACK`.

This delivery supplies the contract and a tested injectable adapter boundary, **not** an n8n administration client or a live workflow change. The next task must implement publication against the installed n8n version, explicit authorized workflow allowlist, version/idempotency checks, approval audit, and rollback semantics. A production publisher remains blocked by Studio's environment gate until a separate approved rollout design exists. n8n API keys stay in backend/n8n credential storage, not frontend state or exports. Workflow metadata must attest deployed prompt/version/hash so capability discovery cannot substitute local publication for n8n deployment.

Official n8n [save/publish workflow documentation](https://docs.n8n.io/build/understand-workflows/save-and-publish-workflows.md) distinguishes saved changes from published production execution; inspect the installed instance/API schema before implementing its publisher. The contract harness validates matching/failed read-back and rollback without editing any real workflow.
