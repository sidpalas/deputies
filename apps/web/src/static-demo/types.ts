import type {
  AgentEvent,
  Artifact,
  CallbackDelivery,
  ExternalResource,
  Message,
  SandboxService,
  Session,
} from '../api.js';
import type { WorkspaceChangesSnapshot } from '../components/app-panels/workspace-changes-panel.js';

export type StaticDemoSession = {
  session: Session;
  messages: Message[];
  events: AgentEvent[];
  artifacts: Artifact[];
  externalResources: ExternalResource[];
  callbacks: CallbackDelivery[];
  services?: SandboxService[];
  workspaceChanges?: WorkspaceChangesSnapshot;
};

export type StaticDemoData = {
  generatedAt: string;
  sessions: StaticDemoSession[];
};
