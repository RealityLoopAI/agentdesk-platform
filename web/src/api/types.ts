export interface PublicBranding {
  displayName: string;
  logoPath: string;
  theme: {
    brandPrimary: string;
    brandPrimaryHover: string;
    brandPrimaryActive: string;
    brandSurfaceSubtle: string;
    brandBorder: string;
    canvas: string;
    surface: string;
    border: string;
    textPrimary: string;
    textSecondary: string;
    statusSuccess: string;
    statusWarning: string;
    statusDanger: string;
  };
}

export interface CurrentUser {
  id: string;
  kind: string;
  displayName: string | null;
}

export interface MeResponse {
  user: CurrentUser;
  csrfToken: string;
  sessionExpiresAt: string;
}

export interface AgentGroupSummary {
  id: string;
  name: string;
}

export interface ConversationSummary {
  id: string;
  agentGroup: AgentGroupSummary;
  sourceChannel: string;
  status: 'active' | 'archived';
  createdAt: string;
  archivedAt: string | null;
  lastActiveAt: string | null;
}

export interface ConversationListResponse {
  conversations: ConversationSummary[];
  availableAgentGroups: AgentGroupSummary[];
}

export interface ConversationReconciliationResponse {
  scanned: number;
  linked: number;
  existing: number;
  dryRunEligible: number;
  skippedUnauthorized: number;
  skippedMode: number;
  conflicts: number;
  hasMore: boolean;
  nextCursor: string | null;
}

export interface HistoryMessage {
  id: string;
  sequence: number | null;
  direction: 'user' | 'agent';
  kind: string;
  timestamp: string;
  text: string;
  channel: {
    type: string | null;
    platformId: string | null;
    threadId: string | null;
  };
  status: string;
  presentation?: {
    type: 'ask-question';
    mode: 'read-only';
    title: string;
    question: string;
    options: Array<{
      label: string;
      selected: boolean;
    }>;
    state: 'awaiting-external-response' | 'answered' | 'cancelled' | 'closed';
    selectedLabel: string | null;
    responseChannel: string | null;
  };
}

export interface ConversationHistoryResponse {
  messages: HistoryMessage[];
  nextCursor: string | null;
}

export interface SubmittedMessage {
  clientMessageId: string;
  messageId: string;
  status: 'pending' | 'accepted' | 'failed';
  replayed: boolean;
}

export interface DeliverySubscriptionState {
  channel: 'feishu';
  deliveryKind: 'agent-reply-mirror';
  enabled: boolean;
  available: boolean;
}

export interface GatewayConfirmation {
  id: string;
  kind: 'update' | 'create' | 'delete';
  title: string;
  display: Record<string, unknown>;
  expiresAt: string;
  status: 'pending';
}

export interface GatewayConfirmationListResponse {
  confirmations: GatewayConfirmation[];
}

export interface ResolvedGatewayConfirmation {
  id: string;
  status: 'approved' | 'rejected' | 'expired' | 'failed';
  errorCode: string | null;
}

export interface WebEventPayload {
  eventId: string;
  cursor: string;
  type:
    | 'conversation.message.accepted'
    | 'conversation.message.available'
    | 'conversation.confirmation.available'
    | 'conversation.confirmation.resolved';
  laneId: string;
  resourceId: string;
  createdAt: string;
}
