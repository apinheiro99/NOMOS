import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TaigaClient } from "./client.js";
import { addCompactParam, addFieldsParam } from "./fields.js";
import { addGovernance, loadGovernance, registerGovernanceTools } from "./governance.js";
import { identityFromEnv, type WorkflowIdentity } from "./workflow/actor.js";
import { registerWorkflowTools } from "./workflow/tools.js";
import { registerAssignmentTools } from "./workflow/assignment-tools.js";
import { registerContinuationTools } from "./workflow/continuation-tools.js";
import { loadTemplates } from "./workflow/templates.js";
import type { PolicyRuntime } from "./policy/runtime.js";

import { registerProjectTools } from "./tools/projects.js";
import { registerEpicTools } from "./tools/epics.js";
import { registerMoveTools } from "./tools/move.js";
import { registerUserStoryTools } from "./tools/userstories.js";
import { registerTaskTools } from "./tools/tasks.js";
import { registerIssueTools } from "./tools/issues.js";
import { registerMilestoneTools } from "./tools/milestones.js";
import { registerWikiTools } from "./tools/wiki.js";
import { registerMembershipTools } from "./tools/memberships.js";
import { registerRoleTools } from "./tools/roles.js";
import { registerUserTools } from "./tools/users.js";
import { registerStatusTools } from "./tools/statuses.js";
import { registerCustomAttributeTools } from "./tools/custom-attributes.js";
import { registerHistoryTools } from "./tools/history.js";
import { registerSearchTools } from "./tools/search.js";
import { registerTimelineTools } from "./tools/timeline.js";
import { registerResolverTools } from "./tools/resolver.js";
import { registerWebhookTools } from "./tools/webhooks.js";
import { registerExportImportTools } from "./tools/export-import.js";


// `identity` is resolved by the transport (HTTP bearer token) or from TAIGA_MCP_ACTOR (stdio); without either it is syntactic.
export function createTaigaMcpServer(client: TaigaClient = new TaigaClient(), identity: WorkflowIdentity = identityFromEnv(), runtime?: PolicyRuntime): McpServer {
  const server = new McpServer({
    name: "taiga-mcp",
    version: "1.0.0",
  });

  addFieldsParam(server);
  addCompactParam(server);
  loadTemplates(); // fail closed at startup on a malformed template directory
  const governance = loadGovernance();
  addGovernance(server, client, governance, identity, runtime);

  // Register all tool modules
  registerProjectTools(server, client, identity, runtime);
  registerEpicTools(server, client);
  registerMoveTools(server, client);
  registerUserStoryTools(server, client);
  registerTaskTools(server, client);
  registerIssueTools(server, client);
  registerMilestoneTools(server, client, identity);
  registerWikiTools(server, client);
  registerMembershipTools(server, client);
  registerRoleTools(server, client);
  registerUserTools(server, client);
  registerStatusTools(server, client);
  registerCustomAttributeTools(server, client);
  registerHistoryTools(server, client, identity);
  registerSearchTools(server, client);
  registerTimelineTools(server, client);
  registerResolverTools(server, client);
  registerWebhookTools(server, client);
  registerExportImportTools(server, client);
  registerGovernanceTools(server, client, governance, identity, runtime);
  registerWorkflowTools(server, client, identity, governance, runtime);
  registerContinuationTools(server, client, identity);
  registerAssignmentTools(server, client);

  return server;
}
