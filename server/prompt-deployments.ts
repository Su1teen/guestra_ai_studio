import { createHash } from "node:crypto";
import type { Database } from "./db.js";
import type { Config } from "./config.js";
import type { PromptPublisher } from "./integrations.js";
import type { Prompt, Agent } from "../shared/domain.js";
import { Repository, record } from "./repository.js";
import { ApiError, requireValue } from "./errors.js";
export class PromptDeployments {
  constructor(
    public db: Database,
    public cfg: Config,
    public publisher?: PromptPublisher,
  ) {}
  async deploy(workspace: string, versionId: string) {
    const r = new Repository(this.db, workspace),
      prompt = requireValue(await r.get<Prompt>("prompt_versions", versionId)),
      agent = requireValue(
        await r.get<Agent>("agent_configurations", prompt.agentId),
      );
    if (prompt.status !== "published")
      throw new ApiError(
        409,
        "PUBLISHED_VERSION_REQUIRED",
        "Publish immutable Studio version first",
      );
    if (
      !this.cfg.sandbox ||
      !["test", "sandbox"].includes(this.cfg.environment ?? "production")
    )
      throw new ApiError(
        403,
        "SANDBOX_REQUIRED",
        "External prompt deployment requires isolated environment",
      );
    const expectedHash = createHash("sha256").update(prompt.body).digest("hex");
    await r.patch("prompt_versions", prompt.id, {
      deploymentState: "N8N_DEPLOYMENT_PENDING",
    });
    if (!this.publisher)
      return {
        state: "N8N_DEPLOYMENT_PENDING",
        reason: "WORKFLOW_NOT_DEPLOYED",
        expectedHash,
      };
    try {
      const prior = await this.publisher.metadata(agent.workflowId);
      const receipt = await this.publisher.publish({
        workflowId: agent.workflowId,
        versionId: prompt.id,
        body: prompt.body,
        expectedHash,
        environment: this.cfg.environment!,
      });
      const active = await this.publisher.active(agent.workflowId);
      if (
        receipt.readBackHash !== expectedHash ||
        active.readBackHash !== expectedHash ||
        active.versionId !== prompt.id ||
        active.deploymentId !== receipt.deploymentId
      )
        throw new ApiError(
          409,
          "PROMPT_READBACK_MISMATCH",
          "Workflow active hash not verified",
        );
      await r.patch("prompt_versions", prompt.id, {
        deploymentState: "N8N_DEPLOYED",
        deploymentId: receipt.deploymentId,
        readBackHash: expectedHash,
      });
      await r.put("integration_configuration", {
        ...record({
          agentId: agent.id,
          versionId: prompt.id,
          workflowId: agent.workflowId,
          expectedHash,
          priorDeploymentId: prior.activeDeploymentId,
          state: "N8N_DEPLOYED",
        }),
        id: "deployment:" + receipt.deploymentId,
      });
      return {
        state: "N8N_DEPLOYED",
        deploymentId: receipt.deploymentId,
        readBackHash: expectedHash,
      };
    } catch (e) {
      await r.patch("prompt_versions", prompt.id, {
        deploymentState: "DEPLOYMENT_FAILED",
      });
      throw e instanceof ApiError
        ? e
        : new ApiError(502, "DEPLOYMENT_FAILED", "Prompt deployment failed");
    }
  }
  async rollback(workspace: string, versionId: string) {
    const r = new Repository(this.db, workspace),
      prompt = requireValue(await r.get<Prompt>("prompt_versions", versionId)),
      agent = requireValue(
        await r.get<Agent>("agent_configurations", prompt.agentId),
      );
    if (!this.publisher)
      throw new ApiError(
        503,
        "WORKFLOW_NOT_DEPLOYED",
        "Prompt publisher not connected",
      );
    if (
      !this.cfg.sandbox ||
      !["test", "sandbox"].includes(this.cfg.environment ?? "production") ||
      !prompt.deploymentId ||
      !prompt.readBackHash
    )
      throw new ApiError(
        409,
        "VERIFIED_DEPLOYMENT_REQUIRED",
        "Verified sandbox deployment required",
      );
    const receipt = await this.publisher.rollback({
      workflowId: agent.workflowId,
      deploymentId: prompt.deploymentId,
      expectedHash: prompt.readBackHash,
    });
    const active = await this.publisher.active(agent.workflowId);
    if (
      receipt.readBackHash !== prompt.readBackHash ||
      active.readBackHash !== prompt.readBackHash ||
      active.deploymentId !== receipt.deploymentId ||
      active.versionId !== prompt.id
    )
      throw new ApiError(
        409,
        "PROMPT_READBACK_MISMATCH",
        "Rollback hash not verified",
      );
    await r.patch("prompt_versions", prompt.id, {
      deploymentState: "ROLLED_BACK",
      deploymentId: receipt.deploymentId,
    });
    return { state: "ROLLED_BACK", deploymentId: receipt.deploymentId };
  }
}
