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
  status: 'active' | 'archived';
  createdAt: string;
  archivedAt: string | null;
  lastActiveAt: string | null;
}

export interface ConversationListResponse {
  conversations: ConversationSummary[];
  availableAgentGroups: AgentGroupSummary[];
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

export interface WebEventPayload {
  eventId: string;
  cursor: string;
  type: 'conversation.message.accepted' | 'conversation.message.available';
  laneId: string;
  resourceId: string;
  createdAt: string;
}
